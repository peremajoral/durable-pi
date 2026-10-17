# Durable Pi harness in a Cloudflare Durable Object.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/pi-durable-cloudflare"

port := env("DPI_CF_PORT", "8899")

# List cloudflare commands
[default]
default:
    @just --list cloudflare

# Install dependencies (published chord + pi-ai + pi-durable, wrangler)
install:
    npm install --no-audit --no-fund

# Type check the worker against the published packages
check:
    npm run check

# Run the Durable Object locally
dev *ARGS:
    npx wrangler dev --port {{ port }} --ip 127.0.0.1 {{ ARGS }}

# The four curls that prove the durable loop: answer, tool call, exactly-once, transcript
demo:
    #!/usr/bin/env bash
    set -euo pipefail
    P=http://127.0.0.1:{{ port }}
    echo "— a message is answered —"
    curl -sf -X POST "$P/message" -H 'content-type: application/json' -d '{"content":"hello"}'; echo
    echo "— a message forces a tool call, which runs as a durable task —"
    curl -sf -X POST "$P/message" -H 'content-type: application/json' -d '{"content":"tool: ping"}'; echo
    echo "— the same request id twice returns the same submission, not two —"
    curl -sf -X POST "$P/message" -H 'content-type: application/json' -H 'x-request-id: job-42' -d '{"content":"once"}'; echo
    curl -sf -X POST "$P/message" -H 'content-type: application/json' -H 'x-request-id: job-42' -d '{"content":"once"}'; echo
    echo "— entries, and the messages the model saw —"
    curl -sf "$P/transcript"; echo

# Deploy. Reads no secrets; see the README about authentication first.
deploy:
    npx wrangler deploy
