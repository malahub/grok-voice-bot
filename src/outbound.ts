/**
 * Quick CLI to start a Grok Voice scenario call.
 *
 * Usage:
 *   SID=SCENARIO TO=+15613012117 node dist/outbound.js
 *   or
 *   node dist/outbound.js --scenario payoff_query --to +15613012117
 *
 * Requires the server running with HOSTNAME set. Use the API:
 *   POST /start-call  { to, scenario }
 */
import "dotenv-flow/config";
import fetch from "node-fetch";

const HOSTNAME = (process.env.HOSTNAME || "").replace(/^https?:\/\//, "");
const PORT = process.env.PORT || 3000;

async function main() {
  const args = process.argv.slice(2);
  const getArg = (key: string) => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : "";
  };

  const scenario = getArg("--scenario") || process.env.SCENARIO || "";
  const to = getArg("--to") || process.env.TARGET_PHONE_NUMBER || "";

  if (!scenario || !to) {
    console.error("Usage: node outbound.js --scenario PAYOFF_QUERY --to +15613012117");
    process.exit(1);
  }

  const base = HOSTNAME ? `https://${HOSTNAME}` : `http://localhost:${PORT}`;
  console.log(`Starting call scenario=${scenario} to=${to}`);

  const res = await fetch(`${base}/start-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, scenario }),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});