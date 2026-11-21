# Verification — 21 November 2026

Offline gate for interview submit readiness. Runtime: Node 22.14.0. No live Dwelly writes in this run.

## Executed checks

1. `npm ci && npm run build && npm test` — **184 passed, 0 failed**, including `tests/live-replay.test.ts` (captured `interview-session-1` leaking-sink fixture).
2. `npm run replay -- case-04` — one create, one same-case high update, zero landlord announcements.
3. Model config for interview: OpenRouter `anthropic/claude-sonnet-5.5` (see `.env.example`, `docs/interview-handoff.md`). Comparison evidence: `docs/diagnostics/model-compare-2026-11-21/`.
4. Fixture hygiene: do not commit `.env`; secrets stay out of example files and diagnostics summaries.

## Interview model choice

- **Live/eval default (documented):** `MODEL_PROVIDER=openrouter` + `OPENROUTER_MODEL=anthropic/claude-sonnet-5.5`
- Evidence for preferring Sonnet over gpt-4.1-mini: fresh demo-undertriage pass and conversations urgency — see `docs/diagnostics/model-compare-2026-11-21/comparison.md`
- **Remaining blocker:** fresh `DWELLY_TOKEN` / new session ID (do not reuse `interview-session-1` for a new live write)

## What this does **not** claim

- Live rerun on a fresh Dwelly session.
- Real-model `npm run eval` / `eval-fresh` accuracy on the v4 prompt as an independent external assessment (reserved cases 02/05/09/11 remain labelled regressions).
- Contractor behaviour against real non-fixture correspondence.

Those remain interview-day steps. The labelled demo under-triage regression (`demo-undertriage-2026-11-20` in `fixtures/assessment-v2-fresh.json` and conversations) records expected medium on turn 1; model-compare evidence for Sonnet is separate from the offline 184/184 gate.

## Historical appendix

- 20 Nov 2026 offline gate (184/184 + case-04 replay) remains the baseline; this note adds model choice + handoff status.
- Earlier dated verification notes (52 → 103 → 109 → 112 offline counts, MVP checkpoint 62500df, assessment-v2 follow-ups) are superseded for current status. See git history and `docs/assessment-v2.md` / `docs/scope-wait-results.md` for those archives.
