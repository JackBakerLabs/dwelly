# Assessment versus graph: observed findings

## Controlled method

Preserved system prompt, context, model parameters, 45-second timeout, scorer and one-correction policy. Added an observational callback that records model, evidence IDs, attempt, HTTP status, response text, exact schema issues or semantic error, and failure stage. Credentials are redacted; diagnostic sink exceptions cannot affect assessment. Ordinary `eval` output now includes these diagnostics.

Replayed exact saved valid decisions through Ingest, Route, Assess (captured decision injected), Validate, Act (recording world client), and Checkpoint. Used original initial tenant observations, synthetic event envelopes and fresh file-backed SQLite per replay. Checked exact case-create fields/returned ID, urgency, human action, no unexpected messages, or zero writes for out-of-scope. Reopened the database and redelivered the event; checked no reassessment, changed state or extra writes.

## Results

- **14/14 saved valid decisions passed graph execution and restart/deduplication.** Includes decisions with incorrect urgency: faithful execution is not a correct judgment.
- Reran GPT-4.1 mini, GPT-4.1 and Gemini 2.5 Flash with diagnostics. New judgment+contract pass counts: 0/4, 0/4 and 2/4 respectively. These are new stochastic runs, not retroactively explained earlier runs.
- **12/12 new returned decisions/fallbacks passed graph execution checks.** Ten were review fallbacks and caused no writes; two were valid Gemini decisions.
- **20/20 raw rejected response attempts were also injected into the graph and safely rejected with zero writes.** Both attempts are counted separately here.
- **71/71 deterministic tests passed**, including diagnostic redaction, exact errors, observer isolation and saved-real-decision regressions.

## Exact failures and attribution

1. **Local/remote ID confusion.** GPT-4.1 and Gemini proposed `update` with `caseId: "eval-case-02"` (also GPT cases 05/09). That is the local issue ID; no remote case exists. Validator reports `Unknown case`. The graph correctly refuses the PATCH. Context currently exposes `issue.id` and omits `remoteCase` when undefined, so application context should distinguish these more explicitly.
2. **Missing output fields.** Responses omit `reason`, `evidenceIds`, or required `urgency` for outOfScope. Exact Zod paths are captured. One correction omitted title and urgency from an open action. These violate the intended audit/decision contract; they are not arbitrary validator rejection of fully conforming output.
3. **Wrong status namespace.** GPT-4.1 mini proposed `patch.status: "active"`, a local issue state rather than one of the permitted remote case statuses. The schema correctly rejects it. The prompt does not enumerate the remote status values or supply a machine-readable response schema.
4. **Emergency without human action.** One GPT-4.1 correction dropped humanAction. The validator blocked it, as intended.
5. **Judgment errors coexist.** Some invalid responses also selected low for case 02, and Gemini's corrected case 09 proposed high instead of medium. Fixing JSON/ID handling alone does not establish correct urgency.

The correction call adds only a generic request to return valid JSON. It supplies neither the exact validation error nor the rejected assistant response. This is an application integration weakness, not a graph execution problem. No prompt/schema changes were made during this diagnostic experiment.

## Conclusion and limits

For these initial-report evaluations, the observed bottleneck is **the assessment integration and model compliance/judgment, not graph dispatch/checkpoint execution**. There is no evidence here that the validator should accept invented remote IDs or incomplete decisions. The current evidence supports improving explicit local/remote state, schema-constrained generation where supported, and bounded correction with actual errors before changing models solely on aggregate scores.

This does not certify the graph for live payload routing, successful real-model updates, multi-turn clarification, contractor scheduling or remote network failure recovery. Those need separate scenarios. The replay uses the recording client, not the live Dwelly service. No external calls, landlord messages or case mutations occurred.

## Reproduce

```sh
npm run build
npm test
npm run diagnose -- --saved
# OPENROUTER_API_KEY must be in the environment for new paid calls:
npm run diagnose -- openai/gpt-4.1-mini openai/gpt-4.1 google/gemini-2.5-flash
```

Evidence: `saved-decision-replays.json` and the three model JSON files in this directory contain all per-case traces, writes, restart assertions, captured response text and exact errors. Original evaluation reports are retained unchanged under `docs/`.
