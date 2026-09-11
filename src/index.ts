import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Twilio from "twilio";
import { getScenario, SCENARIOS, renderInstructions, CallContext, getVoiceForScenario, DEFAULT_VOICE } from "./scenarios";
import { TwilioMediaStreamWebsocket } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ========================================
// Configuration
// ========================================
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const API_URL = process.env.API_URL || "wss://api.x.ai/v1/realtime";
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false";
const HOSTNAME = (process.env.HOSTNAME || "").replace(/^https?:\/\//, "");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || "";
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const HANDOFF_PHONE = process.env.HANDOFF_PHONE || "";

const twilioClient = Twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
  accountSid: TWILIO_ACCOUNT_SID,
});

// ========================================
// Grok TTS — flagship voices, replaces Amazon Polly entirely.
// Returns raw MP3 bytes for the given text + voice.
// ========================================
async function grokTTS(text: string, voice: string = DEFAULT_VOICE): Promise<Buffer> {
  const resp = await fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: text,
      voice_id: voice,
      language: "en",
      response_format: "mp3",
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`xAI TTS ${resp.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 500) {
    throw new Error(`xAI TTS returned suspiciously small audio (${buf.length} bytes)`);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Phrase cache — fixed server prompts (greetings, handoff lines) get
// synthesized once with a Grok voice and replayed as <Play>. This is what
// replaced Amazon Polly, which was the source of the "robot" sound.
// ---------------------------------------------------------------------------
const PHRASE_DIR = os.tmpdir();
const phraseFiles: Record<string, string> = {};

function phraseKey(text: string, voice: string): string {
  return crypto.createHash("sha1").update(`${voice}|${text}`).digest("hex").slice(0, 16);
}

function phraseFilename(text: string, voice: string = DEFAULT_VOICE): string {
  return `phrase_${phraseKey(text, voice)}.mp3`;
}

/** Synthesize (once) and return the on-disk filename for a fixed phrase. */
async function warmPhrase(text: string, voice: string = DEFAULT_VOICE): Promise<string> {
  const fname = phraseFilename(text, voice);
  if (phraseFiles[fname]) return fname;
  const full = path.join(PHRASE_DIR, fname);
  if (!fs.existsSync(full)) {
    const audio = await grokTTS(text, voice);
    fs.writeFileSync(full, audio);
    console.log(`[PHRASE] synthesized "${text.slice(0, 40)}..." (${audio.length}b)`);
  }
  phraseFiles[fname] = fname;
  return fname;
}

/** Absolute URL for a cached phrase, for use inside TwiML <Play>. */
function phraseUrl(fname: string): string {
  const host = HOSTNAME || "localhost";
  return `https://${host}/audio/${fname}`;
}

/** TwiML <Play> tag for a fixed phrase. Falls back to <Say> if synthesis fails. */
async function playPhrase(text: string, voice: string = DEFAULT_VOICE): Promise<string> {
  try {
    const fname = await warmPhrase(text, voice);
    return `<Play>${phraseUrl(fname)}</Play>`;
  } catch (e: any) {
    console.log(`[PHRASE] fallback to <Say> for "${text.slice(0, 30)}": ${e.message}`);
    return `<Say voice="Polly.Joanna">${text}</Say>`;
  }
}

// Steven's phone numbers
const STEVEN_NUMBERS = ["+15613012117", "+15615041239", "+15616285628"];

// Call log: track numbers we've called so inbound calls can be matched
const callLog: Record<string, { lastCallAt: string; scenario: string; context: any; attempts: number }> = {};

function logCall(number: string, scenario: string, ctx: any) {
  const normalized = number.replace(/\D/g, "");
  callLog[normalized] = {
    lastCallAt: new Date().toISOString(),
    scenario: scenario,
    context: ctx,
    attempts: (callLog[normalized]?.attempts || 0) + 1,
  };
  // Persist to file for debugging
  const fs = require("fs");
  try {
    fs.writeFileSync("C:/Users/steve/AppData/Local/Temp/grok_call_log.json", JSON.stringify(callLog, null, 2));
  } catch (_) {}
}

function findCaller(normalizedNumber: string): { name: string; lastCallAt: string; scenario: string; context: any } | null {
  const n = normalizedNumber.replace(/\D/g, "");
  const entry = callLog[n];
  if (!entry) return null;
  const ctx = entry.context || {};
  return {
    name: ctx.fullName || ctx.name || "caller",
    lastCallAt: entry.lastCallAt,
    scenario: entry.scenario,
    context: ctx,
  };
}

