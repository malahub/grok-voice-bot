# Security model

This service can originate **real outbound phone calls** (Twilio) and bridge them to a
paid speech-to-speech model, so every entry point is authenticated. Changes here are
deliberately fail-closed.

## Required environment variables

| Variable | Purpose | Behaviour if missing |
| --- | --- | --- |
| `VOICE_BOT_API_KEY` | Shared secret callers must present on `POST /start-call` | **Process refuses to start** (exit 1) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token, used to verify `X-Twilio-Signature` on callbacks | **Process refuses to start** (exit 1) |
| `START_CALL_RATE_MAX` | Max authenticated `/start-call` requests per window (default `5`) | optional |
| `START_CALL_RATE_WINDOW_MS` | Rate-limit window in ms (default `60000`) | optional |
| `STREAM_SESSION_TTL_MS` | Lifetime of a media-stream token (default `7200000` = 2h) | optional |
| `HOSTNAME` | Public hostname Twilio reaches us on; also used to rebuild the signed URL | still required for calls |

## What a legitimate caller must send

**Originating a call** (`POST /start-call`) — one of:

```
Authorization: Bearer $VOICE_BOT_API_KEY
X-API-Key: $VOICE_BOT_API_KEY
```

Unauthenticated or wrong-key requests get `401`. Authenticated requests are rate limited
per API key **and** per source IP (`429` with `Retry-After` once the window is exhausted).

**Twilio callbacks** (`/twiml`, `/inbound-sms`, `/inbound-voice`, `/inbound-recording`,
`/inbound-transcription`, `/conn`, `/connect-stream/:callId`, `/call-status`,
`/handoff-twiml/:callId`) must carry a valid `X-Twilio-Signature` — HMAC-SHA1, base64, over
the public URL plus the sorted POST params, using `TWILIO_AUTH_TOKEN`. Invalid or missing
signatures get `403`. Twilio does this automatically; nothing to configure as long as
`TWILIO_AUTH_TOKEN` matches the account.

**Media stream websocket** (`wss://…/media-stream/:callId`): the token is minted by the
server and embedded in the `<Stream url="…">` TwiML — Twilio passes it back on connect. The
scenario, context and system instructions are held **server-side only**; query parameters
are no longer trusted for any of them, so a stranger cannot drive the voice agent.

## Residual / known gaps

- `/tts` and `/say-twiml` are still unauthenticated (they synthesise paid xAI TTS audio but
  cannot originate a call). Worth gating behind `VOICE_BOT_API_KEY` in a follow-up.
- Rate limits and stream sessions are in-memory: they reset on restart and are per-process,
  so they do not cover a multi-replica deployment.
