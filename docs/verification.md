# Verification — 19 November 2026

Runtime: Node 22.14.0; native SQLite 3.47.2. API snapshot: Candidate API 1.0.0 with 15 archive cases. Package installation is lockfile-pinned; final dependency audit reported zero vulnerabilities.

Executed in workspace:

- `npm ci --offline --ignore-scripts`: passed using cached pinned packages.
- `npm run build`: strict TypeScript compilation passed.
- `npm test`: **52 passed, 0 failed, 0 skipped**, without credentials or external network requests.
- Case-04 through the real graph/recording client across restart: one case creation, one update to high on that same ID, zero landlord announcements; repeat events add no writes.
- Replay plus CLI `inspect`: verified matching remote ID, high final urgency and two confirmed action records. Saved inspectable artifact: `docs/case04-trace.json`.
- `npm run eval`: configuration check correctly fails with missing OPENAI_API_KEY. **Real-provider evaluation not run; no model pass count claimed.**
- `npm run live`: configuration check correctly fails with missing DWELLY_TOKEN. **Authenticated end-to-end session not run.**

Offline test split: 2 bootstrap; 18 graph/recovery/routing; 1 archive integration; 8 triage/validation/evaluation-isolation; 17 API/replay; 6 contractor coordination = 52. Injected model decisions test validation/plumbing, not real-model judgment.

MVP checkpoint: 62500df. Contractor extension adds fixture-verified selection, reassignment, approval, slot agreement, confirmation and completion with persistent effects. It remains a partial live extension: natural-language fact extraction, real feed payload mapping, scheduling solicitation and automatic extension rate-limit retries are not implemented. See `coordination-contract.md` for exact boundaries. All original observations are retained and uncertain effects remain visible rather than being retried blindly.

Review fixes include preserving the stable local issue across a crash after routing, separating an unrelated report while another question awaits reply, refusing unsupported closure/emergency output, validating correction references, and replaying confirmed coordination effects without duplicate writes.

Clean committed-source verification: exported commit `1056d26` with `git archive` into an empty temporary directory, then ran cached `npm ci`, strict build, the full test suite and `npm run replay -- case-04`. Result: **52/52 tests passed and replay passed**, with no workspace files or existing database reused.

## Assessment v2 follow-up

See `assessment-v2.md` for the newer implementation and evidence. Strict schema generation, application-bound execution IDs, exact bounded correction and separated failure scoring are implemented. **103 deterministic tests pass.** Three models were evaluated on four archive and four fresh synthetic cases each: all 24 responses passed contract validation and graph replay; judgment scores are reported separately. Earlier missing-credential statements above describe the original build only. Live Dwelly verification remains unperformed.
