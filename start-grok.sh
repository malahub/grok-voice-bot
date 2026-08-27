#!/usr/bin/env bash
# start-grok.sh — clean start: server + tunnel + wait for ready
set -e

cd "C:/Users/steve/.hermes/profiles/emailbot/grok-voice-server"

# Kill everything
taskkill /F /PID $(netstat -ano | grep LISTEN | awk '{print $NF}' | sort -u | head -20) 2>/dev/null || true
sleep 2

# Start server (picks free port, writes to temp file)
echo "[1/3] Starting Grok Voice server..."
npx ts-node src/index.ts &
SERVER_PID=$!
sleep 5

# Read the port
PORT=$(cat "C:/Users/steve/AppData/Local/Temp/grok_voice_port.txt" 2>/dev/null)
if [ -z "$PORT" ]; then
  echo "ERROR: server didn't write port file"
  exit 1
fi
echo "  Server on port $PORT (PID $SERVER_PID)"

# Start tunnel
echo "[2/3] Starting Cloudflare tunnel..."
HOST=$(cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1) &
TUNNEL_PID=$!
sleep 8

# Verify
echo "[3/3] Checking health..."
curl -s --max-time 5 "https://$HOST/health"
echo ""

echo "READY. HOSTNAME=$HOST PORT=$PORT"
echo "export HOSTNAME=$HOST" > "C:/Users/steve/AppData/Local/Temp/grok_voice_env.sh"
wait