import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import Twilio from "twilio";
import { getScenario, SCENARIOS, renderInstructions, CallContext } from "./scenarios";
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

// Track active streams: callId -> { twilio streamSid, twilio ws, xai ws, callSid }
const activeStreams: Record<string, any> = {};

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

      // Tell Grok to inform the remote party a transfer is happening
      return JSON.stringify({
        success: true,
        instruction:
          "Warm transfer: tell the remote person 'One moment please, let me connect you with my supervisor who can assist further.' Then hand control to the human. Do not hang up on the remote person.",
        transfer_phone: HANDOFF_PHONE,
      });
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
// Twilio Voice Webhook - inbound (not primary use case here)
// ========================================
app.post("/twiml", (req, res) => {
  res.status(200);
  res.type("text/xml");
  res.end(`<Response><Say>Hello.</Say></Response>`);
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
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connection in progress, one moment please.</Say>
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
});

// ========================================
// Twilio TwiML endpoint — called when Twilio initiates the outbound call
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
  const scenario = getScenario(scenarioName);

  const instructions = renderInstructions(scenarioName, ctx);
  console.log(`\n[${callId}] === CALL STARTED (scenario: ${scenario.name}, voice: ${scenario.voice}) ===`);
  console.log(`[${callId}] Context: ${JSON.stringify(ctx)}`);

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
          voice: scenario.voice,
          audio: {
            input: { format: { type: "audio/pcmu" } },
            output: { format: { type: "audio/pcmu" } },
          },
          turn_detection: { type: "server_vad" },
          ...(ENABLE_TOOLS ? { tools } : {}),
        },
      };
      console.log(`[${callId}] session.update (voice=${scenario.voice})`);
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
    } else {
      console.log("  HOSTNAME not set - set HOSTNAME env var on Coolify.");
    }
    console.log("");
  });
})();