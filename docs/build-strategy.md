# Dwelly maintenance agent — implementation brief

## Assignment

You are the lead coding agent. Build a Node.js and TypeScript service that reads Dwelly simulation events, assesses maintenance issues and takes the next justified action. Implement the workflow as an explicit state graph. Give the operator a CLI to run it, inspect one issue and replay a failure during a 60-minute screen share.

**Deliver the MVP first.** A tenant reports a problem, the service links the report to an issue, assesses urgency using the case archive, asks a targeted question if needed, and opens or updates one case. It can also wait, recognise an out-of-scope request, or flag a case for human action. A later message resumes the issue after a process restart. Leave contractor coordination and wider progress updates for the extension below. A dashboard is outside this build.

**First demonstration:** replay archive case-04. The tenant initially describes a tiny contained leak and says there is no rush. Later evidence reveals damage to the flat below. Show what the service knew at each turn, why the urgency changed, and how the same remote case was updated. Do not expose the archive’s final label to the decision node.

## 1. Establish the contract before parallel implementation

Use the candidate pack and download both inputs. Pin dated snapshots for local builds and replay. Record the source URLs and compare the contract before the interview. The following behaviour was checked against Candidate API v1.0.0 and the 15-case archive on 19 November 2026.

- [OpenAPI contract](https://167.172.96.156.sslip.io/openapi.json)
- [Public case archive for preparation](https://167.172.96.156.sslip.io/history.json)

Use the supplied HTTPS base URL and bearer authentication for the live session. Load live precedents from authenticated `GET /history/cases`. The spec’s server example uses HTTP. Keep credentials on HTTPS. If public downloads are unavailable, use the pinned copies when available and keep any locally invented fixture explicitly labelled synthetic.

| Operation | Behaviour the implementation must preserve |
|---|---|
| GET /events | Poll in cursor order. Pass the response’s next_cursor as after on the next poll. Gaps are valid. Empty results echo the cursor. The event envelope has an ID, cursor, type, channel, nullable actor, simulation time and open-ended payload. |
| POST /cases | Requires title and urgency. Valid urgency values are low, medium, high and emergency. Description and property_id are optional. Every successful POST creates a case and automatically informs the landlord. Store the returned case ID. |
| PATCH /cases/{id} | Send at least one changed field from title, description, urgency or status. The API emits an update event. Property ID cannot be patched through this operation. |
| POST /actors/{id}/messages | Send a body and optionally a subject to a known actor. HTTP 202 means accepted for delivery. Replies arrive asynchronously. Acknowledgements can themselves trigger replies. |
| GET /contractors | Returns current contractor IDs, names, trades, ratings and availability. Historical assignments provide context. Select only a currently listed ID. |
| POST /work-orders | Assign one contractor to an existing case. HTTP 201 returns pending and engages the contractor. Wait for work_order.accepted or work_order.declined. |
| PATCH /work-orders/{id} | Record an evidenced quote, approval or agreed slot. The write records an agreement already reached. Write the agreed slot on an accepted order before expecting visit confirmation. |

**First-live-run unknown:** the spec leaves event payload keys open. Inspect actual examples supplied by Dwelly and the first authenticated feed. Decode known payloads at the API boundary. Missing identifiers, ambiguous links and unknown event types must remain inspectable. The published API lists neither a case lookup endpoint nor a case-create idempotency key.

## 2. Fix the graph and component boundaries

One worker processes a session’s events in order. Give each maintenance issue a stable local ID before a remote case exists. One property or actor can have several issues. Prefer explicit references from the event, then unambiguous conversation evidence. Hold ambiguous replies for review. Separate the session’s poll cursor from an individual issue’s workflow state.

| Graph node | Responsibility and next edge |
|---|---|
| Ingest | Persist an event batch and its next_cursor in one SQLite transaction. Unique key is session plus event ID. On restart drain unfinished events. Empty polls back off. |
| Route | Identify the actor, issue and purpose. Known system echoes and acknowledgements with no new facts end the turn. Attach material replies or corrections to the issue. An unrelated new report gets its own issue. |
| Assess | One structured model call reads the issue’s evidence to date, outstanding question, existing case and relevant archive guidance. Return an allowed decision, urgency where applicable, supporting event IDs and a short reason. |
| Validate | TypeScript checks the decision shape, evidence references, known actor and case IDs, permitted transition and whether the proposed action would change anything. An urgent issue with sufficient evidence can be opened immediately even if secondary details are missing. If an emergency also needs human action, surface that explicitly. |
| Act | Dispatch exactly the selected action through a typed client. Open a case, patch the linked case, ask one question, record an out-of-scope disposition, wait or flag for review. Continued actions must follow from a recorded result or new evidence. |
| Checkpoint | Atomically record the result, updated issue state, trace and event completion locally. A question moves the issue to awaiting reply. A material reply resumes assessment. An issue requiring review stays visible while other issues can progress. |

Use explicit typed node functions and a transition table or exhaustive switch. Start with strict TypeScript, native fetch, SQLite, one model provider, runtime validation of external data and the Node test runner. Pin the Node version used for rehearsal and test the chosen SQLite binding on that version. The lead owns package choices and records a one-line rationale for each dependency.

**Shared interfaces to agree before dispatch.** Names below are internal. They do not claim additional API fields.

- `WorldClient` exposes poll, readHistory, createCase, patchCase and sendMessage. Live and replay implementations satisfy the same interface. Add work-order operations with the extension.
- `assess(issue, evidence, precedents) → Decision` performs no writes. Decisions are a tagged union: ask, open, update, wait, outOfScope or review. Keep urgency independent of disposition. A non-repair can be low urgency and follow an out-of-scope route.
- `processEvent(event, dependencies)` is the shared graph entry point for replay and live. Persist original observations, outstanding question, remote IDs, action attempts and decisions. A correction supersedes old evidence while retaining the audit trail.
- `TraceEntry` carries session, event/cursor, local issue ID, remote ID when known, node, edge, evidence IDs, concise reason and action outcome. Exclude credentials. The operator should be able to answer “why did this change?” from one trace.

## 3. Dispatch work in this order

The lead owns the shared types, package manifest, lockfile, CLI wiring and merges. Publish the interfaces and one example of each input/output before dispatch. Workers can use separate branches or disjoint file areas. Raise a shared-contract change with the lead before changing it. Keep agent briefs, actual checks and review notes available for the interview.

| Task and owner | Start after | Work and ownership | Return when |
|---|---|---|---|
| 0. Lead — bootstrap | Immediately | Create the TS project, pin runtime, snapshot inputs, settle interfaces above, select one model provider, record fixture split and define CLI commands. | Clean install, build, typecheck and one sample test run. Each worker has the same contract. |
| A. API and event adapter | 0 | Own src/world and adapter tests. Implement live client, envelope validation, error mapping and a replay client that records writes and returns contract-shaped responses. Keep payload decoding in one place. | Tests cover cursor gaps, empty poll, 201/202 responses, invalid responses and expired credentials. |
| B. Graph and state | 0 | Own src/graph, src/store and their tests. Implement routing, checkpoints, action journal, effect dispatch and trace persistence. Use a stub decision function and client until integration. | Restart, duplicate delivery, ambiguous writes, unrelated issues and same-issue updates pass deterministic tests. |
| C. Triage and evaluation | 0 | Own src/triage and eval fixtures. Read the archive, derive a short rubric from development cases, implement model decisions and validate evidence. Build chronological replay inputs and expected checks. | Returns real model results on held-out inputs plus reproducible scripted fixtures. Clearly distinguish model errors from adapter or graph errors. |
| D. Lead — integrate MVP | A, B, C | Wire one graph to both clients. Add CLI, end-to-end tests and a short README. Review actual diffs, inspect traces, rerun tests independently and fix integration failures. | Meets the MVP acceptance criteria below in a clean checkout. |
| E. Contractor extension | D passes | Extend the graph with assignment, approval, appointment and stakeholder updates. Preserve all MVP regressions. | The extension scenarios below pass; otherwise report the last verified capability. |

A, B and C can run concurrently. At each handoff return changed files, commands run, results, assumptions, and one trace or failing example demonstrating the behaviour. The lead resolves interface mismatches in the common contract. Preserve a runnable MVP checkpoint before starting E.

## 4. Make restart and write failures predictable

1. Use one SQLite database per simulation session or equivalent session-scoped keys. Bind the database to the session locally so a new token after a reset cannot resume an old cursor or old case IDs. Keep secrets out of arguments, traces and git. Enforce one active writer per session.
2. Save the input event and a stable action intent before sending a write. Mark it in flight before network I/O. After a confirmed response, save the remote ID and result, update issue state and finish the event in a transaction. Resume a queued unsent intent. On restart treat an in-flight intent with no confirmed result as uncertain.
3. For a timeout or disconnect after dispatch, inspect subsequent events for an unambiguous matching result. If the outcome stays unclear, surface it for review and hold dependent writes on that issue. A blind retry can open a second case or send a second message. Local deduplication alone cannot guarantee exactly-once remote effects.
4. On 401 stop and report authentication failure. On a session-ended 403 stop mutations; reads remain available. A confirmed 429 defers the write with bounded backoff. For validation errors capture the API error, details and hint; for missing resources flag the stale reference. Bound retries for transient reads. Persist deferred work. Avoid spinning on empty polls, invalid model output or acknowledgements.
5. Message bodies are observations. Keep system instructions, allowed actions, IDs and spending authority under application control. If the model output fails validation, allow one bounded correction and then surface the issue for review with zero writes.

## 5. Prove the MVP before adding features

Expose these commands as the operator interface. The argument syntax is part of this proposed build.

| Command | Expected result |
|---|---|
| npm ci && npm run build && npm test | Reproducible installation and deterministic tests with no token, model key or network calls. Include strict typechecking in the build. |
| npm run replay -- case-04 | Offline scripted replay through the real graph and recording client. Print issue ID and trace; show one case creation followed by an update. |
| npm run eval | Run the real provider on the reserved archive fixtures. Use no Dwelly mutations. Report per-case decisions, expected outcome, under-triage and failures with evidence. |
| npm run live | Read credentials from the environment, load authenticated history, poll from the session checkpoint and process the live feed. Fail clearly on missing configuration. |
| npm run inspect -- <issue-id> | Show the chronological evidence, chosen edges, writes, remote IDs, outstanding questions and any uncertain result for that issue. |

**Archive discipline.** Reserve case IDs before drafting prompts or deriving the rubric. For example, develop on case-04 and reserve cases 02, 05, 09 and 11 for evaluation. Exclude reserved case text, titles, labels and derived examples from model guidance and retrieval during evaluation. Give the model only the observations available by the turn under test. Keep final outcomes and future correspondence in the scorer. When evaluating a later reply that depends on a historical manager question, include the preceding exchange as observed context or construct a separate interactive fixture. Do not feed recorded manager decisions to the model as evidence of what it should choose next.

| Acceptance scenario | Executable assertion |
|---|---|
| Clear report | Sufficient evidence produces one valid case POST with required title and urgency. Record returned ID. Opening causes zero redundant landlord announcements. |
| Vague report, reply after restart | Ask one question that can change the decision. Resume the original issue and use the answer. Re-delivering either event adds no write. |
| case-04, worsening leak | Evaluate the early contained report using early facts. When later evidence shows the flat below is affected, record high urgency on the same case. Exactly one creation across the run. |
| Contrasting archive outcomes | Score case-02 as medium despite the tenant’s casual language. For case-05 recognise emergency and external escalation; make no claim that an external call was placed. For case-11 recognise an out-of-scope noise complaint and issue zero work orders. |
| Interleaved events and echoes | A cursor gap loses no event. Two issues at one property stay distinct. A system echo, a polite acknowledgement, an unknown event and an ambiguous reply trigger no unintended messages or cases. |
| Delivery uncertainty and reset | Inject a timeout after the fake server creates the case; restart the worker. Remote count stays at one and the unresolved result is visible until reconciled. A fresh world starts with separate state. |
| Bad model output or failed write | Unknown IDs and malformed decisions never reach the API. Exercise authentication, ended session and rate limits. No failed action is reported as successful. |

The replay proves plumbing with a scripted decision provider. The held-out eval tests judgement with the real provider. Report both independently with actual pass counts. A live-token end-to-end run remains an interview-day verification until one has actually been performed.

## 6. Extend to contractor coordination and updates

After the MVP passes, attach the contractor branch to a confirmed open case. Skip this branch for externally escalated, out-of-scope or otherwise unsuitable cases.

1. Select from GET /contractors using relevant trade, urgency and availability. Use rating as a tie-break where appropriate. Record the evidence and alternatives. If there is no suitable candidate, flag for review. Archive case-12 is a useful fixture: its historical locksmith has no contractor ID.
2. POST one work order for the chosen contractor. Persist its ID and pending status. Do not dispatch a second order while the first is pending. A decline permits a different eligible contractor. An acceptance moves the issue to coordination.
3. Extract the actual quote and any landlord spending authority from attributable messages. If approval is needed, request it and await the reply. Record evidenced cost and approval through PATCH. Handle changed prices or conditions by checking whether the existing authority still covers them.
4. Coordinate availability with affected parties. Write the agreed slot to the accepted order; await contractor confirmation. Send useful tenant and landlord updates at material changes. A booking, a confirmed visit and a completed repair are separate facts. Resolve a case only with evidence of resolution.
5. Add fixtures for contractor decline and reassignment, a quote above the landlord’s limit, an agreed slot followed by confirmation, and silence or a changed appointment. Each fixture asserts the resulting API actions and messages as well as the final state.

## 7. Rehearse the interview handoff

From a clean checkout, run the offline suite, replay case-04, inspect its trace, and run the model eval. On the interview laptop, check HTTPS access, model credentials and screen sharing. Put the exact commands and environment-variable names in the README. Retain the graph diagram, dependency rationale and actual coding-agent briefs.

When the interviewers introduce a requirement or a live failure, identify the first wrong edge in the trace. Capture the smallest redacted event sequence that reproduces it. Add one executable expectation, run it against the old behaviour, brief the coding agent on the failing evidence, inspect the diff, then rerun the focused test and the suite. For a judgement failure, also rerun the real-model eval. Record what remains unverified and why.

**Final handoff from the lead:** runnable commit, install and run commands, MVP and extension status, test and eval results, one inspectable trace, and any behaviour requiring a live token to confirm.
