import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCase04Replay, case04ScriptedAssessor, createModelAssessor, runEvaluation, selectGuidance, validateDecision } from '../src/triage/index.js';
import type { HistoryCase, Issue } from '../src/types.js';
const history = JSON.parse(readFileSync('snapshots/2026-11-19/history.json', 'utf8')).cases as HistoryCase[];
const issue: Issue = { id: 'local', session: 'test', actorId: 'tenant', status: 'active', evidence: [{ eventId: 'e1', cursor: 1, actor: { id: 'tenant', role: 'tenant', name: 'Tenant' }, body: 'Leak', occurredAt: '2026-11-19T00:00:00Z' }] };
const open = { kind: 'open', title: 'Leak', urgency: 'medium', reason: 'Observed leak', evidenceIds: ['e1'] };
test('strict validation rejects malformed output, unknown evidence and recipients', () => {
    assert.throws(() => validateDecision(issue, { ...open, urgency: 'urgent' }));
    assert.throws(() => validateDecision(issue, { ...open, evidenceIds: ['future'] }));
    assert.throws(() => validateDecision(issue, { ...open, extra: 'not allowed' }));
    assert.throws(() => validateDecision(issue, { kind: 'ask', actorId: 'unknown', question: 'Where?', reason: 'Need location', evidenceIds: ['e1'] }));
    assert.throws(() => validateDecision(issue, { kind: 'update', caseId: 'missing', patch: { urgency: 'high' }, reason: 'Damage', evidenceIds: ['e1'] }));
});
test('superseded facts cannot support decisions', () => {
    const corrected = { ...issue, evidence: [...issue.evidence, { ...issue.evidence[0]!, eventId: 'e2', supersedes: 'e1', body: 'Correction: no leak' }] };
    assert.throws(() => validateDecision(corrected, open));
});
test('held-out cases and target final label excluded from guidance', () => {
    const guidance = selectGuidance(history, 'case-04');
    for (const id of ['case-02', 'case-05', 'case-09', 'case-11', 'case-04'])
        assert.ok(!guidance.some(c => c.id === id));
    assert.ok(guidance.length > 0);
});
test('case04 observations are chronological and scripted decisions use only observed facts', async () => {
    const events = buildCase04Replay(history);
    assert.equal(events.length, 4);
    assert.ok(!JSON.stringify(events[0]).includes('ceiling'));
    const local = { ...issue, conversationId: 'case-04', evidence: events.slice(0, 1).map(e => ({ eventId: e.id, cursor: e.cursor, actor: e.actor, body: String(e.payload.body), occurredAt: e.occurred_at })) };
    const first = await case04ScriptedAssessor(local, local.evidence, []);
    assert.equal(first.kind, 'open');
    if (first.kind === 'open')
        assert.equal(first.urgency, 'medium');
    const last = events.at(-1)!;
    const later = { ...local, remoteCase: { id: 'remote', title: 'Leak', urgency: 'medium' as const, description: null, property_id: null, status: 'open' as const, created_at: 'now', updated_at: 'now' }, evidence: [...local.evidence, { eventId: last.id, cursor: last.cursor, actor: last.actor, body: String(last.payload.body), occurredAt: last.occurred_at }] };
    const next = await case04ScriptedAssessor(later, later.evidence, []);
    assert.equal(next.kind, 'update');
    if (next.kind === 'update') {
        assert.equal(next.caseId, 'remote');
        assert.equal(next.patch.urgency, 'high');
    }
});
test('model has one correction then review, no writes', async () => {
    let calls = 0;
    const assessor = createModelAssessor({ apiKey: 'fake', fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({decision:{ ...open,description:null,humanAction:null, evidenceIds: ['invented'] }}) } }] })); } });
    const result = await assessor(issue, issue.evidence, history);
    assert.equal(calls, 2);
    assert.equal(result.kind, 'review');
});
test('provider failure is bounded and credentials never enter result', async () => {
    let calls = 0;
    const assessor = createModelAssessor({ apiKey: 'secret-for-test', fetch: async () => { calls++; return new Response('failure', { status: 401 }); } });
    const result = await assessor(issue, issue.evidence, history);
    assert.equal(calls, 1);
    assert.equal(result.kind, 'review');
    assert.ok(!JSON.stringify(result).includes('secret-for-test'));
});
test('eval scorer alone sees labels; assessor receives only initial observations and development precedents', async () => {
    let calls = 0;
    const result = await runEvaluation(history, async (i, e, p) => {
        calls++;
        assert.equal(e.length, 1);
        assert.ok(p.every(c => !['case-02', 'case-05', 'case-09', 'case-11'].includes(c.id)));
        assert.equal('classification' in i, false);
        return { kind: 'review', reason: 'Injected fixture, not real judgement', evidenceIds: e.map(x => x.eventId) };
    });
    assert.equal(calls, 4);
    assert.equal(result.total, 4);
    assert.equal(result.passed, 0);
});
test('emergency decisions require human action and unsupported closure is rejected', () => {
    assert.throws(() => validateDecision(issue, { ...open, urgency: 'emergency' }));
    assert.equal(validateDecision(issue, { ...open, urgency: 'emergency', humanAction: 'Immediate human escalation required' }).kind, 'open');
    const linked = { ...issue, remoteCase: { id: 'remote', title: 'Leak', urgency: 'medium' as const, description: null, property_id: null, status: 'open' as const, created_at: 'now', updated_at: 'now' } };
    const close = { kind: 'update', caseId: 'remote', patch: { status: 'resolved' }, reason: 'Completed', evidenceIds: ['e1'] };
    assert.throws(() => validateDecision(linked, close));
    assert.equal(validateDecision({ ...linked, evidence: [{ ...issue.evidence[0]!, body: 'The pipe is repaired, no further leaks.' }] }, close).kind, 'update');
    assert.throws(() => validateDecision({ ...linked, evidence: [{ ...issue.evidence[0]!, body: 'The pipe is not repaired.' }] }, close));
});
test('OpenRouter uses its own endpoint, bearer credential, explicit model and JSON mode', async () => {
    let called = false;
    const assessor = createModelAssessor({apiKey:'mock-openrouter-key',provider:'openrouter',model:'organization/test-model',fetch:async (url,init)=>{
        called=true;
        assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer mock-openrouter-key');
        assert.equal(init?.redirect,'error');
        const body=JSON.parse(String(init?.body));
        assert.equal(body.model,'organization/test-model');
        assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.provider.require_parameters,true);
        return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:{...open,description:null,humanAction:null}})}}]}));
    }});
    assert.equal((await assessor(issue,issue.evidence,[])).kind,'open');
    assert.equal(called,true);
    assert.throws(()=>createModelAssessor({apiKey:'mock',provider:'openrouter'}),/explicit model/);
});
