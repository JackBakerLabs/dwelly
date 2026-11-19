import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient, WorldError } from '../src/world/index.js';
import type { Assessor, Decision, WorldEvent } from '../src/types.js';
const event = (id: string, cursor: number, body: string, payload: Record<string, unknown> = {}): WorldEvent => ({ id, cursor, type: 'message.received', channel: 'email', actor: { id: 'tenant', role: 'tenant', name: 'Tenant' }, sim_ms: cursor, occurred_at: '2026-11-19T12:00:00Z', payload: { body, ...payload } });
const open: Assessor = async (i) => ({ kind: 'open', title: 'Leaking pipe', urgency: 'low', evidenceIds: i.evidence.map(e => e.eventId), reason: 'Water contained' });
function setup(assess: Assessor = open) { const store = new Store({ path: ':memory:', session: 'test' }); const world = new ReplayWorldClient(); return { store, world, graph: new Graph({ store, world, assess }) }; }
test('clear report opens once, records remote ID, emits no landlord message', async () => { const { store, world, graph } = setup(); try {
    const e = event('1', 3, 'Pipe is dripping');
    await graph.processEvent(e);
    await graph.processEvent(e);
    assert.equal(world.cases.size, 1);
    assert.equal(world.writes.length, 1);
    assert.ok(store.issues()[0]?.remoteCase?.id);
    assert.equal(store.cursor(), 3);
}
finally {
    store.close();
} });
test('same conversation updates same case; unrelated reports remain distinct', async () => { const assess: Assessor = async (i) => i.remoteCase ? { kind: 'update', caseId: i.remoteCase.id, patch: { urgency: 'high' }, evidenceIds: [i.evidence.at(-1)!.eventId], reason: 'Damage below' } : open(i, i.evidence, []); const { store, world, graph } = setup(assess); try {
    await graph.processEvent(event('1', 2, 'Tiny contained leak', { conversation_id: 'leak' }));
    await graph.processEvent(event('2', 9, 'Flat below now wet', { conversation_id: 'leak' }));
    await graph.processEvent(event('3', 12, 'Door broken', { conversation_id: 'door', new_issue: true }));
    assert.equal(world.cases.size, 2);
    assert.equal(world.writes.filter(w => w.operation === 'patchCase').length, 1);
    assert.equal(store.issues()[0]?.remoteCase?.urgency, 'high');
    assert.equal(store.issues().length, 2);
}
finally {
    store.close();
} });
test('question survives restart and material reply resumes original issue without duplicate delivery', async () => { const dir = mkdtempSync(join(tmpdir(), 'dwelly-')); const path = join(dir, 'state.sqlite'); const world = new ReplayWorldClient(); const assess: Assessor = async (i) => i.evidence.length === 1 ? { kind: 'ask', actorId: i.actorId, question: 'Where is the water coming from?', evidenceIds: ['1'], reason: 'Need location' } : open(i, i.evidence, []); let store = new Store({ path, session: 's' }); try {
    await new Graph({ store, world, assess }).processEvent(event('1', 4, 'There is a problem'));
    store.close();
    store = new Store({ path, session: 's' });
    const graph = new Graph({ store, world, assess });
    await graph.processEvent(event('2', 8, 'Kitchen pipe is dripping'));
    await graph.processEvent(event('1', 4, 'There is a problem'));
    await graph.processEvent(event('2', 8, 'Kitchen pipe is dripping'));
    assert.equal(store.issues().length, 1);
    assert.equal(world.writes.length, 2);
    assert.equal(store.issues()[0]?.outstandingQuestion, undefined);
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('unknown events, acknowledgements, system echoes and ambiguous replies cause no writes', async () => { const { store, world, graph } = setup(async (i) => ({ kind: 'ask', actorId: i.actorId, question: 'Where?', reason: 'Need location', evidenceIds: [i.evidence.at(-1)!.eventId] })); try {
    await graph.processEvent(event('1', 1, 'A problem', { new_issue: true }));
    await graph.processEvent(event('2', 2, 'Another problem', { new_issue: true }));
    const count = world.writes.length;
    await graph.processEvent(event('3', 3, 'It is worse'));
    await graph.processEvent(event('4', 4, 'Thanks!'));
    await graph.processEvent({ ...event('5', 5, 'echo'), type: 'case.created', channel: 'system', actor: null });
    await graph.processEvent({ ...event('6', 6, 'unknown'), type: 'new.unspecified' });
    assert.equal(world.writes.length, count);
    assert.ok(store.traces().some(t => t.edge === 'review'));
}
finally {
    store.close();
} });
test('timeout after server creation remains uncertain and is not retried after restart', async () => { const dir = mkdtempSync(join(tmpdir(), 'dwelly-')); const path = join(dir, 'state.sqlite'); const world = new ReplayWorldClient(); const original = world.createCase.bind(world); world.createCase = async (input) => { await original(input); throw new WorldError('Connection lost', undefined, true); }; let store = new Store({ path, session: 's' }); try {
    await new Graph({ store, world, assess: open }).processEvent(event('1', 4, 'Pipe leak'));
    store.close();
    store = new Store({ path, session: 's' });
    await new Graph({ store, world, assess: open }).processEvent(event('1', 4, 'Pipe leak'));
    assert.equal(world.cases.size, 1);
    assert.equal(store.intents()[0]?.state, 'uncertain');
    assert.equal(store.issues()[0]?.status, 'review');
    assert.match(JSON.stringify(store.inspect(store.issues()[0]!.id)), /uncertain/);
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('inflight journal recovered to uncertain; session identity and writer lock enforced', async () => { const dir = mkdtempSync(join(tmpdir(), 'dwelly-')); const path = join(dir, 'state.sqlite'); let store = new Store({ path, session: 's', identity: 'hash' }); try {
    assert.throws(() => new Store({ path, session: 's' }), /active writer/);
    await new Graph({ store, world: new ReplayWorldClient(), assess: open }).processEvent(event('1', 1, 'Leak'));
    const intent = store.intents()[0]!;
    intent.state = 'inflight';
    store.putIntent(intent);
    store.close();
    assert.throws(() => new Store({ path, session: 'reset', identity: 'new-hash' }), /binding mismatch/);
    store = new Store({ path, session: 's', identity: 'hash' });
    assert.equal(store.intents()[0]?.state, 'uncertain');
    assert.equal(store.issues()[0]?.status, 'review');
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('invalid model output never reaches API', async () => { const { store, world, graph } = setup(async () => ({ kind: 'open', title: 'Bogus', urgency: 'low', evidenceIds: ['invented'], reason: 'bad' })); try {
    await graph.processEvent(event('1', 1, 'Leak'));
    assert.equal(world.writes.length, 0);
    assert.equal(store.issues()[0]?.status, 'review');
}
finally {
    store.close();
} });
test('429 defers durably with bounded retries, 401 and 403 stop mutations', async () => { for (const status of [429, 401, 403]) {
    const { store, world, graph } = setup();
    world.createCase = async () => { throw new WorldError('failure', status, false, 1000); };
    try {
        if (status === 429) {
            await graph.processEvent(event('1', 1, 'Leak'));
            assert.equal(store.intents()[0]?.state, 'deferred');
            await graph.drain();
            assert.equal(store.intents()[0]?.attempts, 1);
        }
        else {
            await assert.rejects(graph.processEvent(event('1', 1, 'Leak')));
            assert.equal(store.intents()[0]?.state, 'failed');
            assert.ok(store.meta('mutationsStopped'));
        }
        assert.equal(world.cases.size, 0);
    }
    finally {
        store.close();
    }
} });
test('ingest transaction rolls back invalid cursor and preserves gaps', () => { const store = new Store({ path: ':memory:', session: 's' }); try {
    store.ingest({ events: [event('1', 4, 'one'), event('2', 11, 'two')], next_cursor: 11 });
    assert.equal(store.pending().length, 2);
    assert.throws(() => store.ingest({ events: [event('3', 14, 'three')], next_cursor: 13 }));
    assert.equal(store.cursor(), 11);
    assert.equal(store.event('3'), undefined);
}
finally {
    store.close();
} });
test('unlinked follow-up on active issue held, read-only inspection bypasses credential and writer lock', async () => { const dir = mkdtempSync(join(tmpdir(), 'dwelly-')); const path = join(dir, 'state.sqlite'); const store = new Store({ path, session: 's', identity: 'token-hash' }); try {
    const world = new ReplayWorldClient();
    const graph = new Graph({ store, world, assess: open });
    await graph.processEvent(event('1', 1, 'Pipe leak'));
    await graph.processEvent(event('2', 2, 'It is worse'));
    assert.equal(world.writes.length, 1);
    assert.equal(store.reviewEvents().length, 1);
    const reader = new Store({ path, session: 's', readOnly: true });
    try {
        assert.equal(reader.issues().length, 1);
        assert.equal(reader.inspect(store.issues()[0]!.id).actions.length, 1);
    }
    finally {
        reader.close();
    }
}
finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('new evidence cancels deferred action before any stale retry', async () => { const { store, world, graph } = setup(); world.createCase = async () => { throw new WorldError('Rate limited', 429, false, 60000); }; try {
    await graph.processEvent(event('1', 1, 'Tiny leak', { conversation_id: 'leak' }));
    await graph.processEvent(event('2', 2, 'Now flooding', { conversation_id: 'leak' }));
    assert.equal(store.intents()[0]?.state, 'failed');
    assert.equal(store.issues()[0]?.status, 'review');
    await graph.drain();
    assert.equal(store.intents()[0]?.attempts, 1);
}
finally {
    store.close();
} });
test('correction to foreign or missing evidence is held for review', async () => { const { store, world, graph } = setup(); try {
    await graph.processEvent(event('1', 1, 'Leak', { conversation_id: 'leak' }));
    await graph.processEvent(event('2', 2, 'Correction', { conversation_id: 'leak', supersedes: 'other-issue-event' }));
    assert.equal(world.writes.length, 1);
    assert.equal(store.issues()[0]?.status, 'review');
}
finally {
    store.close();
} });
test('persisted queued unsent intent is dispatched once', async () => { const { store, world, graph } = setup(); try {
    const e = event('1', 1, 'Leak');
    store.ingest({ events: [e], next_cursor: 1 });
    store.putIssue({ id: 'local', session: 'test', actorId: 'tenant', status: 'active', evidence: [{ eventId: '1', cursor: 1, body: 'Leak', actor: e.actor, occurredAt: e.occurred_at }] });
    const decision: Decision = { kind: 'open', title: 'Leak', urgency: 'low', reason: 'Contained leak', evidenceIds: ['1'] };
    store.putIntent({ id: 'a', eventId: '1', issueId: 'local', decision, state: 'queued', attempts: 0 });
    await graph.drain();
    await graph.drain();
    assert.equal(world.writes.length, 1);
    assert.equal(store.intents()[0]?.state, 'confirmed');
}
finally {
    store.close();
} });
test('explicit reconciliation uses uniquely matching persisted case.created event and sends no retry', async () => { const { store, world, graph } = setup(); const create = world.createCase.bind(world); world.createCase = async (input) => { await create(input); throw new WorldError('Timeout', undefined, true); }; try {
    await graph.processEvent(event('1', 1, 'Leak'));
    const remote = [...world.cases.values()][0]!;
    const observed = { ...event('2', 2, 'created'), type: 'case.created', channel: 'system' as const, actor: null, payload: { case: remote } };
    await graph.processEvent(observed);
    const action = store.intents()[0]!;
    store.reconcileCase(action.id, '2');
    assert.equal(store.intents()[0]?.state, 'confirmed');
    assert.equal(store.issues()[0]?.remoteCase?.id, remote.id);
    assert.equal(world.writes.length, 1);
    assert.equal(store.traces().at(-1)?.edge, 'reconciled');
    assert.throws(() => store.reconcileCase(action.id, '2'));
}
finally {
    store.close();
} });
test('reconciliation rejects partial or mismatched creation observations', async () => { const { store, world, graph } = setup(); const create = world.createCase.bind(world); world.createCase = async (input) => { await create(input); throw new WorldError('Timeout', undefined, true); }; try {
    await graph.processEvent(event('1', 1, 'Leak'));
    const remote = [...world.cases.values()][0]!;
    await graph.processEvent({ ...event('2', 2, 'created'), type: 'case.created', channel: 'system', actor: null, payload: { case: { ...remote, title: 'Other leak' } } });
    assert.throws(() => store.reconcileCase(store.intents()[0]!.id, '2'), /does not match/);
    assert.equal(store.intents()[0]?.state, 'uncertain');
}
finally {
    store.close();
} });
test('extension event hook completes durable events and leaves failures pending for restart', async () => { const { store, world } = setup(); let fail = true; const graph = new Graph({ store, world, assess: open, beforeEvent: async (e) => { if (e.type !== 'work_order.accepted')
        return false; if (fail)
        throw new Error('Extension failed'); return true; } }); try {
    const e = { ...event('1', 1, 'accepted'), type: 'work_order.accepted', actor: null };
    await assert.rejects(graph.processEvent(e));
    assert.equal(store.pending().length, 1);
    fail = false;
    await graph.drain();
    assert.equal(store.pending().length, 0);
    assert.equal(world.writes.length, 0);
}
finally {
    store.close();
} });
test('restart after routing reuses durable local issue before any action intent', async () => { const { store, world, graph } = setup(); try {
    const e = event('1', 1, 'Pipe leak');
    store.ingest({ events: [e], next_cursor: 1 });
    store.putIssue({ id: 'stable-local-id', session: 'test', actorId: 'tenant', status: 'active', evidence: [{ eventId: e.id, cursor: e.cursor, actor: e.actor, body: 'Pipe leak', occurredAt: e.occurred_at }] });
    await graph.drain();
    assert.equal(store.issues().length, 1);
    assert.equal(store.issues()[0]!.id, 'stable-local-id');
    assert.equal(world.cases.size, 1);
}
finally {
    store.close();
} });
test('unrelated window report does not answer outstanding leak question', async () => { const { store, world, graph } = setup(async (i) => ({ kind: 'ask', actorId: i.actorId, question: 'Where is the problem?', evidenceIds: [i.evidence.at(-1)!.eventId], reason: 'Need location' })); try {
    await graph.processEvent(event('1', 1, 'A pipe is leaking'));
    await graph.processEvent(event('2', 2, 'Bedroom window is broken'));
    assert.equal(store.issues().length, 2);
    assert.equal(store.issues()[0]!.evidence.length, 1);
    assert.equal(world.writes.length, 2);
}
finally {
    store.close();
} });
