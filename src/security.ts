/**
 * security.ts — auth primitives for the Grok Voice Verification Bot.
 *
 * Threat model this file closes:
 *   1. POST /start-call was open to the internet and originates REAL outbound
 *      Twilio calls (toll fraud).  -> requireApiKey
 *   2. Twilio-facing webhooks were unauthenticated, so anyone could POST forged
 *      call metadata / redirects.  -> validateTwilioSignature (HMAC-SHA1, native crypto)
 *   3. The media-stream websocket was open and took its scenario/instructions
 *      from query params, letting a stranger drive the voice agent.
 *      -> randomToken + timingSafeStringEquals (per-call session token)
 *   4. A leaked key could blast calls -> rateLimitStartCall
 *
 * No new dependencies: everything below uses node's built-in `crypto`.
 */
import * as crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Fail-closed configuration.
// These are evaluated at import time on purpose: if a secret is missing the
// process must die, never boot with the protection silently disabled.
// ---------------------------------------------------------------------------
function requireSecret(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(
      `[FATAL] ${name} is not set. Refusing to start: the voice bot will not run ` +
        `without it (fail-closed). Set it in the environment (e.g. Coolify env vars / .env) and retry.`
    );
    process.exit(1);
  }
  return v;
}

/** Shared secret callers must present on POST /start-call. Never logged. */
const API_KEY = requireSecret("VOICE_BOT_API_KEY");
/** Twilio Auth Token used to verify X-Twilio-Signature. Never logged. */
const TWILIO_AUTH_TOKEN = requireSecret("TWILIO_AUTH_TOKEN");

/** Public hostname Twilio reaches us on (used to rebuild the signed URL). */
const PUBLIC_HOSTNAME = (process.env.HOSTNAME || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();

/** Max /start-call requests allowed per key and per IP inside the window. */
const RATE_WINDOW_MS = Number(process.env.START_CALL_RATE_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.START_CALL_RATE_MAX || 5);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Constant-time string comparison (used for API keys and stream tokens). */
export function timingSafeStringEquals(a: string, b: string): boolean {
  return safeEqual(a, b);
}

/** Cryptographically random URL-safe token. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Short non-reversible fingerprint of a secret, safe to use as a map key. */
export function secretFingerprint(secret: string): string {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex").slice(0, 24);
}

function extractApiKey(req: Request): string {
  const header = String(req.get("authorization") || "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer && bearer[1]) return bearer[1].trim();
  return String(req.get("x-api-key") || "").trim();
}

function clientIp(req: Request): string {
  const xff = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
  if (xff) return xff;
  return String(req.socket?.remoteAddress || "unknown");
}

// ---------------------------------------------------------------------------
// 1. Shared-secret auth on call origination
// ---------------------------------------------------------------------------
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = extractApiKey(req);
  if (!provided || !safeEqual(provided, API_KEY)) {
    res.set("WWW-Authenticate", 'Bearer realm="grok-voice-bot"');
    console.log(`[AUTH] Rejected ${req.method} ${req.path} from ${clientIp(req)} (missing/invalid API key)`);
    res.status(401).json({ error: "Unauthorized: missing or invalid API key" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// 2. Twilio request signature validation
//   signature = base64(HMAC-SHA1(authToken, url + concat(sortedParamName + value)))
//   The URL that Twilio signs is the PUBLIC url it was configured with, so
//   behind a tunnel/proxy we rebuild candidates from HOSTNAME / forwarded headers.
// ---------------------------------------------------------------------------
export function twilioSignatureCandidates(req: Request): string[] {
  const originalUrl = req.originalUrl || req.url || "";
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = String(req.get("host") || "").trim();
  const proto = forwardedProto || req.protocol || "https";

  const out = new Set<string>();
  if (PUBLIC_HOSTNAME) out.add(`https://${PUBLIC_HOSTNAME}${originalUrl}`);
  const edgeHost = forwardedHost || host;
  if (edgeHost) {
    out.add(`${proto}://${edgeHost}${originalUrl}`);
    out.add(`https://${edgeHost}${originalUrl}`);
  }
  if (host && `https://${host}${originalUrl}`) out.add(`https://${host}${originalUrl}`);
  return Array.from(out);
}

/** Twilio's HMAC-SHA1 signature over url + sorted POST params. */
export function computeTwilioSignature(url: string, params: Record<string, any>): string {
  let data = url;
  for (const key of Object.keys(params || {}).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue; // Twilio form bodies are flat
    data += key + String(value);
  }
  return crypto.createHmac("sha1", TWILIO_AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = String(req.get("x-twilio-signature") || "").trim();
  if (!signature) {
    console.log(`[TWILIO-AUTH] Rejected ${req.method} ${req.path} from ${clientIp(req)} (no X-Twilio-Signature)`);
    res.status(403).type("text/plain").send("Forbidden: missing X-Twilio-Signature");
    return;
  }
  const params = req.body && typeof req.body === "object" ? (req.body as Record<string, any>) : {};
  const valid = twilioSignatureCandidates(req).some(
    (candidate) => safeEqual(computeTwilioSignature(candidate, params), signature)
  );
  if (!valid) {
    console.log(`[TWILIO-AUTH] Rejected ${req.method} ${req.path} from ${clientIp(req)} (invalid signature)`);
    res.status(403).type("text/plain").send("Forbidden: invalid X-Twilio-Signature");
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// 3. Rate limit on call origination (per API key AND per source IP)
// ---------------------------------------------------------------------------
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function hit(bucketKey: string, now: number): { allowed: boolean; retryAfter: number } {
  const b = buckets.get(bucketKey);
  if (!b || b.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (b.count >= RATE_MAX) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  b.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/** Drop expired buckets so the map can't grow without bound. */
function prune(now: number): void {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export function rateLimitStartCall(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  prune(now);
  const keyBucket = `key:${secretFingerprint(extractApiKey(req))}`;
  const ipBucket = `ip:${clientIp(req)}`;
  for (const bucket of [keyBucket, ipBucket]) {
    const result = hit(bucket, now);
    if (!result.allowed) {
      console.log(`[RATE-LIMIT] Blocked POST /start-call (${bucket.startsWith("ip:") ? "ip" : "key"} limit, ${RATE_MAX}/${RATE_WINDOW_MS}ms)`);
      res.set("Retry-After", String(result.retryAfter));
      res.status(429).json({ error: `Too many call requests. Retry in ${result.retryAfter}s.` });
      return;
    }
  }
  next();
}

/** Boot-time summary — never prints secret values. */
export function securitySummary(): string {
  return (
    `auth=on rate-limit=${RATE_MAX}/${Math.round(RATE_WINDOW_MS / 1000)}s per key+ip ` +
    `twilio-signature=on public-host=${PUBLIC_HOSTNAME || "(unset)"}`
  );
}
