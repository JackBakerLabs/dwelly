# Interview handoff note — 2026-11-21

## Status

| Item | Status |
|---|---|
| Offline gate | **184/184** (`npm test`) + `npm run replay -- case-04` |
| Interview model | **`anthropic/claude-sonnet-5.5`** via OpenRouter |
| Comparison evidence | `docs/diagnostics/model-compare-2026-11-21/` (Sonnet perfect on archive, fresh incl. demo-undertriage, conversations 12/12) |
| Remaining blocker | Fresh **`DWELLY_TOKEN`** + **new** `DWELLY_SESSION_ID` (do not reuse `interview-session-1`) |

## Why Sonnet

Compared to `openai/gpt-4.1-mini`, Sonnet passed the fresh demo-undertriage gate (medium) and conversations urgency; mini under-triaged demo on fresh. Full table: `docs/diagnostics/model-compare-2026-11-21/comparison.md`.

## Exact start commands

See `docs/interview-handoff.md`.