// ========================================
// Tool Definitions - handoff to human
// ========================================
const tools = [
  {
    type: "function",
    name: "handoff_to_human",
    description:
      "Transfer the call to a live human supervisor. Use this when the person on the line is getting frustrated, asks to speak with a manager or a real person, demands to know who you are, refuses to cooperate, or the situation requires a human. This bridges the call directly to the human supervisor.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason why the handoff is needed",
        },
      },
      required: ["reason"],
    },
  },
  {
    type: "function",
    name: "log_outcome",
    description:
      "Call this near the end of the call to record what the bot learned (e.g. balance, bill paid, check not cashed, needed human handoff).",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Outcome status summary" },
        detail: { type: "string", description: "Extra detail such as an amount or date" },
      },
      required: ["status"],
    },
  },
];

// Track active streams: callId -> { twilio streamSid, twilio ws, xai ws, callSid, to }
const activeStreams: Record<string, any> = {};

// Handoff state
const pendingHandoffs: Record<string, { callSid: string; reason: string; remoteNumber: string }> = {};

// Store the public HTTPS base URL for handoff redirects
let serverBaseUrl = "";

// ========================================
// Tool Handlers
// ========================================
async function handleToolCall(callId: string, name: string, args: Record<string, any>): Promise<string> {
  const stream = activeStreams[callId];
  switch (name) {
    case "log_outcome": {
      const status = args.status || "unknown";
      const detail = args.detail || "";
      console.log(`[${callId}] OUTCOME: ${status} ${detail ? "- " + detail : ""}`);
      return JSON.stringify({ success: true, logged: true });
    }

    case "handoff_to_human": {
      const reason = args.reason || "Human requested";
      console.log(`[${callId}] === HANDOFF REQUESTED: ${reason} ===`);
      if (!stream || !stream.callSid) {
        console.log(`[${callId}] No callSid for handoff, skipping.`);
        return JSON.stringify({ success: false, message: "No active call to hand off." });
      }

      const twilioCallSid = stream.callSid;
      const remoteNumber = stream.to || "unknown";

      // Store handoff pending
      pendingHandoffs[callId] = { callSid: twilioCallSid, reason, remoteNumber };

      // Redirect the active call to our handoff TwiML endpoint
      // This replaces the Grok stream with a <Dial> to Steven
      const handoffUrl = `${serverBaseUrl}/handoff-twiml/${callId}?reason=${encodeURIComponent(reason)}`;
      try {
        const updateResult = await twilioClient.calls(twilioCallSid).update({
          method: "POST",
          url: handoffUrl,
        });
        console.log(`[${callId}] Call redirecting to handoff: ${updateResult.status}`);
        return JSON.stringify({
          success: true,
          instruction: "Tell the remote person: 'Let me connect you with someone who can help further. One moment please.' Then wait.",
          action_taken: "redirecting to handoff",
        });
      } catch (err: any) {
        console.error(`[${callId}] Handoff redirect failed:`, err?.message);
        return JSON.stringify({ success: false, message: `Redirect failed: ${err?.message}` });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ========================================
// Health Check
// ========================================
app.get("/health", (req, res) => {
  const scenarioList = Object.keys(SCENARIOS);
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    scenarios: scenarioList,
    grok_voice: true,
  });
});

// ========================================
// GROK TTS — synthesize scripted audio with a flagship Grok voice (replaces Polly)
// ========================================
const AUDIO_DIR = os.tmpdir();
app.use("/audio", express.static(AUDIO_DIR));

app.post("/tts", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const voice = String(req.body.voice || DEFAULT_VOICE);
    if (!text) return res.status(400).json({ error: "text required" });

    const audio = await grokTTS(text, voice);
    const fname = `grok_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.mp3`;
    fs.writeFileSync(require("path").join(AUDIO_DIR, fname), audio);

    const proto = "https";
    const base = `${proto}://${req.get("host")}`;
    console.log(`[TTS] ${voice} -> ${fname} (${audio.length} bytes)`);
    return res.json({ url: `${base}/audio/${fname}`, voice, bytes: audio.length });
  } catch (e: any) {
    console.log(`[TTS] error: ${e.message}`);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// TwiML that plays a Grok-voiced script — for one-shot / voicemail calls.
// POST { text, voice?, thenRecord? } -> TwiML <Play>
app.post("/say-twiml", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const voice = String(req.body.voice || DEFAULT_VOICE);
    if (!text) {
      return res.status(400).type("text/xml").end(`<Response><Say>No text provided.</Say></Response>`);
    }
    const audio = await grokTTS(text, voice);
    const fname = `grok_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.mp3`;
    fs.writeFileSync(require("path").join(AUDIO_DIR, fname), audio);
    const url = `https://${req.get("host")}/audio/${fname}`;
    console.log(`[SAY-TWIML] ${voice} -> ${url}`);
    res.status(200).type("text/xml");
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Play>${url}</Play></Response>`);
  } catch (e: any) {
    console.log(`[SAY-TWIML] error: ${e.message}`);
    res.status(500).type("text/xml");
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong.</Say></Response>`);
  }
});

