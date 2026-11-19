# API adapter handoff

Assigned: implement the HTTPS live client, conservative event decoder, recording replay client, and deterministic contract/error tests in `src/world` and `tests/world.test.ts` against the pinned Candidate API 1.0.0.

Implemented `LiveWorldClient({baseUrl, token, fetch?, timeoutMs?, readRetries?})`, `ReplayWorldClient({events?, history?})`, `decodeEvent`, and `WorldError(message, status?, uncertain?, retryAfterMs?, details?, hint?)`. Replay exposes `writes` and `cases`. Zod validates request bodies and response envelopes. HTTP redirects are rejected. Reads retry transport/5xx at most three times after the initial attempt; writes never retry. Malformed successful mutation responses, transport failures and 5xx mutations are uncertain. 403 latches mutation closure while reads remain usable. 429 preserves a bounded delay for the persistent graph scheduler. Actor acknowledgement matching is deliberately narrow.

Checks: `npm run build` initially reported only unfinished sibling modules and a CLI type error; no adapter type errors. `node --test dist/tests/world.test.js`: 14 passed, 0 failed. No live token was used. Native fetch is dependency-injected in tests.

Example: replay createCase({title:'Leak',urgency:'low'}) followed by patchCase(returned.id,{urgency:'high'}) records createCase, patchCase, retains one remote case, and returns high urgency.

Assumptions: payload schema is open in the actual API. Recognized message payload strings are body/text/message, plus explicit snake_case/camelCase links documented in decodeEvent. Missing body, actor, unsupported channel or event type remain unknown. Actual live payload examples still require first authenticated feed verification. The adapter never infers a case match from free text.

Follow-up review: moved the 403 mutation latch before body parsing, preserving session-ended semantics even for HTML/plain text responses. Added non-JSON 401/403 tests and filtered undefined replay PATCH fields to match JSON transport behavior. Added bounded transient read retry and non-JSON 5xx uncertainty checks. Final `npm run build` passed, then 14 adapter tests passed.

Contractor extension after MVP checkpoint: both clients now implement CoordinationWorldClient with readContractors, createWorkOrder and patchWorkOrder. Runtime schemas follow pinned directory/order inputs and responses; create validates pending status. Replay accepts a contractors option, exposes workOrders for explicit fixture acceptance/decline events, rejects unknown cases/contractors, and only accepts slot patches for accepted orders. Empty patches and negative/out-of-range estimates fail before effects. `npm run build` passes and all 17 adapter tests pass (14 prior + 3 contractor tests). Exported remoteCaseSchema for explicit operator reconciliation of full case observations.
