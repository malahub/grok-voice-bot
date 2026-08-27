#!/usr/bin/env python
"""Extract XAI_API_KEY from codebot .env and write to grok-voice-server .env"""
import re

# Read from codebot
with open(r'C:\Users\steve\.hermes\profiles\codebot\.env', 'r') as f:
    content = f.read()

match = re.search(r'^XAI_API_KEY=(.+)$', content, re.MULTILINE)
if not match:
    print("ERROR: XAI_API_KEY not found in codebot .env")
    exit(1)

key = match.group(1).strip()

# Write to our .env
env_path = r'C:\Users\steve\.hermes\profiles\emailbot\grok-voice-server\.env'
with open(env_path, 'r') as f:
    env_content = f.read()

env_content = re.sub(
    r'^XAI_API_KEY=.*$',
    f'XAI_API_KEY={key}',
    env_content,
    flags=re.MULTILINE
)

with open(env_path, 'w') as f:
    f.write(env_content)

print("DONE - XAI_API_KEY written to .env")