// ========================================
// Twilio Voice Webhook - inbound (not primary use case here)
// ========================================
app.post("/twiml", (req, res) => {
  res.status(200);
  res.type("text/xml");
  res.end(`<Response><Say>Hello.</Say></Response>`);
});

// ========================================
// INBOUND SMS — receives texts to our Twilio number
// ========================================
app.post("/inbound-sms", (req, res) => {
  const from = (req.body.From || "").trim();
  const body = (req.body.Body || "").trim();
  const fromNormalized = from.replace(/\D/g, "");

  const isSteven = STEVEN_NUMBERS.some(n => n.replace(/\D/g, "") === fromNormalized);
  const caller = findCaller(fromNormalized);

  console.log(`\n[SMS] From: ${from} | Steven: ${isSteven} | Body: ${body}`);
  if (caller) console.log(`[SMS] Matched caller: ${caller.name} (${caller.scenario}, last called ${caller.lastCallAt})`);

  // Write SMS to log file
  const fs = require("fs");
  fs.appendFileSync("/tmp/inbound_sms.log",
    `${new Date().toISOString()} | FROM: ${from} | STEVEN: ${isSteven} | ${caller ? "KNOWN: " + caller.name : "UNKNOWN"} | ${body}\n`);

  // Reply to Steven with confirmation; ignore others
  let reply = "";
  if (isSteven) {
    reply = "Got it, Steven. I'll route this to the fleet.";
    console.log(`[SMS] Replying to Steven: "${reply}"`);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${reply}</Message>` : ""}</Response>`;
  res.status(200);
  res.type("text/xml");
  res.end(twiml);
});

// ========================================
// INBOUND VOICE — someone is calling our Twilio number
// ========================================
app.post("/inbound-voice", async (req, res) => {
  const from = (req.body.From || "").trim();
  const callSid = (req.body.CallSid || "").trim();
  const fromNormalized = from.replace(/\D/g, "");
  const isSteven = STEVEN_NUMBERS.some(n => n.replace(/\D/g, "") === fromNormalized);
  const caller = findCaller(fromNormalized);

  console.log(`\n[INBOUND CALL] From: ${from} | Steven: ${isSteven} | CallSid: ${callSid}`);
  if (caller) console.log(`[INBOUND CALL] Matched: ${caller.name} (scenario: ${caller.scenario})`);

  const callId = `inbound_${crypto.randomBytes(6).toString('hex')}`;

  if (isSteven) {
    // Steven called — play a brief greeting and record any instructions
    const greeting = await playPhrase("Hey Steven. I'm listening — what do you need?");
    const closing = await playPhrase("Got it. I'll take care of it. Talk soon.");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greeting}
  <Record maxLength="120" transcribe="true" timeout="15" finishOnKey="#"
    action="/inbound-recording?callId=${callId}&from=${encodeURIComponent(from)}"
    transcribeCallback="/inbound-transcription?callId=${callId}&from=${encodeURIComponent(from)}"/>
  ${closing}
</Response>`;
    res.status(200);
    res.type("text/xml");
    res.end(twiml);
    return;
  }

  // Someone else calling — use Grok Voice to handle it
  // If it's a known caller we've contacted, the bot knows the context
  let instructions = `You are answering an inbound call to the 723 Studios verification line. Be friendly, professional, and ask how you can help.`;
  if (caller) {
    const ctx = caller.context || {};
    instructions = `You are answering a callback from ${caller.name}. We previously called them about: ${caller.scenario}. Context: ${JSON.stringify(ctx)}. They may be returning our call with information. Be friendly and take down what they say.`;
    console.log(`[INBOUND CALL] Using matched caller context: ${caller.name}`);
  }

  if (!HOSTNAME) {
    const hello = await playPhrase("Hello, you've reached 723 Studios. How can I help you?");
    const bye = await playPhrase("Thank you, goodbye.");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${hello}
  <Record maxLength="120" transcribe="true" timeout="30" finishOnKey="#"/>
  ${bye}
</Response>`;
    res.status(200);
    res.type("text/xml");
    res.end(twiml);
    return;
  }

  const instructionsEncoded = encodeURIComponent(instructions);
  const streamUrl = `wss://${HOSTNAME}/media-stream/${callId}?scenario=balance_check&instructions=${instructionsEncoded}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
  res.status(200);
  res.type("text/xml");
  res.end(twiml);
});

// Inbound recording callback
app.post("/inbound-recording", (req, res) => {
  const callId = req.query.callId as string;
  const recordingUrl = req.body.RecordingUrl || "";
  console.log(`[${callId}] Recording: ${recordingUrl}`);
  res.status(200).send();
});

// Inbound transcription callback
app.post("/inbound-transcription", (req, res) => {
  const callId = req.query.callId as string;
  const text = (req.body.TranscriptionText || "").trim();
  const from = (req.query.from as string) || "unknown";
  console.log(`[${callId}] Transcription from ${from}: "${text}"`);
  if (text) {
    const fs = require("fs");
    fs.appendFileSync("C:/Users/steve/AppData/Local/Temp/inbound_steven_instructions.log",
      `${new Date().toISOString()} | ${text}\n`);
  }
  res.status(200).send();
});

// ========================================
// MAIN: Outbound AI Call Entry Point
// ========================================
// POST /start-call  { to, scenario, from? }
// This:
//  1. Makes a Twilio outbound call that points at /conn (TwiML)
//  2. Twilio connects <Stream> to /media-stream/:callId
//  3. Our /media-stream WebSocket bridges audio to xAI Grok Voice
app.post("/start-call", async (req, res) => {
  const { to, scenario, from, context } = req.body || {};
  if (!to) return res.status(400).json({ error: "Missing 'to' (target phone number)" });
  if (!scenario) return res.status(400).json({ error: "Missing 'scenario'" });
  if (!SCENARIOS[scenario]) return res.status(400).json({ error: `Unknown scenario '${scenario}'` });

  if (!HOSTNAME) {
    return res.status(500).json({ error: "HOSTNAME not set - start a cloudflared tunnel and set HOSTNAME." });
  }

  const callId = `call_${crypto.randomBytes(6).toString('hex')}`;
  const target = to.startsWith("+") ? to : `+${to.replace(/\D/g, "")}`;
  const fromNumber = (from || TWILIO_PHONE_NUMBER || "").replace(/^tel:/, "");

  const ctx = context || {};
  if (!ctx.name) ctx.name = "Steven";

  // Build the stream URL with context info
  const proto = "https";
  const ctxEncoded = encodeURIComponent(JSON.stringify(ctx));
  const streamUrl = `wss://${HOSTNAME}/media-stream/${callId}?scenario=${encodeURIComponent(scenario)}&ctx=${ctxEncoded}`;
  // Phase 1: simple Say to confirm Twilio reaches us
  // Phase 2: redirect to stream via /connect endpoint
  const connectUrl = `${proto}://${req.get("host")}/connect-stream/${callId}?scenario=${encodeURIComponent(scenario)}&ctx=${ctxEncoded}`;
  const waitMsg = await playPhrase("One moment, connecting you now.");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${waitMsg}
  <Pause length="2"/>
  <Redirect method="POST">${connectUrl}</Redirect>
</Response>`;
  console.log(`[${callId}] Embedded TwiML stream: ${streamUrl}`);

  try {
    const call = await twilioClient.calls.create({
      to: target,
      from: fromNumber,
      twiml: twiml,
      statusCallback: `${proto}://${req.get("host")}/call-status?callId=${callId}`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    return res.json({ status: "initiated", callId, twilio_sid: call.sid, scenario, context: ctx });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message || e) });
  }

  // Track the outbound call for inbound matching
  logCall(target, scenario, ctx);
});
// ========================================
app.post("/conn", (req, res) => {
  const scenario = (req.query.scenario as string) || "balance_check";
  const callId = (req.query.callId as string) || `call_${crypto.randomBytes(6).toString('hex')}`;
  const ctxRaw = (req.query.ctx as string) || "{}";
  if (!HOSTNAME) {
    res.status(500).send("HOSTNAME not set");
    return;
  }

  res.status(200);
  res.type("text/xml");
  const streamUrl = `wss://${HOSTNAME}/media-stream/${callId}?scenario=${encodeURIComponent(scenario)}&ctx=${encodeURIComponent(ctxRaw)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
  res.end(twiml);
});

// Second-stage redirect: /connect-stream returns the actual <Connect><Stream>
app.post("/connect-stream/:callId", (req, res) => {
  const callId = req.params.callId;
  const scenario = (req.query.scenario as string) || "balance_check";
  const ctxRaw = (req.query.ctx as string) || "{}";
  if (!HOSTNAME) {
    res.status(500).send("HOSTNAME not set");
    return;
  }

  res.status(200);
  res.type("text/xml");
  const streamUrl = `wss://${HOSTNAME}/media-stream/${callId}?scenario=${encodeURIComponent(scenario)}&ctx=${encodeURIComponent(ctxRaw)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
  res.end(twiml);
});

