import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedActions, buildAssessmentContext, bindProposal, proposalResponseSchema } from '../src/triage/proposal.js';
import { createModelAssessor, runEvaluation, type AssessmentDiagnostic } from '../src/triage/index.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph } from '../src/graph/index.js';
import { Store } from '../src/store/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import type { Issue, HistoryCase, WorldEvent } from '../src/types.js';
const issue: Issue = { id: 'local-issue', session: 's', actorId: 'tenant-1', status: 'active', evidence: [{ eventId: 'e1', cursor: 1, actor: { id: 'tenant-1', role: 'tenant', name: 'Tenant' }, body: 'Contained leak', occurredAt: '2026-11-19T00:00:00Z' }] };
const base = { scope:'maintenance', evidenceIds: ['e1'], reason: 'Observed fact', humanAction: null };
const open = { ...base, kind: 'open', title: 'Leak', description: null, urgency: 'medium' };
const linked: Issue = { ...issue, remoteCase: { id: 'remote-1', title: 'Leak', description: null, urgency: 'medium', property_id: null, status: 'open', created_at: 'now', updated_at: 'now' } };
const response = (decision: unknown) => new Response(JSON.stringify({ model: 'returned-model', choices: [{ message: { content: JSON.stringify({ decision }) } }] }));
test('explicit context and action permissions separate local and remote state', () => {
    const c = buildAssessmentContext(issue, issue.evidence, []);
    assert.equal(c.remoteCase, null);
    assert.equal(c.localIssueId, 'local-issue');
    assert.equal(c.outstandingQuestion, null);
    assert.ok(!c.allowedActions.includes('update'));
    assert.ok(!allowedActions(linked).includes('open'));
    assert.deepEqual(allowedActions({ ...issue, status: 'review' }), ['wait', 'review']);
    assert.deepEqual(allowedActions({ ...linked, remoteCase: { ...linked.remoteCase!, status: 'resolved' } }), ['wait', 'review']);
    const corrected = [...issue.evidence, { ...issue.evidence[0]!, eventId: 'e2', supersedes: 'e1' }];
    assert.deepEqual(buildAssessmentContext(issue, corrected, []).currentObservations.map(e => e.eventId), ['e2']);
});
test('binding chooses only known recipients and remote IDs, never converts unavailable actions', () => {
    const ask = bindProposal(issue, { decision: { ...base, kind: 'ask', question: 'Where is the leak?' } });
    assert.equal(ask.kind, 'ask');
    if (ask.kind === 'ask')
        assert.equal(ask.actorId, 'tenant-1');
    const update = { ...base, kind: 'update', patch: { title: null, description: null, urgency: 'high', status: null } };
    const d = bindProposal(linked, { decision: update });
    assert.deepEqual(d, { scope:'maintenance',evidenceIds: ['e1'], reason: 'Observed fact', kind: 'update', caseId: 'remote-1', patch: { urgency: 'high' } });
    assert.throws(() => bindProposal(issue, { decision: update }), /unavailable/);
    assert.throws(() => bindProposal(linked, { decision: open }), /unavailable/);
    assert.throws(() => bindProposal(linked, { decision: { ...update, caseId: 'injected' } }), /Unrecognized key/);
    assert.throws(() => bindProposal(issue, { decision: { ...base, kind: 'ask', actorId: 'injected', question: 'Where?' } }), /Unrecognized key/);
    assert.throws(() => bindProposal(linked, { decision: { ...update, patch: { title: null, description: null, urgency: null, status: null } } }), /Empty patch/);
    assert.throws(() => bindProposal(issue, { decision: { ...open, urgency: null } }));
});
test('strict generation schema and runtime schema share branches and required nullable fields', () => {
    for (const i of [issue, linked, { ...issue, status: 'review' as const }]) {
        const { schema, json } = proposalResponseSchema(i);
        assert.equal(json.type, 'object');
        assert.equal(json.additionalProperties, false);
        assert.deepEqual(json.required, ['decision']);
        function check(n: any) { if (n && typeof n === 'object') {
            if (n.type === 'object') {
                assert.equal(n.additionalProperties, false);
                assert.deepEqual([...n.required].sort(), Object.keys(n.properties).sort());
            }
            for (const v of Object.values(n))
                check(v);
        } }
        check(json);
        assert.equal(schema.safeParse({ decision: open }).success, i === issue);
        const text = JSON.stringify(json);
        assert.ok(!text.includes('caseId'));
        assert.ok(!text.includes('actorId'));
    }
});
test('single precise correction includes rejected assistant message and exact field error', async () => {
    let calls = 0;
    const diagnostics: AssessmentDiagnostic[] = [];
    const assess = createModelAssessor({ apiKey: 'fake', onDiagnostic: d => diagnostics.push(d), fetch: async (_url, init) => {
            calls++;
            const req = JSON.parse(String(init!.body));
            if (calls === 1)
                return response({ ...open, reason: undefined });
            assert.equal(req.messages[2].role, 'assistant');
            assert.equal(JSON.parse(req.messages[2].content).decision.reason, undefined);
            const correction = JSON.parse(req.messages[3].content);
            assert.ok(correction.errors.some((e: any) => e.path.includes('reason')));
            assert.equal(correction.remoteCaseExists, false);
            return response(open);
        } });
    assert.equal((await assess(issue, issue.evidence, [])).kind, 'open');
    assert.equal(calls, 2);
    assert.equal(diagnostics[1]!.correctionSucceeded, true);
    assert.equal(diagnostics[1]!.returnedModel, 'returned-model');
    assert.ok(diagnostics[0]!.schemaHash);
});
test('unavailable action receives actionable correction and review holds make zero model calls', async () => {
    let calls = 0;
    const assess = createModelAssessor({ apiKey: 'fake', fetch: async (_url, init) => { calls++; if (calls === 1)
            return response({ ...base, kind: 'update', patch: { title: null, description: null, urgency: 'high', status: null } }); const req = JSON.parse(String(init!.body)); assert.equal(JSON.parse(req.messages[3].content).errors[0].code, 'ACTION_NOT_ALLOWED'); return response(open); } });
    assert.equal((await assess(issue, issue.evidence, [])).kind, 'open');
    assert.equal(calls, 2);
    assert.equal((await assess({ ...issue, status: 'review' }, issue.evidence, [])).kind, 'review');
    assert.equal(calls, 2);
});
test('unsupported provider schema is a single provider failure, not corrected or counted under-triage', async () => {
    let calls = 0;
    const history = JSON.parse(readFileSync('snapshots/2026-11-19/history.json', 'utf8')).cases as HistoryCase[];
    const assess = createModelAssessor({ apiKey: 'fake', fetch: async () => { calls++; return new Response('{}', { status: 400 }); } });
    const result = await runEvaluation(history, assess);
    assert.equal(calls, 4);
    assert.equal(result.providerFailures, 4);
    assert.equal(result.underTriage, 0);
    assert.equal(result.unscoredUrgency, 4);
    assert.equal(result.passed, 0);
});
test('model proposal graph resumes clarification then opens and updates the same case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwelly-proposal-'));
    const path = join(dir, 's.sqlite');
    let store = new Store({ path, session: 's' });
    const world = new ReplayWorldClient();
    let calls = 0;
    const assess = createModelAssessor({ apiKey: 'fake', fetch: async (_url, init) => {
            calls++;
            const c = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
            const evidenceIds = [c.currentObservations.at(-1).eventId];
            if (calls === 1)
                return response({ ...base, evidenceIds, kind: 'ask', question: 'Where is water coming from?' });
            if (calls === 2) {
                assert.equal(c.remoteCase, null);
                assert.equal(c.outstandingQuestion,null);assert.ok(c.lastQuestion);
                return response({ ...open, evidenceIds });
            }
            assert.ok(c.remoteCase);
            assert.ok(!c.allowedActions.includes('open'));
            return response({ ...base, evidenceIds, kind: 'update', patch: { title: null, description: null, urgency: 'high', status: null } });
        } });
    const event = (n: number, body: string): WorldEvent => ({ id: 'event' + n, cursor: n * 3, type: 'message.received', channel: 'email', actor: issue.evidence[0]!.actor, sim_ms: n, occurred_at: '2026-11-19T00:00:00Z', payload: { body, conversation_id: 'thread' } });
    try {
        await new Graph({ store, world, assess }).processEvent(event(1, 'A problem with water'));
        store.close();
        store = new Store({ path, session: 's' });
        const graph = new Graph({ store, world, assess });
        await graph.processEvent(event(2, 'Contained leak from kitchen waste pipe'));
        const id = store.issues()[0]!.remoteCase!.id;
        await graph.processEvent(event(3, 'Water now damaging flat below'));
        await graph.processEvent(event(3, 'Water now damaging flat below'));
        assert.equal(calls, 3);
        assert.equal(store.issues().length, 1);
        assert.equal(store.issues()[0]!.remoteCase!.id, id);
        assert.equal(store.issues()[0]!.urgency, 'high');
        assert.deepEqual(world.writes.map(w => w.operation), ['sendMessage', 'createCase', 'patchCase']);
    }
    finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('fresh fixture labels and other fixture texts stay outside model context; malformed output is not under-triage', async () => {
    const history = JSON.parse(readFileSync('snapshots/2026-11-19/history.json', 'utf8')).cases as HistoryCase[];
    const fixtures = JSON.parse(readFileSync('fixtures/assessment-v2-fresh.json', 'utf8'));
    let calls = 0;
    const assess = createModelAssessor({ apiKey: 'fake', fetch: async (_url, init) => { calls++; const c = JSON.parse(JSON.parse(String(init!.body)).messages[1].content); assert.equal('expected' in c, false); assert.equal(c.currentObservations.length, 1); assert.ok(!JSON.stringify(c.guidance).includes('fresh-')); return response({ ...open, reason: undefined }); } });
    const report = await runEvaluation(history, assess, fixtures);
    assert.equal(calls, 8);
    assert.equal(report.contractFailures, 4);
    assert.equal(report.providerFailures, 0);
    assert.equal(report.underTriage, 0);
    assert.equal(report.unscoredUrgency, 4);
});
