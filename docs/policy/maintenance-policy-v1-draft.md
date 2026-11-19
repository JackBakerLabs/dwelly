> Historical draft, superseded by [the user-approved version](maintenance-policy-v1-approved.md). Status statements below describe the original draft, not the active policy.

# Maintenance decision policy v1 — DRAFT FOR USER APPROVAL

Status: not approved; not connected to runtime prompts or validation. Prepared from the pinned 15-case archive. This is a proposed simulation operating policy, not a statement of contractual obligations or statutory repair deadlines. User approval is needed for the proposed business rules; no evidence of Dwelly's approval is implied.

## 1. Decision order and evidence

1. Identify credible immediate danger and required human escalation.
2. Determine repair scope separately from urgency.
3. Assign the priority supported by facts available now.
4. Choose the next justified action using current case state and permissions.

Use attributable observations, not tone, inconvenience alone, guessed diagnoses or final historical outcomes. Distinguish confirmed present, explicitly denied and unknown. A hazard not mentioned is unknown, not confirmed absent. Do not automatically raise every ordinary report to high because an unreported hazard is theoretically possible.

Ask a targeted question when a specific decision-relevant unknown can change the immediate action. Do not repeat an answered question or delay necessary urgent action for secondary details. An urgent case may be opened while a human action is flagged. Material new evidence resumes assessment; corrections supersede old evidence without deleting the audit trail.

## 2. Scope

Archive-supported boundaries:

- Physical defects, failed fixtures and maintenance deterioration can be in scope, including cosmetic defects (03), ordinary faults (02/09/10), security defects (12) and landlord-supplied appliances (15).
- Neighbour conduct complaints with no identified building defect are outside maintenance scope (11). Low urgency does not mean out of scope.
- An emergency can require an external responder rather than a normal maintenance contractor (05). Urgency and ownership are independent.

Proposed operational rules:

- Treat physical defects in managed premises as provisionally in scope unless evidence indicates different ownership/responsibility. If ownership affects whether work can be commissioned, clarify it before authorising work; do not assign responsibility from conjecture.
- Parking entitlement and similar disputes without a physical defect follow the non-maintenance route. A later attributable building defect can justify a repair assessment.
- For a non-maintenance complaint, record an out-of-scope disposition with a concise explanation and route for human follow-up. Do not create a repair case or work order merely to acknowledge it.
- For externally owned emergencies, open or update a record of the incident and surface human escalation. Do not dispatch an ordinary contractor through the automatic branch. Never claim an external call happened unless evidence confirms it.

## 3. Urgency ladder

These labels order action; they do not establish response-time guarantees.

| Level | Policy interpretation | Archive anchors |
|---|---|---|
| Low | Stable cosmetic condition without deterioration, or a limited service issue with an evidenced low-impact workaround and no higher-priority features. Eligible for planned attention or appropriate guidance. | Stable scuffs/hairline cosmetic crack (03); one underperforming radiator while other heating works (14). |
| Medium | Routine repair/inspection for a genuine defect that needs attention, without evidence supporting high/emergency. Containment or a functioning alternative does not automatically reduce it to low. | Dripping tap (02), failed extraction in windowless bathroom (07), single dead socket without reported danger indicators (09), worsening drainage (10), recurring mould needing cause investigation (13), contained appliance leak (15). |
| High | Evidenced active deterioration affecting another unit, severe essential-service loss in adverse conditions, an unsecured accessible property opening, or a serious electrical warning requiring prompt professional attention without current emergency features. | Water damage in flat below (04), total heating/hot-water loss in sub-zero weather (06), flickering/tripping and burning smell with circuit reported switched off (08), unsecured ground-floor window (12). |
| Emergency | Credible immediate threat to life or immediate severe hazard requiring human/emergency response, even if ordinary repair ownership lies elsewhere. | Active water through a light fitting (01); suspected communal gas leak (05). |

Proposed clarifications requiring approval:

