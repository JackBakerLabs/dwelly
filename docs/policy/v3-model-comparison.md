# User-policy v3 versus v2: measured regression results

This compares the user's approved prompt-policy changes against saved v2 attempts. It is NOT a test of an official Dwelly policy. The current policy was explicitly written to clarify cases and disagreements already seen, so these are policy-conformance/regression measurements, not independent generalisation accuracy.

Method: same three pinned model IDs, same four archive observations, same four synthetic observations, same scorer, same strict proposal schema and graph checks, 45-second timeout and at most one correction. One new run per model/dataset, not repeated until passing. Saved v2 runs were reused as the baseline rather than contemporaneously rerun; provider sampling/defaults and infrastructure variation are therefore possible confounders. No scoring expectations were changed after inspecting the outputs.

| Model | Archive v2 → v3 | Synthetic v2 → v3 | Combined v2 → v3 |
|---|---:|---:|---:|
| Claude Sonnet 5.5 | 4/4 → 4/4 | 4/4 → 3/4 | 8/8 → 7/8 |
| DeepSeek V3.1 | 2/4 → 4/4 | 2/4 → 3/4 | 4/8 → 7/8 |
| GPT-4.1 mini | 2/4 → 4/4 | 4/4 → 3/4 | 6/8 → 7/8 |
| Total | 8/12 → 12/12 | 10/12 → 9/12 | **18/24 → 21/24** |

Exact-match score increased from 75% to 87.5% (+12.5 percentage points). This is a small, exposed set and a single run per model, not statistically established evidence of a general accuracy increase.

Other v3 results:

- Correct urgency labels: **24/24**. Under-triage: **0** (v2 had 2).
- Contract failures: **0**. Provider failures: **0**.
- Graph execution and restart/duplicate replay: **24/24 passed**.
- All responses were accepted on their first attempt; no correction calls were needed.
- No live Dwelly API writes were made. The graphs used recording clients only.

## What improved

All models now match the archive's medium classification for the dripping tap and single failed socket, emergency with human escalation for the gas report, and low/out-of-scope for neighbour noise. DeepSeek now correctly assigns high to the unsecured ground-floor door rather than emergency.

## Remaining discrepancy: cosmetic scratch

All three remaining scorer failures are fresh-02, the stable cosmetic cupboard scratch:

- **DeepSeek:** low/outOfScope. This contradicts the approved policy that cosmetic physical defects remain in scope.
- **Claude and GPT-4.1 mini:** low/wait. The scorer requires an open repair case. However, the approved policy says stable cosmetic issues may be recorded for planned attention without a contractor callout, and does not categorically require a remote case for every such report. Claude explicitly treated it as in scope and chose local deferral. These responses expose a policy/action-expectation ambiguity, not an urgency failure or graph malfunction.

The original scores are retained. Do not retroactively grant passes. A future policy revision should clarify whether low-priority cosmetic reports must always open a remote record, or may remain locally recorded for planned attention. If local waiting is permitted, define a review trigger so it does not mean indefinite neglect, then version the scorer accordingly and report both versions.

The pass metric checks action/disposition, urgency and required human escalation. It does not grade every generated statement or the quality of emergency advice. Human-review wording, factual precision and safety communication need separate evaluation.

## Evidence

Raw responses, policy attribution, per-attempt timing, schema hashes, bound decisions, graph traces and restart checks are in:

`docs/diagnostics/policy-v3-comparison-2026-11-19T16-41-34.568Z/`

`comparison.json` contains the machine-readable paired results. Older baseline reports remain unchanged under the timestamped triage-v2 and fresh-v2 directories.
