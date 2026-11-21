# Tier-2 model compare — 2026-11-21

Provider: OpenRouter · Prompt: `triage-v4-scope-wait` · No Dwelly live mutations.

## Recommendation

**Interview live model: `anthropic/claude-sonnet-5.5`**

- Perfect on archive eval, fresh (including demo-undertriage → medium), and conversations urgency (12/12 at repeats=1).
- Runner-up: `openai/gpt-4.1` — same perfect archive+fresh, cheaper/faster, but still under-triaged demo conversations variant 0 once.
- Avoid for interview if under-triage is the risk: `openai/gpt-4.1-mini` and `deepseek/deepseek-chat-v3.1` both fail demo-undertriage on fresh.

## Comparison table

| model | eval | underTriage | prov/contract | 02/05/09/11 urgencies | fresh | demo-undertriage | cost eval+fresh (USD) | latency eval+fresh (ms) |
|---|---|---|---|---|---|---|---|---|
| openai/gpt-4.1-mini (baseline) | 4/4 | 0 | 0/0 | medium/emergency/medium/low | 4/5 | low (underTriage=True) | n/a | n/a |
| anthropic/claude-sonnet-5.5 | 4/4 | 0 | 0/0 | medium/emergency/medium/low | 5/5 | medium (pass) | 0.1259 | 36368 |
| openai/gpt-4.1 | 4/4 | 0 | 0/0 | medium/emergency/medium/low | 5/5 | medium (pass) | 0.0530 | 19065 |
| deepseek/deepseek-chat-v3.1 | 4/4 | 0 | 0/0 | medium/emergency/medium/low | 4/5 | low (underTriage=True) | 0.0067 | 30430 |

## Optional conversations (repeats=1 for winners)

| model | urgencyPassed/scored | demo-undertriage outcomes | cost USD | latency ms |
|---|---|---|---|---|
| anthropic/claude-sonnet-5.5 | 12/12 | both variants medium (pass) | 0.193008 | 46704 |
| openai/gpt-4.1 | 11/12 | v0 low (fail), v1 medium (pass) | 0.082788 | 30324 |
| openai/gpt-4.1-mini (baseline, repeats=2) | 20/24 | 1 pass / 3 under-triage | n/a | n/a |

## Caveats

- Single-run noise; prior mini diagnose under-triaged case-02 even when eval passed.
- Winner conversations used repeats=1; mini baseline used repeats=2.
- Sonnet is slower/pricier than gpt-4.1; both beat mini on the fresh under-triage gate.
- No live Dwelly write session.

Artifacts: `docs/diagnostics/model-compare-2026-11-21/`
