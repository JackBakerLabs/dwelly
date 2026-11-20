# Real-model demo review — 20 November 2026

Inspected the existing four-turn GPT-4.1 mini demo without resetting it or rerunning the model. Captured original evidence, diagnostics, decisions, traces and writes in `captured-session.json`. Checks in `execution-checks.json` verify exact request fields and case IDs against all four executable decisions, and confirm that redelivering the last event adds no writes, traces, intents or model calls.

## Findings

The model integration and graph execution worked on this session: four first-attempt accepted responses, one simulated case creation, three updates to the same case, no provider/contract failures. Scope was maintenance on all four turns. Request durations ranged from 2.246 to 2.637 seconds. These are real OpenRouter model calls with simulated Dwelly effects, not a live Dwelly end-to-end test.

Urgency sequence was low → medium → medium → high. Under the current user-approved policy, expected urgency for these observations is medium → medium → medium → high. The first turn is an under-triage judgment: a contained pipe leak causing a damp patch is a routine genuine defect, and the policy says to use physical evidence rather than tenant tone. The model explicitly cited the tenant's “no rush” phrasing and called the leak stable with no damage escalation risk; the evidence did not establish those stronger assurances. This assessment uses the initial evidence and current policy, not hindsight from the later downstairs damage.

The second turn corrects the case to medium. The third keeps medium and updates the description, but its reason incorrectly calls this an urgency upgrade, and its description calls the leak stable despite an increased drip rate. The fourth correctly raises the same case to high for reported spreading damage below. The description also treats the source of downstairs damage as established rather than suspected; the report only says the downstairs tenant thinks water is coming from upstairs.

This is 3/4 matching urgency labels on this one recorded session, not a complete quality score. All scope labels and API execution checks passed, but factual precision and policy adherence are imperfect. A schema-valid decision can still be wrong. The graph faithfully executed the accepted decisions; it did not introduce the initial low classification. Earlier reports that calls succeeded meant provider/contract/execution success, not an independently graded judgment pass.

## Next improvement

Retain this exact wording and its expected initial medium classification as a regression case before changing the prompt. Evaluate evidence extraction and policy checking that distinguish tenant minimisation, observed worsening and unknown hazards. Compare changes on this and separate cases; do not tune to a perfect single demo or replace the captured result. No runtime prompt or policy was changed during this review.