// ========================================
// Media Stream WebSocket - bridges audio between Twilio and Grok Voice
// ========================================
app.ws("/media-stream/:callId", (ws, req) => {
  const callId = String(req.params.callId || "");
  const scenarioQuery = Array.isArray(req.query.scenario) ? req.query.scenario[0] : req.query.scenario;
  const scenarioName = String(scenarioQuery || "balance_check");
  const ctxRaw = Array.isArray(req.query.ctx) ? req.query.ctx[0] : req.query.ctx;
  let ctx: CallContext = { name: "Steven" };
  if (ctxRaw) {
    try {
      ctx = JSON.parse(String(ctxRaw));
    } catch (_e) {
      console.log(`[${callId}] Failed to parse ctx, using default`);
    }
  }
  if (!ctx.name) ctx.name = "Steven";

  // Custom instructions override — passed as query param for inbound calls
  const instructionsOverride = Array.isArray(req.query.instructions) ? req.query.instructions[0] : req.query.instructions;
  const instructions = instructionsOverride
    ? decodeURIComponent(String(instructionsOverride))
    : renderInstructions(scenarioName, ctx);
  console.log(`\n[${callId}] === CALL STARTED (scenario: ${scenarioName}, voice: ${getVoiceForScenario(scenarioName)}) ===`);
  console.log(`[${callId}] Context: ${JSON.stringify(ctx)}${instructionsOverride ? " [custom instructions]" : ""}`);

  const tw = new TwilioMediaStreamWebsocket(ws);

  // Track callSid once stream starts
  let streamSid = "";
  let callSid = "";
  let xaiWs: any = null;
  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false;

  const WebSocket = require("ws");

  tw.on("start", (msg) => {
    streamSid = msg.start.streamSid;
    callSid = msg.start.callSid;
    console.log(`[${callId}] twilio.start streamSid=${streamSid} `);

    // Track for handoff
    activeStreams[callId] = { streamSid, callSid, to: "", tw, xaiWs: null };

    // Connect to Grok Voice
    xaiWs = new WebSocket(API_URL, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    xaiWs.on("open", () => {
      console.log(`[${callId}] grok-voice websocket.open`);

      // Send session config with scenario instructions + tools
      const sessionConfig = {
        type: "session.update",
        session: {
          instructions: instructions,
          voice: getVoiceForScenario(scenarioName),
          audio: {
            input: { format: { type: "audio/pcmu" } },
            output: { format: { type: "audio/pcmu" } },
          },
          turn_detection: { type: "server_vad" },
          ...(ENABLE_TOOLS ? { tools } : {}),
        },
      };
      console.log(`[${callId}] session.update (voice=${getVoiceForScenario(scenarioName)})`);
      xaiWs.send(JSON.stringify(sessionConfig));
    });

    xaiWs.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        // Log select events
        if (
          ["response.output_audio.delta", "response.output_audio_transcript.delta", "input_audio_buffer.append"].includes(message.type) === false
        ) {
          console.log(`[${callId}] ${message.type}`);
        }

        if (message.type === "response.output_audio.delta" && message.delta) {
          // Bot audio -> Twilio
          tw.send({ event: "media", media: { payload: message.delta }, streamSid });
        } else if (message.type === "session.updated") {
          sessionReady = true;
          // Kick off the bot to speak first for outbound calls
          const convItem = {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "(Outbound call started. You are calling to complete the scenario. Begin the conversation.)" }],
            },
          };
          xaiWs.send(JSON.stringify(convItem));
          xaiWs.send(JSON.stringify({ type: "response.create" }));
        } else if (message.type === "response.created") {
          if (turnActive) {
            console.log(`[${callId}] === TURN ${turnCount} INTERRUPTED ===`);
          }
          turnCount++;
          turnActive = true;
          console.log(`\n[${callId}] === START TURN ${turnCount} ===`);
        } else if (message.type === "response.done") {
          turnActive = false;
          console.log(`[${callId}] === END TURN ${turnCount} ===`);
        } else if (message.type === "response.output_audio_transcript.delta" && message.delta) {
          console.log(`[${callId}] Bot: "${message.delta}"`);
        } else if (message.type === "conversation.item.input_audio_transcription.completed") {
          if (message.transcript) {
            console.log(`[${callId}] Remote: "${message.transcript}"`);
          }
        } else if (message.type === "input_audio_buffer.speech_started") {
          // Interrupt bot audio
          tw.send({ event: "clear", streamSid });
        } else if (message.type === "response.output_item.done") {
          // Handle function call
          if (message.item?.type === "function_call") {
            (async () => {
              const fnName = message.item.name;
              const fnCallId = message.item.call_id;
              let args: any = {};
              try {
                args = JSON.parse(message.item.arguments || "{}");
              } catch (e) {}
              console.log(`[${callId}] TOOL CALL: ${fnName}(${JSON.stringify(args)})`);
              const result = await handleToolCall(callId, fnName, args);
              console.log(`[${callId}] TOOL RESULT: ${result}`);
              xaiWs.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: { type: "function_call_output", call_id: fnCallId, output: result },
                })
              );
              xaiWs.send(JSON.stringify({ type: "response.create" }));
            })();
          }
        } else if (message.type === "error") {
          console.log(`[${callId}] ERROR: ${message.error?.message || JSON.stringify(message)}`);
        }
      } catch (err) {
        console.error(`[${callId}] msg parse error:`, err);
      }
    });

    xaiWs.on("error", (err: any) => console.error(`[${callId}] grok ws error:`, err?.message));
    xaiWs.on("close", () => console.log(`[${callId}] grok ws closed`));
  });

  // Human speech -> Grok
  tw.on("media", (msg) => {
    if (!sessionReady || !xaiWs || xaiWs.readyState !== 1) return;
    if (msg.media.track !== "inbound") return;
    xaiWs.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload,
      })
    );
  });

  // Cleanup
  ws.on("close", () => {
    console.log(`[${callId}] call ended`);
    if (xaiWs) xaiWs.close();
    delete activeStreams[callId];
  });

  ws.on("error", (err: any) => console.error(`[${callId}] twilio ws error:`, err?.message));
});