- A continuously dripping tap is medium even if usable, contained and described as 'not urgent'. It is an ordinary plumbing defect, not cosmetic-only work.
- A single dead socket with no reported burning, heat, sparking, water or repeated tripping is medium, not high solely because it is electrical. Do not represent those hazards as explicitly denied unless the observation says so. Newly reported danger indicators trigger reassessment.
- A broken accessible ground-floor lock is high, not automatically emergency. Evidence of an immediate threat can justify escalation beyond the archive example.
- Electrical classification depends on present conditions: archive case 08 supports high when the affected circuit is reported off; active fire/smoke or water at a live fitting warrants emergency/human escalation. Never assume isolation or safety from silence.
- A credible vulnerability or exposure detail can change the assessment, but no universal vulnerability-to-priority mapping is inferred from these 15 cases. Flag specific unresolved risk for human review rather than inventing policy.
- A suspected leak reaching another flat is high when attributable observations support that damage; live-electrical or other immediate-danger evidence can make it emergency. Do not use case 04's final label for its earlier contained report.

## 4. Action policy

Proposals for consistent implementation:

- Sufficient in-scope repair evidence and no remote case: open one case at the supported urgency. Existing linked case: update changed fields only. Do not create another case for new facts about the same issue.
- Stable cosmetic defects may be recorded as low and planned attention; case creation is a record, not permission to call out a contractor. Do not automatically commission work just because a case exists. This record choice is proposed; the archive says 'logged' but does not prove a particular API operation.
- Guidance-only issues can remain local/waiting while the next justified action is clarified. Do not force a case POST merely because a report is in scope.
- Vague report: ask one decision-changing question. Low/medium does not mean every report needs a question; obvious routine repairs can be opened directly.
- Missing/conflicting references, unsupported transitions and unresolved remote effects: hold for review with no dependent writes. Emergency evidence must remain visible for human action even when automated writes are held.
- No redundant landlord case announcement: the case-create API already informs the landlord. Other updates should report material facts only.

## 5. Contractor and authority policy

- Select only a currently listed suitable contractor, using trade, evidenced availability and urgency; rating is a tie-breaker after suitability. Historical names or IDs are not current authority.
- One pending assignment at a time; a confirmed decline permits reassignment. Acceptance is not a confirmed visit or completed repair.
- Record attributable quotes and landlord authority. No default spending limit. No inferred emergency override to spending authority. If authority is unknown, insufficient, conditional or invalidated by changed price/scope, seek approval or human intervention before committing the spend.
- Record only genuinely agreed appointment slots. Booking, confirmation, attendance and completion are separate observations.
- Resolve only with attributable completion evidence; do not use an appointment or contractor acceptance as proof of repair.
- These are policy targets. They do not imply the unfinished live correspondence extraction is implemented.

## 6. Policy precedence and archive use

On approval: explicit approved policy governs; precedents illustrate application and must not override it. Retrieve relevant factual conditions, not merely similar titles or final labels. Surface conflicts rather than silently choosing a convenient precedent.

This policy draft explicitly uses all 15 archive cases, including the former held-out cases 02/05/09/11. If adopted into runtime guidance, those cases must be described only as policy-conformance/regression tests, never blind evaluations. Freeze new, independently authored evaluation cases before further prompt tuning. The existing fresh synthetic scenarios are not an independent expert evaluation.

## 7. Approval record and remaining owner decisions

Pending user decision: approve this as a simulation policy, approve with edits, or leave draft. User approval does not establish Dwelly's actual contractual policy.

Explicit owner decisions still not inferred: numeric response SLAs; out-of-hours coverage; monetary approval thresholds; approved emergency communication templates/contact routing; responsibility exceptions; a vulnerability escalation matrix. Until supplied, do not invent values or guarantees. Safety messages should use separately reviewed guidance rather than ad hoc procedural instructions from the model.

Next step after approval: version the approved policy, audit each precedent for compatible conditions, incorporate the rules into prompts/schema-relevant validation, preserve existing graph safeguards, then run policy regressions and a separately labelled fresh evaluation. Do not change the current runtime before approval.
