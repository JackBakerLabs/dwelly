import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import { selectContractor } from '../src/triage/directory.js';
import type { Assessor, Contractor, WorldEvent } from '../src/types.js';
const DIRECTORY: Contractor[] = [
    { id: 'plumb-high', name: 'High Rating Plumbing', trade: 'plumbing', rating: 4.8, availability: 'available' },
    { id: 'plumb-next', name: 'Next Plumbing', trade: 'plumbing', rating: 4.2, availability: 'today' },
    { id: 'plumb-busy', name: 'Busy Plumbing', trade: 'plumbing', rating: 4.9, availability: 'unavailable' },
];
const tenant = { id: 'act_tenant_1', role: 'tenant', name: 'Sarah Mitchell' };
const landlord = { id: 'act_landlord_1', role: 'landlord', name: 'David Okafor' };
const sink = "Hi, it's Sarah in Flat 12. The kitchen sink pipe is dripping.";
const evt16 = { subject: 'Re: maintenance case at 14 Elm Road, Flat 12', body: "Hi,\n\nJust to be clear on 14 Elm Road, Flat 12 — I need an estimate from the contractor before I'll sign off on any repair over £150. Get me the price in writing and I'll make a call.\n\nDavid" };
const openCase: Assessor = async (issue) => { const latest = issue.evidence.at(-1)!; return { kind: 'open', scope: 'maintenance', title: /window/i.test(latest.body) ? 'Bedroom window' : 'Kitchen sink leak', urgency: 'medium', description: latest.body, evidenceIds: [latest.eventId], reason: 'In-scope repair' }; };
function mail(id: string, cursor: number, actor: { id: string; role: string; name: string }, body: string, extra: Record<string, unknown> = {}): WorldEvent { return { id, cursor, type: 'message.received', channel: 'email', actor, sim_ms: cursor, occurred_at: '2026-11-19T12:00:00Z', payload: { body, ...extra } }; }
function signal(id: string, cursor: number, type: 'work_order.accepted' | 'work_order.declined', orderId: string, caseId: string, actorId: string): WorldEvent { return { id, cursor, type, channel: 'email', actor: { id: actorId, role: 'contractor', name: actorId }, sim_ms: cursor, occurred_at: '2026-11-19T12:00:00Z', payload: { work_order_id: orderId, case_id: caseId } }; }
function sent(world: ReplayWorldClient, actorId?: string) { return world.writes.filter(write => write.operation === 'sendMessage' && (actorId === undefined || write.id === actorId)); }
function createdOrders(world: ReplayWorldClient) { return world.writes.filter(write => write.operation === 'createWorkOrder'); }
function setup(assess: Assessor = openCase, contractors: Contractor[] = DIRECTORY) { const store = new Store({ path: ':memory:', session: 'landlord-gate' }); const world = new ReplayWorldClient({ contractors }); const graph = new Graph({ store, world, assess }); return { store, world, graph }; }
async function openSink(graph: Graph, cursor = 1) { await graph.processEvent(mail('tenant-' + cursor, cursor, tenant, sink)); }
test('directory selection keeps exact trade, explicit availability, rating, then stable id', () => { const chosen = selectContractor([{ id: 'ctr-b', name: 'B', trade: 'plumbing', rating: 5, availability: 'available' }, { id: 'ctr-a', name: 'A', trade: 'plumbing', rating: 5, availability: 'today' }, { id: 'ctr-c', name: 'C', trade: 'electrical', rating: 9, availability: 'available' }, { id: 'ctr-d', name: 'D', trade: 'plumbing', rating: 9, availability: 'busy' }], 'plumbing', []); assert.equal(chosen?.id, 'ctr-a'); assert.equal(selectContractor(DIRECTORY, 'plumbing', ['plumb-high'])?.id, 'plumb-next'); });
test('evt_16 attaches, requests a written quote, and a cheaper quote still creates no work order', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    const issue = store.issues()[0]!;
    assert.equal(issue.engagement?.proposal?.id, 'plumb-high');
    assert.match(issue.engagement?.queuedBriefing ?? '', /not yet known/);
    assert.equal(world.workOrders.size, 0);
    assert.equal(sent(world).length, 0);
    await graph.processEvent(mail('evt_16', 16, landlord, evt16.body, { subject: evt16.subject }));
    assert.equal(store.issues().length, 1);
    assert.equal(store.issues()[0]!.evidence.some(evidence => evidence.eventId === 'evt_16'), true);
    assert.equal(store.issues()[0]!.engagement?.notedBudgetGbp, 150);
    assert.equal(store.issues()[0]!.engagement?.terms, undefined);
    assert.equal(store.issues()[0]!.engagement?.unconditional, undefined);
    assert.equal(store.issues()[0]!.engagement?.queuedBriefing, undefined);
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, 'plumb-high').length, 1);
    assert.equal(sent(world, landlord.id).length, 0);
    assert.ok(store.traces().some(trace => trace.node === 'LandlordTriage'));
    await graph.processEvent(mail('quote-100', 17, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The written estimate is £100.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(world.workOrders.size, 0);
    const reply = sent(world, landlord.id).at(-1);
    assert.match(String((reply?.input as { body?: string }).body), /£100/);
    assert.doesNotMatch(String((reply?.input as { body?: string }).body), /not yet known/);
} finally { store.close(); } });
test('conditional approval hires only when the quote and slot both fit, with no extra landlord question', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, 'plumb-high').length, 1);
    assert.equal(sent(world, landlord.id).length, 0);
    await graph.processEvent(mail('fit', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £180 and I can visit on Friday at 10:00.'));
    assert.equal(createdOrders(world).length, 1);
    assert.equal((createdOrders(world)[0]!.input as { contractor_id: string; cost_estimate_gbp: number; slot: string }).cost_estimate_gbp, 180);
    assert.match((createdOrders(world)[0]!.input as { slot: string }).slot, /Friday/i);
    assert.equal(sent(world, landlord.id).length, 0);
    const order = [...world.workOrders.values()][0]!;
    const writes = world.writes.length;
    await graph.processEvent(signal('accepted', 4, 'work_order.accepted', order.id, order.case_id, 'plumb-high'));
    assert.deepEqual(world.writes.at(-1)?.input, { landlord_approved: true });
    assert.equal(world.workOrders.get(order.id)?.status, 'accepted');
    const slot = store.issues()[0]!.engagement?.order?.slot ?? '';
    await graph.processEvent(mail('confirm', 5, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, `I confirm the visit ${slot}.`));
    assert.equal(world.writes.length, writes + 3, 'accept patch already counted; confirm adds landlord + tenant notices');
    assert.equal(store.issues()[0]!.engagement?.visitConfirmedEventId, 'confirm');
    assert.equal(world.workOrders.get(order.id)?.status, 'accepted');
} finally { store.close(); } });
test('a missing quote or slot asks the contractor and does not hire or negotiate', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await graph.processEvent(mail('price-only', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £180.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, landlord.id).length, 0);
    assert.equal(sent(world, 'plumb-high').length, 2);
    await graph.processEvent(mail('unavailable', 4, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'I am unavailable on Friday.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, landlord.id).length, 1);
} finally { store.close(); } });
test('a quote over budget or a slot outside the timeframe creates no work order and asks the landlord', async () => { const over = setup(); const late = setup(); try {
    await openSink(over.graph);
    await over.graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await over.graph.processEvent(mail('over', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £220 and I can visit on Friday at 10:00.'));
    assert.equal(createdOrders(over.world).length, 0);
    assert.match(String((sent(over.world, landlord.id).at(-1)?.input as { body: string }).body), /£220/);
    await openSink(late.graph);
    await late.graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await late.graph.processEvent(mail('monday', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £100 and I can visit on Monday at 09:00.'));
    assert.equal(createdOrders(late.world).length, 0);
    assert.equal(sent(late.world, landlord.id).length, 1);
} finally { over.store.close(); late.store.close(); } });
test('an updated approval that covers the stored quote and slot hires without asking the contractor again', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £150 or less and they can visit on Friday.'));
    await graph.processEvent(mail('over', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £220 and I can visit on Friday at 10:00.'));
    const asked = sent(world, 'plumb-high').length;
    await graph.processEvent(mail('updated', 4, landlord, 'I approve the Flat 12 repair if the quote is £250 or less and they can visit on Friday.'));
    assert.equal(createdOrders(world).length, 1);
    assert.equal((createdOrders(world)[0]!.input as { cost_estimate_gbp: number }).cost_estimate_gbp, 220);
    assert.equal(sent(world, 'plumb-high').length, asked);
} finally { store.close(); } });
test('an updated approval that still misses asks the same contractor and creates no work order', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £150 or less and they can visit on Friday.'));
    await graph.processEvent(mail('over', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £220 and I can visit on Friday at 10:00.'));
    await graph.processEvent(mail('updated', 4, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, 'plumb-high').length, 2);
} finally { store.close(); } });
test('a contractor email decline before a work order raises none and proposes the next contractor to the landlord', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await graph.processEvent(mail('decline', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'I decline this job.'));
    assert.equal(createdOrders(world).length, 0);
    assert.match(String((sent(world, landlord.id).at(-1)?.input as { body: string }).body), /Next Plumbing/);
    assert.equal(store.issues()[0]!.engagement?.proposal?.id, 'plumb-next');
} finally { store.close(); } });
test('work_order.declined raises one replacement for the next directory contractor and not the declined id', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    const caseId = store.issues()[0]!.remoteCase!.id;
    await graph.processEvent(mail('approve', 2, landlord, 'I approve this repair. Please go ahead.', { case_id: caseId }));
    const first = [...world.workOrders.values()][0]!;
    assert.equal(first.contractor_id, 'plumb-high');
    await graph.processEvent(signal('declined', 3, 'work_order.declined', first.id, caseId, 'plumb-high'));
    assert.equal(createdOrders(world).length, 2);
    assert.deepEqual(createdOrders(world).map(write => (write.input as { contractor_id: string }).contractor_id), ['plumb-high', 'plumb-next']);
    assert.equal(world.workOrders.get(first.id)?.status, 'declined');
    assert.match(String((sent(world, landlord.id).at(-1)?.input as { body: string }).body), /High Rating Plumbing/);
    assert.match(String((sent(world, landlord.id).at(-1)?.input as { body: string }).body), /Next Plumbing/);
} finally { store.close(); } });
test('no remaining candidate or an existing landlord rejection creates no replacement order', async () => { const none = setup(openCase, DIRECTORY.filter(contractor => contractor.id !== 'plumb-next')); const rejected = setup(); try {
    await openSink(none.graph);
    const noneCase = none.store.issues()[0]!.remoteCase!.id;
    await none.graph.processEvent(mail('approve', 2, landlord, 'I approve this repair. Please go ahead.', { case_id: noneCase }));
    const only = [...none.world.workOrders.values()][0]!;
    await none.graph.processEvent(signal('declined', 3, 'work_order.declined', only.id, noneCase, 'plumb-high'));
    assert.equal(createdOrders(none.world).length, 1);
    assert.match(String((sent(none.world, landlord.id).at(-1)?.input as { body: string }).body), /No other exact-trade/);
    await openSink(rejected.graph);
    const caseId = rejected.store.issues()[0]!.remoteCase!.id;
    await rejected.graph.processEvent(mail('approve', 2, landlord, 'I approve this repair. Please go ahead.', { case_id: caseId }));
    await rejected.graph.processEvent(mail('reject', 3, landlord, 'I reject the Flat 12 repair. Do not proceed.'));
    const order = [...rejected.world.workOrders.values()][0]!;
    await rejected.graph.processEvent(signal('declined', 4, 'work_order.declined', order.id, caseId, 'plumb-high'));
    assert.equal(createdOrders(rejected.world).length, 1);
} finally { none.store.close(); rejected.store.close(); } });
test('a post-order quote inside the conditions patches the price and landlord approval', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await graph.processEvent(mail('fit', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £180 and I can visit on Friday at 10:00.'));
    await graph.processEvent(mail('revised', 4, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The revised quote is £160.'));
    assert.equal(createdOrders(world).length, 1);
    assert.deepEqual(world.writes.filter(write => write.operation === 'patchWorkOrder').at(-1)?.input, { cost_estimate_gbp: 160, landlord_approved: true });
    assert.equal(sent(world, landlord.id).length, 0);
} finally { store.close(); } });
test('a post-order quote over the budget patches disapproval and asks the landlord', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await graph.processEvent(mail('fit', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £180 and I can visit on Friday at 10:00.'));
    await graph.processEvent(mail('revised', 4, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The revised quote is £400.'));
    assert.equal(createdOrders(world).length, 1);
    assert.deepEqual(world.writes.filter(write => write.operation === 'patchWorkOrder').at(-1)?.input, { cost_estimate_gbp: 400, landlord_approved: false });
    assert.match(String((sent(world, landlord.id).at(-1)?.input as { body: string }).body), /£400/);
} finally { store.close(); } });
test('landlord rejection during negotiation sends nothing further to the contractor', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('approve-if', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    await graph.processEvent(mail('over', 3, { id: 'plumb-high', role: 'contractor', name: 'High Rating Plumbing' }, 'The quote is £220 and I can visit on Friday at 10:00.'));
    const before = sent(world, 'plumb-high').length;
    await graph.processEvent(mail('reject', 4, landlord, 'I reject the Flat 12 repair. Do not proceed.'));
    assert.equal(sent(world, 'plumb-high').length, before);
    assert.equal(createdOrders(world).length, 0);
    assert.equal(store.issues()[0]!.engagement?.rejected, true);
} finally { store.close(); } });
test('landlord rejection after a work order patches disapproval and tells the contractor', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    const caseId = store.issues()[0]!.remoteCase!.id;
    await graph.processEvent(mail('approve', 2, landlord, 'I approve this repair. Please go ahead.', { case_id: caseId }));
    await graph.processEvent(mail('reject', 3, landlord, 'I reject the Flat 12 repair. Do not proceed.'));
    assert.deepEqual(world.writes.filter(write => write.operation === 'patchWorkOrder').at(-1)?.input, { landlord_approved: false });
    assert.match(String((sent(world, 'plumb-high').at(-1)?.input as { body: string }).body), /rejected this engagement/);
    assert.equal(store.issues()[0]!.status, 'review');
    assert.equal([...world.workOrders.values()][0]!.status, 'pending');
    assert.equal(createdOrders(world).length, 1);
} finally { store.close(); } });
test('a landlord email with no property asks the sender and does not message a contractor', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('no-property', 2, landlord, 'Please keep me informed about the repair.'));
    assert.equal(createdOrders(world).length, 0);
    assert.equal(sent(world, 'plumb-high').length, 0);
    assert.match(String((sent(world, landlord.id)[0]!.input as { body: string }).body), /Which property/);
    assert.match(store.issues()[0]!.engagement?.queuedBriefing ?? '', /not yet known/);
} finally { store.close(); } });
test('several open issues at the named property ask which issue and do not pick one', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('window', 2, tenant, 'The bedroom window in Flat 12 will not close.'));
    assert.equal(store.issues().length, 2);
    await graph.processEvent(mail('which', 3, landlord, 'Please look at Flat 12.'));
    const body = String((sent(world, landlord.id).at(-1)?.input as { body: string }).body);
    assert.match(body, /Kitchen sink leak/);
    assert.match(body, /Bedroom window/);
    assert.equal(sent(world, 'plumb-high').length, 0);
    assert.equal(createdOrders(world).length, 0);
} finally { store.close(); } });
test('a conditional reply with only a budget or only a timeframe asks for the missing fact', async () => { const budget = setup(); const time = setup(); try {
    await openSink(budget.graph);
    await budget.graph.processEvent(mail('budget', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less.'));
    assert.match(String((sent(budget.world, landlord.id).at(-1)?.input as { body: string }).body), /timeframe/);
    assert.equal(sent(budget.world, 'plumb-high').length, 0);
    await openSink(time.graph);
    await time.graph.processEvent(mail('time', 2, landlord, 'I approve the Flat 12 repair if they can visit on Friday.'));
    assert.match(String((sent(time.world, landlord.id).at(-1)?.input as { body: string }).body), /budget/);
    assert.equal(sent(time.world, 'plumb-high').length, 0);
    assert.equal(createdOrders(budget.world).length + createdOrders(time.world).length, 0);
} finally { budget.store.close(); time.store.close(); } });
test('a proposed property that is not in the message or a second landlord is review with no write', async () => { const store = new Store({ path: ':memory:', session: 'landlord-gate' }); const world = new ReplayWorldClient({ contractors: DIRECTORY }); const graph = new Graph({ store, world, assess: openCase, assessLandlord: async () => ({ channel: 'landlord', kind: 'requestQuote', proposedPropertyText: 'Flat 99', evidenceIds: ['evt_16'], reason: 'Proposed elsewhere' }) }); try {
    await openSink(graph);
    await graph.processEvent(mail('evt_16', 16, landlord, evt16.body, { subject: evt16.subject }));
    assert.equal(store.issues()[0]!.status, 'review');
    assert.equal(sent(world, 'plumb-high').length, 0);
    assert.equal(createdOrders(world).length, 0);
} finally { store.close(); }
const second = setup(); try {
    await openSink(second.graph);
    await second.graph.processEvent(mail('first', 2, landlord, 'I approve the Flat 12 repair if the quote is £200 or less and they can visit on Friday.'));
    const writes = second.world.writes.length;
    await second.graph.processEvent(mail('second', 3, { id: 'act_landlord_2', role: 'landlord', name: 'Other Landlord' }, 'I approve the Flat 12 repair. Please go ahead.'));
    assert.equal(second.world.writes.length, writes);
    assert.equal(second.store.issues()[0]!.status, 'review');
    assert.equal(createdOrders(second.world).length, 0);
} finally { second.store.close(); } });
test('low callouts and external gas emergencies do not get a contractor proposal', async () => { const low = setup(async issue => ({ kind: 'open', scope: 'maintenance', title: 'Scuff', urgency: 'low', evidenceIds: [issue.evidence.at(-1)!.eventId], reason: 'Cosmetic' })); const gas = setup(async issue => ({ kind: 'open', scope: 'externalEmergency', title: 'Suspected gas', urgency: 'emergency', humanAction: 'Phone the gas emergency service', evidenceIds: [issue.evidence.at(-1)!.eventId], reason: 'Gas smell' })); try {
    await low.graph.processEvent(mail('cosmetic', 1, tenant, 'There is a small stable scratch in the Flat 12 hallway paint.'));
    assert.equal(low.store.issues()[0]!.engagement, undefined);
    assert.equal(createdOrders(low.world).length, 0);
    await gas.graph.processEvent(mail('gas', 1, { id: 'act_tenant_2', role: 'tenant', name: 'Neighbour' }, 'Strong smell of gas in the stairwell at Flat 9.'));
    assert.equal(gas.store.issues()[0]!.engagement, undefined);
    assert.equal(gas.store.issues()[0]!.humanAction, 'Phone the gas emergency service');
    assert.equal(createdOrders(gas.world).length, 0);
} finally { low.store.close(); gas.store.close(); } });
test('structured coordination.* events are retained without mutation; landlord mail stays on the graph', async () => { const { store, world, graph } = setup(); try {
    await openSink(graph);
    await graph.processEvent(mail('evt_16', 16, landlord, evt16.body, { subject: evt16.subject }));
    assert.ok(store.traces().some(trace => trace.eventId === 'evt_16' && trace.node === 'LandlordTriage'));
    const before = world.writes.length;
    await graph.processEvent({ id: 'coord', cursor: 20, type: 'coordination.authority', channel: 'email', actor: landlord, sim_ms: 20, occurred_at: '2026-11-19T12:00:00Z', payload: { case_id: 'case', spending_limit_gbp: 100 } });
    assert.equal(world.writes.length, before, 'retired coordination.* envelopes write nothing');
    await graph.processEvent(signal('missing', 21, 'work_order.declined', 'not-an-order', 'not-a-case', 'plumb-high'));
    assert.ok(store.traces().some(trace => trace.eventId === 'missing' && trace.node === 'Route'));
} finally { store.close(); } });
