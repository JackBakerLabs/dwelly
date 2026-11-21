# Interview day handoff

Offline gate: **184/184** tests + `npm run replay -- case-04`.  
Documented live/eval model: OpenRouter **`anthropic/claude-sonnet-5.5`**.  
Comparison evidence: `docs/diagnostics/model-compare-2026-11-21/`.  
**Blocker until interview:** a fresh `DWELLY_TOKEN` and a **new** session ID (do not reuse `interview-session-1` or its SQLite file).

## Setup

```bash
nvm use   # Node 22.14.0
npm ci && npm run build && npm test
npm run replay -- case-04
```

## Live start (new session only)

```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_MODEL=anthropic/claude-sonnet-5.5
# OPENROUTER_API_KEY from secret manager
export DWELLY_SESSION_ID="interview-$(date -u +%Y%m%dT%H%M%SZ)"  # NEW session, not interview-session-1
export DWELLY_TOKEN=...
# optional: export DWELLY_DB=".data/${DWELLY_SESSION_ID}.sqlite"
export DWELLY_BASE_URL=https://167.172.96.156.sslip.io
npm run live
```

Observer in a second terminal (same session / DB path):

```bash
export DWELLY_SESSION_ID=...   # same as worker
# export DWELLY_DB=...          # if the worker set an explicit path
npm run observe
```

## Optional paid smoke (not required if offline is green)

```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_MODEL=anthropic/claude-sonnet-5.5
# OPENROUTER_API_KEY from secret manager
npm run eval   # or a single-case smoke if preferred
```

## Notes

- The CLI does **not** auto-load `.env`; export vars into the shell.
- Never put API keys or tokens in committed files.
- Secrets and local DB live in `.env` / `.data/` (gitignored).
