import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import { proposalFrom } from '../src/triage/index.js';
import { inspectCoordination } from '../src/coordination/index.js';
import type { Assessor, Contractor, Issue, WorldEvent } from '../src/types.js';

/**
 * Graph-native replacements for the retired Coordinator structured-event scenarios:
 * decline/reassign, over-limit quote, slot→confirm→complete, silence, changed appointment.
 */

const A: Contractor = { id: 'c1', name: 'One', trade: 'plumbing', availability: 'available', rating: 5 };
const B: Contractor = { id: 'c2', name: 'Two', trade: 'plumbing', availability: 'today', rating: 4 };
const BUSY: Contractor = { id: 'c3', name: 'Busy', trade: 'plumbing', availability: 'unavailable', rating: 5 };
const LANDLORD = { id: 'landlord', role: 'landlord', name: 'Landlord' };
const TENANT = { id: 'tenant', role: 'tenant', name: 'Tenant' };
const assess: Assessor = async (issue) => ({ kind: 'open', title: 'Leak', urgency: 'medium', scope: 'maintenance', evidenceIds: issue.evidence.map(e => e.eventId), reason: 'Contained leak' });

function make() {
    let cursor = 0;
    return (type: string, actor: WorldEvent['actor'], payload: Record<string, unknown>): WorldEvent => {
        cursor += 1;
        return { id: `evt_${cursor}`, cursor, type, channel: type === 'message.received' ? 'email' : 'system', actor, sim_ms: cursor, occurred_at: '2026-11-19T12:00:00Z', payload };
    };
}

async function rig() {
    const store = new Store({ path: ':memory:', session: 'coord-graph' });
    const world = new ReplayWorldClient({ contractors: [A, B, BUSY] });
    const graph = new Graph({ store, world, assess });
    const event = make();
    const remote = await world.createCase({ title: 'Leak under sink', urgency: 'medium' });
    world.writes.length = 0;
    const issue: Issue = {
        id: 'issue', session: store.session, actorId: TENANT.id, status: 'active', urgency: 'medium', scope: 'maintenance', remoteCase: remote,
        evidence: [{ eventId: 'seed', cursor: 0, actor: TENANT, body: 'Kitchen sink leaking at Flat 12', occurredAt: '2026-11-19T11:00:00Z' }],
        engagement: { excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id },
    };
    store.putIssue(issue);
    return {
        store, world, graph, issueId: issue.id, event,
        send: (actor: { id: string; role: string; name: string }, body: string) => graph.processEvent(event('message.received', actor, { body, subject: 'Re: Leak under sink at Flat 12' })),
        signal: (type: 'work_order.accepted' | 'work_order.declined', contractorId: string, orderId: string) => graph.processEvent(event(type, { id: contractorId, role: 'contractor', name: contractorId }, { work_order_id: orderId })),
    };
}

test('decline by email before an order excludes the contractor and proposes exactly one replacement', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'Get me the contractor\'s price in writing before I approve anything at Flat 12.');
        assert.equal(r.world.workOrders.size, 0);
        assert.equal(r.store.issue(r.issueId)!.engagement?.awaitingContractor, 'quote');
        await r.send({ id: A.id, role: 'contractor', name: A.name }, 'I must decline this job.');
        assert.equal(r.world.workOrders.size, 0, 'decline before hire raises no order');
        assert.ok(r.store.issue(r.issueId)!.engagement?.excludedContractorIds.includes(A.id));
        assert.equal(r.store.issue(r.issueId)!.engagement?.proposal?.id, B.id);
        const toLandlord = r.world.writes.filter(w => w.operation === 'sendMessage' && w.id === LANDLORD.id).map(w => (w.input as { body: string }).body);
        assert.ok(toLandlord.some(body => /Next proposed contractor: Two/i.test(body)));
    }
    finally {
        r.store.close();
    }
});

test('work_order.declined replaces once; silence writes nothing; tenant slot then confirm then complete; changed terms hold', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve this repair, please go ahead.');
        assert.equal(r.world.workOrders.size, 1);
        const first = [...r.world.workOrders.keys()][0]!;
        r.world.workOrders.get(first)!.status = 'declined';
        await r.signal('work_order.declined', A.id, first);
        assert.equal(r.world.workOrders.size, 2, 'exactly one replacement order');
        assert.equal([...r.world.workOrders.values()].at(-1)!.contractor_id, B.id);
        assert.ok(r.store.issue(r.issueId)!.engagement?.excludedContractorIds.includes(A.id));

        // Fresh engagement for slot → confirm → complete on the replacement order path.
        const r2 = await rig();
        try {
            await r2.send(LANDLORD, 'I approve this repair, please go ahead.');
            const id = [...r2.world.workOrders.keys()][0]!;
            r2.world.workOrders.get(id)!.status = 'accepted';
            await r2.signal('work_order.accepted', A.id, id);
            const silent = r2.world.writes.length;
            await r2.graph.drain();
            assert.equal(r2.world.writes.length, silent, 'silence writes nothing');
            // Contractor offers a slot after accept → tenant must confirm before PATCH.
            await r2.send({ id: A.id, role: 'contractor', name: A.name }, 'I can attend on Thursday morning.');
            assert.equal(r2.store.issue(r2.issueId)!.engagement?.pendingTenantSlot, 'on Thursday morning');
            assert.equal(r2.world.workOrders.get(id)!.slot, null);
            await r2.send(TENANT, 'Yes, that works for me.');
            assert.equal(r2.world.workOrders.get(id)!.slot, 'on Thursday morning');
            await r2.send({ id: A.id, role: 'contractor', name: A.name }, 'Visit is confirmed: on Thursday morning.');
            assert.ok(r2.store.issue(r2.issueId)!.engagement?.visitConfirmedEventId);
            await r2.send({ id: A.id, role: 'contractor', name: A.name }, 'The repair is complete.');
            assert.equal(r2.world.cases.get(r2.store.issue(r2.issueId)!.remoteCase!.id)!.status, 'resolved');
            // Changed appointment after booking holds for review.
            await r2.send({ id: A.id, role: 'contractor', name: A.name }, 'Updated quote is £260 and I can attend on Friday morning.');
            assert.equal(r2.store.issue(r2.issueId)!.status, 'review');
            assert.match(r2.store.issue(r2.issueId)!.humanAction ?? '', /changed terms after booking/i);
        }
        finally {
            r2.store.close();
        }
    }
    finally {
        r.store.close();
    }
});

test('inspectCoordination remains read-only over legacy tables when present', () => {
    const store = new Store({ path: ':memory:', session: 'legacy' });
    try {
        store.db.exec('CREATE TABLE coordination_states(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE coordination_effects(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE coordination_events(id TEXT PRIMARY KEY,cursor INTEGER,data TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0);');
        store.putIssue({ id: 'issue', session: store.session, actorId: 'tenant', status: 'active', evidence: [], remoteCase: { id: 'case-1', title: 'Leak', description: null, urgency: 'medium', property_id: null, status: 'open', created_at: '2026-11-19T12:00:00Z', updated_at: '2026-11-19T12:00:00Z' } });
        store.db.prepare('INSERT INTO coordination_states VALUES(?,?)').run('issue', JSON.stringify({ issueId: 'issue', phase: 'complete' }));
        const inspected = inspectCoordination(store, 'issue') as { state: { phase: string }; note: string };
        assert.equal(inspected.state.phase, 'complete');
        assert.match(inspected.note, /inspect-only/i);
    }
    finally {
        store.close();
    }
});
