# Dwelly maintenance agent

A Node.js/TypeScript maintenance worker with an explicit state graph, durable SQLite events and action journal, a CLI, and a recording replay client. Opening a case records its remote ID; new evidence updates that case. It never sends a redundant landlord announcement.

**Interviewers:** start with **[`docs/HANDOVER.md`](docs/HANDOVER.md)** — product framing, architecture, build chronology, proofs, and the operator runbook.

## Offline checks

Use Node **22.14.0** (`nvm use`).

```sh
npm ci
npm run build
npm test
npm run replay -- case-04
```

Replay is offline and scripted. It shows a medium case opening followed by a high urgency update on the same remote case when downstairs damage becomes known. The command prints the database, session, issue ID, and inspect command.

```sh
DWELLY_SESSION_ID=<printed-session> DWELLY_DB=<printed-path> npm run inspect -- <issue-id>
```

## Live (interview day)

Load environment variables into your shell (`.env.example` as reference). The CLI does **not** auto-load `.env`. Use a **new** session ID and a fresh `DWELLY_TOKEN` — do not reuse `interview-session-1`.

```sh
export MODEL_PROVIDER=openrouter
export OPENROUTER_MODEL=anthropic/claude-sonnet-5.5
# OPENROUTER_API_KEY and DWELLY_TOKEN from your secret manager
export DWELLY_SESSION_ID="interview-$(date -u +%Y%m%dT%H%M%SZ)"
export DWELLY_BASE_URL=https://167.172.96.156.sslip.io
npm run live
```

Observer (second terminal, same session / DB):

```sh
export DWELLY_SESSION_ID=...
npm run observe
```

Optional paid eval (no Dwelly mutations): `npm run eval`.

## Commands

| Command | Purpose |
|---|---|
| `replay case-04` | Offline product story |
| `inspect` / `--review` / `--waiting` | Trace and holds |
| `live` / `observe` | Authenticated worker + read-only dashboard |
| `eval` / `eval-fresh` | Real model, no Dwelly writes |
| `reconcile` / `ack-wait` | Operator recovery (no remote write on reconcile) |
| `demo` / `demo:llm` | Local dashboard (scripted or real model, simulated API) |

Pinned contract: `snapshots/2026-11-19/`. Full narrative, diagrams, and decision tables: [`docs/HANDOVER.md`](docs/HANDOVER.md).