// ========================================
// Call status callback
// ========================================
app.post("/call-status", (req, res) => {
  res.status(200).send();
});

// ========================================
// Handoff TwiML — redirects an active call to Steven's phone
// ========================================
app.post("/handoff-twiml/:callId", async (req, res) => {
  const callId = req.params.callId;
  const reason = (req.query.reason as string) || "the caller needs human assistance";
  const h = pendingHandoffs[callId];

  console.log(`[${callId}] === HANDSET HANDOFF: ${reason} ===`);
  if (h) console.log(`  Remote: ${h.remoteNumber}, CallSid: ${h.callSid}`);

  const holdMsg = await playPhrase("Sure, let me get someone on the line for you — one second.");
  const noAnswer = await playPhrase("Sorry, nobody's picking up right now. I'll have someone call you back shortly. Thanks for your patience.");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${holdMsg}
  <Dial timeout="30" callerId="${TWILIO_PHONE_NUMBER}">
    <Number>${HANDOFF_PHONE}</Number>
  </Dial>
  ${noAnswer}
</Response>`;
  res.status(200);
  res.type("text/xml");
  res.end(twiml);
});

// ========================================
// Start the server
// ========================================
// Start the server on a free port
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

(async () => {
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : await findFreePort();
  app.listen(PORT, () => {
      console.log(`\n[Grok Voice Verification Bot]`);
      console.log(`  Port: ${PORT}`);
      console.log(`  Available scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
      if (HOSTNAME) {
        console.log(`  Public HOSTNAME: ${HOSTNAME}`);
        serverBaseUrl = `https://${HOSTNAME}`;
      } else {
        serverBaseUrl = `http://localhost:${PORT}`;
        console.log("  HOSTNAME not set - start cloudflared tunnel and set HOSTNAME.");
      }
      console.log(`  Handoff phone: ${HANDOFF_PHONE || "not set"}`);
      console.log("");
  });
})();