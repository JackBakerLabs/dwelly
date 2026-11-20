# Graph-native contractor coordination

Contractor coordination runs on the graph engagement path only (`src/graph/index.ts` + `src/triage/engagement.ts`). The structured `coordination.*` Coordinator writer is retired. `inspect` may still read legacy `coordination_*` tables from older session databases (read-only).

## Flow

1. Medium/high in-scope cases may draft one exact-trade, explicitly available contractor proposal and send the landlord a single journaled briefing (not a duplicate of case creation's automatic notice).
2. Landlord natural-language decisions (`approve`, `approveIf`, `requestQuote`, `requestAvailability`, `reject`) drive work orders and follow-up questions. Plural wording against several open issues fans out one intent per issue.
3. Contractor replies (quote, availability, decline, visit confirmation, completion) are classified from attributable wording. Booking ≠ confirmed ≠ completed.
4. A slot on an accepted order is offered to the linked tenant for confirmation before `PATCH /work-orders/{id}`. A changed slot returns to the contractor; it is not silently patched.
5. Visit confirmation notifies tenant and landlord. Completion (after recorded visit confirmation) patches the case `resolved` and notifies both parties.
6. A quote or slot change after a booked slot (or visit confirmation) holds for operator review — never an automatic `landlord_approved: false` patch.
7. Decline before hire excludes that contractor and proposes exactly one replacement. Decline of a pending order raises at most one replacement. Silence writes nothing. No second order while one is pending.

Every remote effect (`sendMessage`, `createWorkOrder`, `patchWorkOrder`, `patchCase`) is a journaled intent, resumable from `queued` after restart. Old Decision / channel intent rows remain readable.

## Limitations

Natural-language classification is deliberately narrow (captured phrasings, not a general NLP layer). No model assessor is wired into `live` for landlord/contractor mail in the offline plan. Spending limits and SLAs are never invented. Live contractor behaviour against real (non-fixture) correspondence remains an interview-day check.
