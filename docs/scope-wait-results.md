# Scope and wait reliability: implementation and measurement

Implemented 19 November 2026. Prompt `triage-v4-scope-wait`; contract `assessment-v3-scope-wait`; user policy `user-maintenance-policy-v1.1-cosmetic-record`. The cosmetic case rule is explicitly the user's approved change, not Dwelly policy.

## Changes

Scope is required separately from urgency in model proposals, with semantic checks against the action. Existing executable journals accept absent scope for compatibility; historical model proposals have an explicit v2 replay adapter. Stable cosmetic defects must open a low-priority record and do not commission work.

Waits persist a trigger, origin event, actor where relevant and optional configured review time. Due waits become visible review items without remote writes. Missing review configuration is visible; no SLA is invented. Material linked replies clear obsolete questions and waits, while acknowledgements and wrong-actor replies do not. Operator acknowledgement cannot clear unresolved remote effects. Legacy waits remain inspectable and are labelled for investigation.

The frozen benchmark covers vague report → clarification → contained leak → worsening damage, non-maintenance complaint → correction identifying a repair, and stable cosmetic defects. Each scenario has two paraphrases and two repeats per model: 12 conversations / 24 turns per model. Every turn runs through SQLite and a simulated World client, then restarts and redelivers the same event. Expected labels stay outside model input. Existing contractor authority/quote/slot/completion regression tests remain in the suite; no new live contractor extraction is claimed.

## Real-model results

| Model | Scope | Urgency | Action | Graph execution | Restart/duplicate | Mean turn latency | Sum of returned `usage.cost` |
|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic/claude-sonnet-5.5 | 24/24 | 20/20 | 24/24 | 24/24 | 24/24 | 3.53s | 0.326100 |
| openai/gpt-4.1-mini | 24/24 | 20/20 | 24/24 | 24/24 | 24/24 | 2.41s | 0.028283 |

Both models passed all 12 complete conversations, including both paraphrases and repeats. All 48 responses passed the contract on the first attempt: zero provider errors, validation failures or correction calls. There were no extra questions relative to the frozen expected actions. Urgency is intentionally unscored on the eight vague-report turns. Recorded request payloads were independently checked against each returned executable decision, including recipient/case identifiers for messages and updates; see `payload-verification.json`.

Cost is the arithmetic sum of the provider's returned `usage.cost` field, not a price estimate or billing reconciliation. Latency is observed wall time per turn, including graph overhead. Full diagnostics include returned model IDs, tokens, schemas, policy attribution and per-attempt timings.

Reports: [Claude](diagnostics/conversations-v4-2026-11-19T16-57-23.391Z/anthropic_claude-sonnet-5.5.json), [GPT-4.1 mini](diagnostics/conversations-v4-2026-11-19T16-57-23.391Z/openai_gpt-4.1-mini.json).

## Interpretation and limits

These results show that the revised policy and graph can handle the tested conversations with either model. They do not justify choosing a larger model as the remaining fix, nor do they establish production accuracy. The previous v3 comparison scored each model 7/8 on a different one-turn set, with the cosmetic case failing. The current cosmetic variants passed 8/8 across the two models, consistent with resolving that ambiguity; this is not a controlled estimate of the improvement because both the contract and test inputs changed.

The fixtures are synthetic and authored with knowledge of past failures. Scope types constrain consistency but cannot ensure the model chooses the correct label. Independent expert-labelled conversations, broader ambiguous/conflicting observations, live event mapping and token-bound end-to-end verification remain outstanding. No automatic model fallback or production model default was added from this small result. Operational review intervals, spending thresholds and emergency communication policy still require owner-supplied values.

## Verification

Strict build and all 109 offline tests passed, including real-response historical replay tests, scope/wait tests, conversation harness tests and existing contractor tests. A fresh source copy with no compiled output also passed all 109 tests using the existing pinned dependencies. Case-04 recording replay passed. `git diff --check` and credential scan passed. No live Dwelly API writes were made.

Reproduce: `npm run build`, `npm test`, then with a securely supplied `OPENROUTER_API_KEY`, `npm run eval-conversations -- <model-id> 2`. Each run writes a new timestamped directory; prior reports are preserved.
