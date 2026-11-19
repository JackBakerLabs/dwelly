# Contractor extension: local adapter contract

These are explicitly synthetic fixture conventions. The public OpenAPI declares event payloads open-ended and does not guarantee these fields or event types. Do not manufacture them from unverified message text. Real correspondence needs a separately verified boundary decoder before automatic live coordination is enabled.

Each supported event has the normal WorldEvent envelope and an attributable actor. Payloads accept only the following keys: case_id, work_order_id, cost_estimate_gbp, spending_limit_gbp, approved_quote_gbp, slot, completed. Other payload keys are rejected for review.

| Type | Required observation | Actor |
|---|---|---|
| work_order.accepted / work_order.declined | case_id, work_order_id | Assigned contractor |
| coordination.authority | case_id, spending_limit_gbp | Landlord |
| coordination.quote | case_id, work_order_id, cost_estimate_gbp | Accepted contractor |
| coordination.approval | case_id, work_order_id, approved_quote_gbp matching current quote | Same landlord |
| coordination.slot | case_id, work_order_id, slot | Tenant and contractor independently |
| coordination.confirmed | case_id, work_order_id, slot matching recorded slot | Contractor |
| coordination.completed | case_id, work_order_id, completed:true after confirmation | Contractor |

No second order is dispatched while pending. Decline excludes that contractor from reassignment. Directory trade must match the operator-selected trade exactly, ignoring case; explicitly available candidates rank by rating and stable ID. Historical contractor names never become current IDs. A missing available match requires review.

Spending limits and exact quote approvals are stored independently. A changed quote invalidates exact approval; a higher price above the cap waits for renewed approval. A booked appointment or price change after booking requires human review. Silence causes no writes. Matching slot agreements are recorded before visit confirmation; completion then patches both remote and local case status.

Every effect is journaled before dispatch; confirmed results are reused during replay. Each input stores a before-state snapshot so a crash after confirmed effects can resume local progression without duplicate writes. In-flight effects become uncertain on restart, and subsequent effects are held. Validation/HTTP failures including rate limits conservatively hold for review. Automatic retry/reconciliation of extension effects is not implemented.

Limitations: no natural-language quote/authority/availability extraction; no automatic trade inference; no scheduling solicitation when parties have not supplied slots; no unsupported system-null-actor acceptance inference; no automatic appointment renegotiation. These limitations prevent claiming a completed live contractor agent. The fixtures prove the implemented state transitions and API actions only.
