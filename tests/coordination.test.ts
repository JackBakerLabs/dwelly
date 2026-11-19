import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordination/index.js';
import { Store } from '../src/store/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import type { WorldEvent } from '../src/types.js';
async function setup() { const store = new Store({ path: ':memory:', session: 'coord-test' }); const world = new ReplayWorldClient({ contractors: [{ id: 'c1', name: 'One', trade: 'plumbing', availability: 'available', rating: 5 }, { id: 'c2', name: 'Two', trade: 'plumbing', availability: 'today', rating: 4 }, { id: 'c3', name: 'Busy', trade: 'plumbing', availability: 'unavailable', rating: 5 }] }); const remoteCase = await world.createCase({ title: 'Leak', urgency: 'medium' }); store.putIssue({ id: 'issue', session: store.session, actorId: 'tenant', status: 'active', evidence: [], remoteCase }); const coordinator = new Coordinator({ store, world }); let cursor = 0; const event = (type: string, actorId: string, role: string, payload: Record<string, unknown>): WorldEvent => ({ id: 'event-' + (++cursor), cursor, type, channel: 'email', actor: { id: actorId, role, name: actorId }, sim_ms: cursor, occurred_at: '2026-11-19T12:00:00Z', payload: { case_id: remoteCase.id, ...payload } }); await coordinator.start('issue', 'plumbing'); return { store, world, coordinator, event }; }
async function accept(s: Awaited<ReturnType<typeof setup>>) { const order = s.coordinator.inspect('issue').state!.order!; s.world.workOrders.get(order.id)!.status = 'accepted'; await s.coordinator.processEvent(s.event('work_order.accepted', order.contractor_id, 'contractor', { work_order_id: order.id })); return order.id; }
test('pending dedup, decline selects only different currently available contractor', async () => { const s = await setup(); try {
    await s.coordinator.start('issue', 'plumbing');
    assert.equal(s.world.workOrders.size, 1);
    const first = s.coordinator.inspect('issue').state!.order!;
    const decline = s.event('work_order.declined', 'c1', 'contractor', { work_order_id: first.id });
    await s.coordinator.processEvent(decline);
    await s.coordinator.processEvent(decline);
    assert.equal(s.world.workOrders.size, 2);
    assert.equal(s.coordinator.inspect('issue').state!.order!.contractor_id, 'c2');
}
finally {
    s.store.close();
} });
test('above-limit quote awaits exact approval then agreed slot and separate confirmation', async () => { const s = await setup(); try {
    const id = await accept(s);
    await s.coordinator.processEvent(s.event('coordination.authority', 'landlord', 'landlord', { spending_limit_gbp: 100 }));
    await s.coordinator.processEvent(s.event('coordination.quote', 'c1', 'contractor', { work_order_id: id, cost_estimate_gbp: 150 }));
    assert.equal(s.coordinator.inspect('issue').state!.phase, 'approval');
    assert.equal(s.world.workOrders.get(id)!.landlord_approved, false);
    assert.ok(s.world.writes.some(w => w.operation === 'sendMessage'));
    await s.coordinator.processEvent(s.event('coordination.approval', 'landlord', 'landlord', { work_order_id: id, approved_quote_gbp: 150 }));
    assert.equal(s.world.workOrders.get(id)!.landlord_approved, true);
    await s.coordinator.processEvent(s.event('coordination.slot', 'tenant', 'tenant', { work_order_id: id, slot: 'Friday 10:00' }));
    assert.equal(s.world.workOrders.get(id)!.slot, null);
    await s.coordinator.processEvent(s.event('coordination.slot', 'c1', 'contractor', { work_order_id: id, slot: 'Friday 10:00' }));
    assert.equal(s.coordinator.inspect('issue').state!.phase, 'booked');
    await s.coordinator.processEvent(s.event('coordination.confirmed', 'c1', 'contractor', { work_order_id: id, slot: 'Friday 10:00' }));
    assert.equal(s.coordinator.inspect('issue').state!.phase, 'confirmed');
}
finally {
    s.store.close();
} });
test('silence writes nothing; changed price revokes prior approval; changed appointment holds review', async () => { const s = await setup(); try {
    const id = await accept(s);
    await s.coordinator.processEvent(s.event('coordination.authority', 'landlord', 'landlord', { spending_limit_gbp: 100 }));
    await s.coordinator.processEvent(s.event('coordination.quote', 'c1', 'contractor', { work_order_id: id, cost_estimate_gbp: 90 }));
    assert.equal(s.world.workOrders.get(id)!.landlord_approved, true);
    let count = s.world.writes.length;
    await s.coordinator.drain();
    assert.equal(s.world.writes.length, count);
    await s.coordinator.processEvent(s.event('coordination.quote', 'c1', 'contractor', { work_order_id: id, cost_estimate_gbp: 200 }));
    assert.equal(s.world.workOrders.get(id)!.landlord_approved, false);
    await s.coordinator.processEvent(s.event('coordination.approval', 'landlord', 'landlord', { work_order_id: id, approved_quote_gbp: 200 }));
    for (const [actor, role] of [['tenant', 'tenant'], ['c1', 'contractor']])
        await s.coordinator.processEvent(s.event('coordination.slot', actor!, role!, { work_order_id: id, slot: 'Friday 10:00' }));
    count = s.world.writes.length;
    await s.coordinator.processEvent(s.event('coordination.slot', 'tenant', 'tenant', { work_order_id: id, slot: 'Saturday 10:00' }));
    assert.equal(s.coordinator.inspect('issue').state!.phase, 'review');
    assert.equal(s.world.writes.length, count);
}
finally {
    s.store.close();
} });
test('unknown contractor facts and unsupported payload cannot dispatch', async () => { const s = await setup(); try {
    const id = await accept(s);
    const before = s.world.writes.length;
    await s.coordinator.processEvent(s.event('coordination.quote', 'intruder', 'contractor', { work_order_id: id, cost_estimate_gbp: 1 }));
    assert.equal(s.coordinator.inspect('issue').state!.phase, 'review');
    assert.equal(s.world.writes.length, before);
}
finally {
    s.store.close();
} });
test('timeout after remote assignment stays single and uncertain after coordinator restart', async () => { const s = await setup(); try {
    const second = await s.world.createCase({ title: 'Other leak', urgency: 'medium' });
    s.store.putIssue({ id: 'second', session: s.store.session, actorId: 'tenant', status: 'active', evidence: [], remoteCase: second });
    const original = s.world.createWorkOrder.bind(s.world);
    s.world.createWorkOrder = async (input) => { await original(input); throw new Error('connection lost after creation'); };
    await assert.rejects(s.coordinator.start('second', 'plumbing'));
    const count = s.world.workOrders.size;
    const restarted = new Coordinator({ store: s.store, world: s.world });
    await assert.rejects(restarted.start('second', 'plumbing'));
    assert.equal(s.world.workOrders.size, count);
    assert.equal(restarted.inspect('second').effects[0]!.state, 'uncertain');
}
finally {
    s.store.close();
} });
test('confirmed effects replay after checkpoint interruption without duplicate writes, then completion updates local case', async () => { const s = await setup(); try {
    const id = await accept(s);
    await s.coordinator.processEvent(s.event('coordination.authority', 'landlord', 'landlord', { spending_limit_gbp: 500 }));
    await s.coordinator.processEvent(s.event('coordination.quote', 'c1', 'contractor', { work_order_id: id, cost_estimate_gbp: 150 }));
    await s.coordinator.processEvent(s.event('coordination.slot', 'tenant', 'tenant', { work_order_id: id, slot: 'Friday 10:00' }));
    const booked = s.event('coordination.slot', 'c1', 'contractor', { work_order_id: id, slot: 'Friday 10:00' });
    await s.coordinator.processEvent(booked);
    const count = s.world.writes.length;
    s.store.db.prepare('UPDATE coordination_events SET done=0 WHERE id=?').run(booked.id);
    const restarted = new Coordinator({ store: s.store, world: s.world });
    await restarted.drain();
    assert.equal(s.world.writes.length, count);
    assert.equal(restarted.inspect('issue').state!.phase, 'booked');
    await restarted.processEvent(s.event('coordination.confirmed', 'c1', 'contractor', { work_order_id: id, slot: 'Friday 10:00' }));
    await restarted.processEvent(s.event('coordination.completed', 'c1', 'contractor', { work_order_id: id, completed: true }));
    assert.equal(s.store.issue('issue')!.remoteCase!.status, 'resolved');
    assert.equal(restarted.inspect('issue').state!.phase, 'complete');
}
finally {
    s.store.close();
} });
