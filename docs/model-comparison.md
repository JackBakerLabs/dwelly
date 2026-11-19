# Real-model comparison

All runs used the unchanged assessor prompt, validation, initial observations and scorer for held-out cases 02, 05, 09 and 11. One bounded correction was allowed. No Dwelly mutations were made. These are single-run, four-case results, not a general model benchmark.

| Model | Passed | Wrong urgency among valid decisions | Output validation failures |
|---|---:|---:|---:|
| DeepSeek V3.1 (earlier run) | 3/4 | 1 (02) | 0 |
| GPT-4.1 mini | 1/4 | 1 (02) | 2 (09, 11) |
| Gemini 2.5 Flash | 1/4 | 0 | 3 (02, 05, 09) |
| GPT-4.1 | 0/4 | 0 | 4 |

Claude Sonnet 4 was attempted but could not be evaluated: a diagnostic request returned HTTP 404 stating that no OpenRouter provider serves this model anymore. GPT-4.1 replaced it as the third completed additional run. Do not interpret the Claude report's zero score as model judgment failure.

The current scorer counts missing urgency from review fallbacks as under-triage; distinguish these validation/provider failures from actual low-urgency decisions. Raw invalid responses and exact validation errors were not retained by the current assessor, so the precise reasons for rejection need diagnostic instrumentation before drawing model-quality conclusions. Next improvement: preserve credential-free validation diagnostics and response shape, then investigate application/prompt compatibility using development fixtures before another held-out evaluation.

Reports: deepseek-evaluation.json, eval-openai-gpt-4.1-mini.json, eval-google-gemini-2.5-flash.json, eval-openai-gpt-4.1.json. The attempted Claude report is eval-anthropic-claude-sonnet-4.json.

## Kimi and current Claude follow-up

Selected model IDs from OpenRouter's live directory before running. Same prompt, four initial observations, local validator, correction bound and scorer; added observation-only response diagnostics without changing requests.

| Model | Passed | Details |
|---|---:|---|
| anthropic/claude-sonnet-5.5 | 4/4 | Correct urgency and disposition throughout; zero validation failures |
| moonshotai/kimi-k3.1-pro | 2/4 | Case 02 under-triaged low vs medium; case 09 request unavailable; cases 05 and 11 passed |

Kimi case 09 produced no captured HTTP response; the assessor returned its provider/transport-failure fallback. It is not evidence of an incorrect model judgment. The 45-second request timeout remained unchanged. Exact transport exception was not retained. Both reports include sanitized diagnostics; no credentials or Dwelly mutations were involved.

Reports: eval-anthropic-claude-sonnet-5.5.json and eval-moonshotai-kimi-k3.1-pro.json. These are single runs on four cases and do not establish broader production reliability.
