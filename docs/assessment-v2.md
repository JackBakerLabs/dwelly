# Assessment contract v2 — implementation and verification

## What changed

The model proposes a maintenance action. Application code chooses executable identifiers and checks state. The internal `Decision` type, SQLite format, action journal and world client signatures are unchanged, so existing databases and queued intents require no migration.

- `src/triage/permissions.ts`: one action-permission function used by generation, binding and internal validation. An absent remote case excludes update; a linked case excludes open; review/resolved/closed issues permit no model mutation assessment. Graph uncertain-write holds continue to prevent assessment upstream.
- `src/triage/proposal.ts`: explicit localIssueId, remoteCase:null, outstandingQuestion:null, current evidence and allowed actions; model output contains no execution case/recipient IDs. Known tenant and case IDs are bound by the application. Nullable optional fields are removed only where the schema explicitly permits null. Missing required information is never invented, and an update is never converted into a creation.
- Strict JSON Schema is derived from Zod proposal branches, wrapped in a root `decision` object. Object fields are required, optional values are nullable, and unknown fields are rejected. OpenAI and OpenRouter both use Chat Completions `json_schema` with strict:true; OpenRouter also requires parameter support from the selected provider. Unsupported providers fail visibly, with no silent downgrade to unconstrained JSON.
- `src/triage/index.ts`: one correction maximum includes the rejected assistant response, exact field errors/stable semantic error codes and allowed actions. Untrusted responses remain subordinate to application instructions. Transport, HTTP and envelope failures do not trigger correction. Runtime and semantic validation remain mandatory after generation.
- Diagnostics include requested/returned model, provider, prompt/schema version, schema hash, attempt timing, HTTP status, exact errors, response text and correction success. Sink failures do not affect decisions; credentials are redacted. Reports can contain tenant evidence and must be treated as case data.
- Evaluation reports provider failures, output-contract failures, actual under-triage and missing-urgency coverage separately. Review fallbacks remain overall failures but no longer count as low-urgency judgments. Graph replay has its own result.

Structured-output references checked during implementation: https://openrouter.ai/docs/guides/features/structured-outputs and https://developers.openai.com/api/docs/guides/structured-outputs . The provider response schema enforces shape, not truth, scope or urgency correctness.

## Actual real-model results

Prompt version `triage-v2`, contract version `assessment-v2`. The maintenance priority rubric was unchanged. One initial call per case, up to one correction, 45-second request timeout. No model was rerun until it passed. Provider-default sampling remains in effect. The original historical reports and v1 diagnostics were preserved.

| Model | Archive regression | Fresh synthetic scenarios | Contract failures | Provider failures |
|---|---:|---:|---:|---:|
| Claude Sonnet 5.5 | 4/4 | 4/4 | 0/8 | 0/8 |
| DeepSeek V3.1 | 2/4 | 2/4 | 0/8 | 0/8 |
| GPT-4.1 mini | 2/4 | 4/4 | 0/8 | 0/8 |

All **24 initial responses validated on the first attempt**. All 24 bound decisions replayed through the full recording graph with correct effects, restart recovery and duplicate-delivery behavior. The 14 previously saved valid decisions also continue to pass. Passing graph execution means faithful action execution, not correct maintenance judgment.

Remaining archive judgment errors:

- DeepSeek: case 02 low instead of medium; case 11 opened a repair case instead of out-of-scope.
- GPT-4.1 mini: case 02 low instead of medium; case 09 high instead of medium.
- Claude matched all four expected outcomes.

Fresh synthetic errors: DeepSeek treated the cosmetic scratch as out of scope and classified the unsecured ground-floor door as emergency instead of high. Claude and GPT-4.1 mini matched all four expectations.

Archive cases 02/05/09/11 are now **regression cases**, not a blind hold-out, because their failures have been inspected. The four new synthetic scenarios were frozen at commit `f0852ba` before model calls and were not used to tune the prompt. Their expectations stayed only in the scorer. They were authored in this implementation, so they are not an independently authored external evaluation. A genuinely independent set is still needed for production-quality confidence. No model-specific prompt tuning followed these results.

Evidence directories:

- `docs/diagnostics/triage-v2-2026-11-19T16-17-30.003Z/`: archive results, raw proposals, exact decisions and graph traces.
- `docs/diagnostics/fresh-v2-2026-11-19T16-19-42.715Z/`: fresh fixtures, results, diagnostics and graph replays.
- `fixtures/assessment-v2-fresh.json`: frozen synthetic observations and scorer expectations.

## Executed verification

Strict build and **103/103 deterministic tests passed**. This includes context/permission tests, schema consistency, null handling, forbidden identifiers, precise correction, failed correction bounds, provider errors, credential redaction, scoring isolation, a question/open/update sequence across restart, existing world/store regressions and 24 captured v2 proposal-to-graph regression tests. Offline tests use no model key and make no network calls.

The real-model runs used OpenRouter only and made **zero live Dwelly mutations**. They are bounded single-run comparisons on small datasets, not broad model benchmarks. Claude remains the provisional baseline; the application default was not silently changed.

## Commands

```sh
npm ci
npm run build
npm test
npm run replay -- case-04
npm run diagnose -- --saved
# Model calls require an environment credential and explicit model selection:
MODEL_PROVIDER=openrouter OPENROUTER_MODEL=anthropic/claude-sonnet-5.5 npm run eval
MODEL_PROVIDER=openrouter OPENROUTER_MODEL=anthropic/claude-sonnet-5.5 npm run eval-fresh
# OPENROUTER_API_KEY supplied separately, never as a command argument:
npm run diagnose -- anthropic/claude-sonnet-5.5 deepseek/deepseek-chat-v3.1 openai/gpt-4.1-mini
```

New diagnose reports are stored in timestamped version directories; earlier evidence is not overwritten. `eval-fresh` uses the same assessor and scorer with the frozen synthetic scenarios. Diagnostics contain model text; keep private case reports out of public repositories.

## Remaining limits

No live Dwelly feed/token verification was performed. Contractor natural-language extraction and other previously documented extension gaps remain. Schema compliance cannot prevent a valid but wrong urgency or scope decision, nor validate detailed safety advice. Existing closure-evidence checks remain conservative heuristics. Review holds are intentional; they require operator resolution rather than automatic retries.

Final clean-source rehearsal: exported commit `57785ca` into an empty temporary directory, ran cached `npm ci`, strict build, all **103 tests**, case-04 replay, saved-decision replay (**14/14**) and CLI inspection. All passed. Inspection confirmed high urgency on the same linked case and two confirmed actions. No workspace database or installed dependencies were reused.
