# Verification — 20 November 2026

Offline gate for the brief-gaps plan. Runtime: Node 22.14.0. No live Dwelly writes and no paid model calls in this run.

## Executed checks

1. `npm ci && npm run build && npm test` — **184 passed, 0 failed**, including `tests/live-replay.test.ts` (captured `interview-session-1` leaking-sink fixture).
2. `npm run replay -- case-04` — one create, one same-case high update, zero landlord announcements.
3. Clean-checkout rehearsal: `git archive` of the final commit into a temp directory, then `npm ci`, build, test, replay — no workspace DB or `dist` reused (recorded in the handoff after the final commit).
4. Fixture hygiene: credential-shaped scan of `fixtures/live-leaking-sink-2026-11-20.json` and `docs/diagnostics/llm-demo-review-2026-11-20/` — clean; `git diff --check` clean.

## What this does **not** claim

- Live rerun on a fresh Dwelly session.
- Real-model `npm run eval` / `eval-fresh` accuracy on the v4 prompt (including reserved cases 02/05/09/11).
- Contractor behaviour against real non-fixture correspondence.

Those remain interview-day steps. The labelled demo under-triage regression (`demo-undertriage-2026-11-20` in `fixtures/assessment-v2-fresh.json` and conversations) records expected medium on turn 1; it does not assert a measured model score.

## Historical appendix (pre-2026-11-20)

Earlier dated verification notes (52 → 103 → 109 → 112 offline counts, MVP checkpoint 62500df, assessment-v2 follow-ups) are superseded for current status. See git history and `docs/assessment-v2.md` / `docs/scope-wait-results.md` for those archives.
