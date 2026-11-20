import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import { proposalFrom } from '../src/triage/index.js';
import type { Assessor, Contractor, Issue, WorldEvent } from '../src/types.js';

/**
 * Graph-level landlord/contractor approval gate tests.
 * Assumptions about the graph API (see report):
 *  - `new Graph({ store, world, assess })` routes landlord / contractor `message.received` events and
 *    `work_order.accepted|declined` events to the triage helpers by default (classifyLandlord / classifyContractor).
 *  - Contractors are addressed by their directory id, so `sendMessage(actorId = contractor.id)` is the quote ask.
 *  - Landlords are addressed by the id of the actor that wrote.
 */

const PLUMBER_A: Contractor = { id: 'c_plumb_a', name: 'Aqua Plumbing', trade: 'plumbing', availability: 'available', rating: 5 };
const PLUMBER_B: Contractor = { id: 'c_plumb_b', name: 'Brook Plumbing', trade: 'plumbing', availability: 'available', rating: 4 };
const PLUMBER_BUSY: Contractor = { id: 'c_plumb_busy', name: 'Busy Plumbing', trade: 'plumbing', availability: 'unavailable', rating: 5 };
const SPARKY: Contractor = { id: 'c_spark', name: 'Spark Electrical', trade: 'electrical', availability: 'available', rating: 5 };
const LANDLORD = { id: 'act_landlord_1', role: 'landlord', name: 'David Okafor' };
const TENANT = { id: 'act_tenant_1', role: 'tenant', name: 'Sarah Mitchell' };
const SUBJECT = 'Re: maintenance case at 14 Elm Road, Flat 12';
const TENANT_BODY = 'The kitchen sink at 14 Elm Road, Flat 12 is leaking under the cabinet.';

interface Rig { store: Store; world: ReplayWorldClient; graph: Graph; issueId: string; send: (actor: { id: string; role: string; name: string }, body: string, subject?: string) => Promise<void>; signal: (type: 'work_order.accepted' | 'work_order.declined', contractorId: string, orderId: string) => Promise<void>; }

const sinkAssessor: Assessor = async (issue) => ({ kind: 'open', title: 'Kitchen sink leak', urgency: 'medium', scope: 'maintenance', evidenceIds: issue.evidence.map(e => e.eventId), reason: 'Active leak needs a repair' });

function eventFactory() {
    let cursor = 0;
    return (type: string, actor: WorldEvent['actor'], payload: Record<string, unknown>): WorldEvent => { cursor += 1; return { id: `evt_${cursor}`, cursor, type, channel: type === 'message.received' ? 'email' : 'system', actor, sim_ms: cursor * 1000, occurred_at: '2026-11-19T12:00:00Z', payload }; };
}

async function rig(options: { contractors?: Contractor[]; seed?: 'issue' | 'none'; assess?: Assessor } = {}): Promise<Rig> {
    const store = new Store({ path: ':memory:', session: 'landlord-engagement-test' });
    const contractors = options.contractors ?? [PLUMBER_A, PLUMBER_B, PLUMBER_BUSY, SPARKY];
    const world = new ReplayWorldClient({ contractors });
    const graph = new Graph({ store, world, assess: options.assess ?? sinkAssessor });
    const make = eventFactory();
    let issueId = 'unset';
    if ((options.seed ?? 'issue') === 'issue') {
        const remoteCase = await world.createCase({ title: 'Kitchen sink leak at Flat 12', urgency: 'medium' });
        world.writes.length = 0;
        const plumber = contractors.find(c => c.trade === 'plumbing')!;
        const issue: Issue = { id: 'issue-sink', session: store.session, actorId: TENANT.id, status: 'active', urgency: 'medium', scope: 'maintenance', remoteCase, evidence: [{ eventId: 'seed_tenant', cursor: 0, actor: TENANT, body: TENANT_BODY, occurredAt: '2026-11-19T11:00:00Z' }], engagement: { excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(plumber) } };
        store.putIssue(issue);
        issueId = issue.id;
    }
    return {
        store, world, graph, issueId,
        send: (actor, body, subject) => graph.processEvent(make('message.received', actor, { body, ...(subject ? { subject } : {}) })),
        signal: (type, contractorId, orderId) => graph.processEvent(make(type, { id: contractorId, role: 'contractor', name: contractorId }, { work_order_id: orderId })),
    };
}

const contractor = (c: Contractor) => ({ id: c.id, role: 'contractor', name: c.name });
const messagesTo = (r: Rig, actorId: string) => r.world.writes.filter(w => w.operation === 'sendMessage' && w.id === actorId).map(w => (w.input as { body: string }).body);
const orders = (r: Rig) => r.world.writes.filter(w => w.operation === 'createWorkOrder');
const patches = (r: Rig) => r.world.writes.filter(w => w.operation === 'patchWorkOrder');
const issue = (r: Rig) => r.store.issues().find(i => i.remoteCase)!;
const orderId = (r: Rig) => [...r.world.workOrders.keys()].at(-1)!;
const markStatus = (r: Rig, id: string, status: 'accepted' | 'declined') => { r.world.workOrders.get(id)!.status = status; };

const CONDITIONAL = 'I approve this repair if the price is up to £200 and the visit is on Thursday.';
const WITHIN = 'My quote is £180 and I can attend on Thursday morning.';
const OVER_BUDGET = 'My quote is £240 and I can attend on Thursday afternoon.';

/** Conditional approval has been given and the contractor has been asked; no order yet. */
async function conditional(r: Rig, text = CONDITIONAL) { await r.send(LANDLORD, text, SUBJECT); }
/** Conditional approval then an in-budget reply: one work order is raised. */
async function hired(r: Rig) { await conditional(r); await r.send(contractor(PLUMBER_A), WITHIN); }

test('1 evt_16: £150 written-estimate request attaches to the open sink case, asks for a quote, creates no work order', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, "Hello, I will not sign off any repair over £150 without a written estimate from the contractor. I'll make a call once I see the price.", SUBJECT);
        assert.equal(r.store.issues().length, 1, 'message attaches to the existing issue, no new issue');
        assert.ok(issue(r).evidence.some(e => e.actor?.role === 'landlord'));
        assert.equal(orders(r).length, 0);
        assert.equal(r.world.workOrders.size, 0);
        assert.equal(issue(r).engagement?.notedBudgetGbp, 150);
        assert.equal(issue(r).engagement?.awaitingContractor, 'quote');
        assert.equal(issue(r).engagement?.landlordId, LANDLORD.id);
        const ask = messagesTo(r, PLUMBER_A.id);
        assert.equal(ask.length, 1, 'proposed contractor is asked for a written quote');
        assert.match(ask[0]!, /estimate|quote/i);
        assert.match(ask[0]!, /not a work order/i);
        assert.equal(messagesTo(r, LANDLORD.id).length, 0, 'no unsolicited reply to the landlord yet');
    }
    finally {
        r.store.close();
    }
});

test('1b end-to-end: tenant open proposes a contractor without a work order, then evt_16 does not send the queued briefing', async () => {
    const r = await rig({ seed: 'none' });
    try {
        await r.send(TENANT, TENANT_BODY);
        assert.equal(r.world.cases.size, 1, 'case opened');
        assert.equal(orders(r).length, 0, 'case open alone never creates a work order');
        const opened = issue(r);
        assert.equal(opened.engagement?.proposal?.id, PLUMBER_A.id, 'best-rated available plumber is proposed');
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 0, 'proposal is stored, contractor not contacted yet');
        await r.send(LANDLORD, "I will not sign off any repair over £150 without a written estimate. I'll make a call after I see the price.", SUBJECT);
        assert.equal(r.store.issues().length, 1);
        assert.equal(orders(r).length, 0);
        assert.equal(messagesTo(r, LANDLORD.id).length, 0, 'queued briefing is not emailed after the landlord has already written');
        assert.equal(issue(r).engagement?.queuedBriefing, undefined);
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 1);
    }
    finally {
        r.store.close();
    }
});

test('2 match hire: conditional approval then in-budget quote and slot creates exactly one work order and no landlord message', async () => {
    const r = await rig();
    try {
        await conditional(r);
        assert.equal(orders(r).length, 0, 'conditional approval alone does not hire');
        const asked = messagesTo(r, PLUMBER_A.id);
        assert.equal(asked.length, 1, 'contractor asked for quote and availability only');
        assert.match(asked[0]!, /not a work order/i);
        assert.deepEqual(issue(r).engagement?.terms, { budgetGbp: 200, inclusive: true, timeframe: 'on Thursday' });
        await r.send(contractor(PLUMBER_A), WITHIN);
        assert.equal(orders(r).length, 1);
        assert.equal(r.world.workOrders.size, 1);
        const input = orders(r)[0]!.input as { case_id: string; contractor_id: string; cost_estimate_gbp?: number; slot?: string };
        assert.equal(input.contractor_id, PLUMBER_A.id);
        assert.equal(input.case_id, issue(r).remoteCase!.id);
        assert.equal(input.cost_estimate_gbp, 180);
        assert.match(input.slot ?? '', /thursday/i);
        assert.equal(messagesTo(r, LANDLORD.id).length, 0, 'no extra landlord negotiation message');
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 1, 'no second contractor question');
    }
    finally {
        r.store.close();
    }
});

test('3a miss negotiate: quote over budget creates no work order and asks the landlord for updated approval', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), OVER_BUDGET);
        assert.equal(orders(r).length, 0);
        assert.equal(r.world.workOrders.size, 0);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /£240/);
        assert.match(toLandlord[0]!, /updated approval/i);
        assert.equal(issue(r).engagement?.quoteGbp, 240);
    }
    finally {
        r.store.close();
    }
});

test('3b miss negotiate: slot outside the timeframe creates no work order and asks the landlord', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), 'My quote is £120 and I can attend on Saturday morning.');
        assert.equal(orders(r).length, 0);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /Saturday/i);
        assert.match(toLandlord[0]!, /updated approval/i);
    }
    finally {
        r.store.close();
    }
});

test('3c miss negotiate: contractor unavailable in the timeframe creates no work order and asks the landlord', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), 'My quote is £150 but I am unavailable this week.');
        assert.equal(orders(r).length, 0);
        assert.equal(messagesTo(r, LANDLORD.id).length, 1);
    }
    finally {
        r.store.close();
    }
});

test('4 updated approval covering the stored quote and slot creates one work order without asking the contractor again', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), OVER_BUDGET);
        const contractorMessages = messagesTo(r, PLUMBER_A.id).length;
        assert.equal(orders(r).length, 0);
        await r.send(LANDLORD, 'I approve this repair if the price is up to £250 and the visit is on Thursday.', SUBJECT);
        assert.equal(orders(r).length, 1);
        const input = orders(r)[0]!.input as { contractor_id: string; cost_estimate_gbp?: number };
        assert.equal(input.contractor_id, PLUMBER_A.id);
        assert.equal(input.cost_estimate_gbp, 240);
        assert.equal(messagesTo(r, PLUMBER_A.id).length, contractorMessages, 'no further contractor ask');
    }
    finally {
        r.store.close();
    }
});

test('4b updated approval that still misses counters to the same contractor and creates no order', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), OVER_BUDGET);
        await r.send(LANDLORD, 'I approve this repair if the price is up to £220 and the visit is on Thursday.', SUBJECT);
        assert.equal(orders(r).length, 0);
        const toContractor = messagesTo(r, PLUMBER_A.id);
        assert.equal(toContractor.length, 2, 'counter goes to the same contractor');
        assert.match(toContractor[1]!, /revised/i);
    }
    finally {
        r.store.close();
    }
});

test('5 pre-order reject: contractor email decline creates no work order and withdraws that contractor', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), 'I must decline this job, sorry.');
        assert.equal(orders(r).length, 0);
        assert.equal(r.world.workOrders.size, 0);
        assert.ok(issue(r).engagement?.excludedContractorIds.includes(PLUMBER_A.id));
        assert.equal(issue(r).engagement?.proposal?.id, PLUMBER_B.id, 'next candidate is only proposed, not hired');
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /No work order was created/i);
    }
    finally {
        r.store.close();
    }
});

test('6a decline then replacement: work_order.declined raises one order for the next directory contractor, never the declined id', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve this repair, please go ahead.', SUBJECT);
        assert.equal(orders(r).length, 1);
        const first = orderId(r);
        assert.equal((orders(r)[0]!.input as { contractor_id: string }).contractor_id, PLUMBER_A.id);
        markStatus(r, first, 'declined');
        await r.signal('work_order.declined', PLUMBER_A.id, first);
        const created = orders(r).map(w => (w.input as { contractor_id: string }).contractor_id);
        assert.deepEqual(created, [PLUMBER_A.id, PLUMBER_B.id]);
        assert.ok(issue(r).engagement?.excludedContractorIds.includes(PLUMBER_A.id));
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1, 'landlord told who declined and who replaced them');
        assert.match(toLandlord[0]!, /Brook Plumbing/);
        // Replaying the same decline does nothing more.
        await r.signal('work_order.declined', PLUMBER_A.id, first);
        assert.equal(orders(r).length, 2);
    }
    finally {
        r.store.close();
    }
});

test('6b decline with no remaining exact-trade candidate creates no replacement order', async () => {
    const r = await rig({ contractors: [PLUMBER_A, PLUMBER_BUSY, SPARKY] });
    try {
        await r.send(LANDLORD, 'I approve this repair, please go ahead.', SUBJECT);
        const first = orderId(r);
        markStatus(r, first, 'declined');
        await r.signal('work_order.declined', PLUMBER_A.id, first);
        assert.equal(orders(r).length, 1);
        assert.equal(r.world.workOrders.size, 1);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /No replacement order/i);
    }
    finally {
        r.store.close();
    }
});

test('6c decline after the landlord already rejected creates no replacement order', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve this repair, please go ahead.', SUBJECT);
        const first = orderId(r);
        await r.send(LANDLORD, 'I reject this. Please do not proceed.', SUBJECT);
        assert.deepEqual(patches(r).at(-1)!.input, { landlord_approved: false });
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 1, 'rejection after the order is sent to the contractor');
        markStatus(r, first, 'declined');
        await r.signal('work_order.declined', PLUMBER_A.id, first);
        assert.equal(orders(r).length, 1);
        assert.equal(r.world.workOrders.size, 1);
    }
    finally {
        r.store.close();
    }
});

test('7a post-order quote change after a booked slot holds for review instead of auto-patching', async () => {
    const r = await rig();
    try {
        await hired(r);
        const id = orderId(r);
        markStatus(r, id, 'accepted');
        await r.signal('work_order.accepted', PLUMBER_A.id, id);
        const ordersBefore = orders(r).length;
        const patchesBefore = patches(r).length;
        await r.send(contractor(PLUMBER_A), 'Updated quote: £190.');
        assert.equal(orders(r).length, ordersBefore, 'no second order for the same contractor');
        assert.equal(patches(r).length, patchesBefore, 'changed quote after booking is not auto-patched');
        assert.equal(issue(r).status, 'review');
        assert.match(issue(r).humanAction ?? '', /changed terms after booking/i);
    }
    finally {
        r.store.close();
    }
});

test('7b unconditional approval: price sent after the order is patched with landlord_approved true', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve this repair, please go ahead.', SUBJECT);
        const id = orderId(r);
        markStatus(r, id, 'accepted');
        await r.signal('work_order.accepted', PLUMBER_A.id, id);
        await r.send(contractor(PLUMBER_A), 'My quote is £150.');
        assert.equal(orders(r).length, 1);
        const last = patches(r).at(-1)!;
        assert.equal(last.id, id);
        const input = last.input as { cost_estimate_gbp?: number; landlord_approved?: boolean };
        assert.equal(input.cost_estimate_gbp, 150);
        assert.equal(input.landlord_approved, true);
    }
    finally {
        r.store.close();
    }
});

test('8 post-order over-budget quote after booking holds for review (no landlord_approved:false auto-patch)', async () => {
    const r = await rig();
    try {
        await hired(r);
        const id = orderId(r);
        markStatus(r, id, 'accepted');
        await r.signal('work_order.accepted', PLUMBER_A.id, id);
        const ordersBefore = orders(r).length;
        const patchesBefore = patches(r).length;
        await r.send(contractor(PLUMBER_A), 'Revised quote is £260.');
        assert.equal(orders(r).length, ordersBefore);
        assert.equal(patches(r).length, patchesBefore);
        assert.equal(issue(r).status, 'review');
        assert.match(issue(r).humanAction ?? '', /changed terms after booking/i);
    }
    finally {
        r.store.close();
    }
});

test('9 visitConfirmed: confirmation after the slot is on the accepted order notifies tenant and landlord', async () => {
    const r = await rig();
    try {
        await hired(r);
        const id = orderId(r);
        assert.match(r.world.workOrders.get(id)!.slot ?? '', /thursday/i, 'slot is saved on the order');
        markStatus(r, id, 'accepted');
        await r.signal('work_order.accepted', PLUMBER_A.id, id);
        const writes = r.world.writes.length;
        const slot = r.world.workOrders.get(id)!.slot!;
        await r.send(contractor(PLUMBER_A), `Visit is confirmed: ${slot} at the property.`);
        assert.equal(r.world.writes.length, writes + 2, 'one notice each to landlord and tenant');
        assert.ok(issue(r).engagement?.visitConfirmedEventId);
        assert.equal(messagesTo(r, LANDLORD.id).filter(body => /confirmed the visit/i.test(body)).length, 1);
        assert.equal(messagesTo(r, TENANT.id).filter(body => /confirmed the visit/i.test(body)).length, 1);
    }
    finally {
        r.store.close();
    }
});

test('10 unknown property: landlord email naming no property asks the sender and never messages a contractor', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'Hello, please go ahead with that repair when you can.', 'Re: your maintenance update');
        assert.equal(orders(r).length, 0);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /which property/i);
        for (const c of [PLUMBER_A, PLUMBER_B, PLUMBER_BUSY, SPARKY])
            assert.equal(messagesTo(r, c.id).length, 0);
        assert.equal(r.world.writes.filter(w => w.operation !== 'sendMessage').length, 0);
    }
    finally {
        r.store.close();
    }
});

test('10b property with several open issues asks which issue and never picks the newest', async () => {
    const r = await rig();
    try {
        const second = await r.world.createCase({ title: 'Flat 12 broken window latch', urgency: 'medium' });
        r.world.writes.length = 0;
        r.store.putIssue({ id: 'issue-window', session: r.store.session, actorId: TENANT.id, status: 'active', urgency: 'medium', remoteCase: second, evidence: [{ eventId: 'seed_window', cursor: 0, actor: TENANT, body: 'The window latch in Flat 12 is broken.', occurredAt: '2026-11-19T11:30:00Z' }] });
        await r.send(LANDLORD, 'I approve the repair at Flat 12, please go ahead.', SUBJECT);
        assert.equal(orders(r).length, 0);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /Which issue/i);
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 0);
    }
    finally {
        r.store.close();
    }
});

test('10c plural "both" against two distinct issues fans out one requestQuote intent each', async () => {
    const r = await rig();
    try {
        const second = await r.world.createCase({ title: 'Flat 12 broken window latch', urgency: 'medium' });
        r.world.writes.length = 0;
        const windowPlumber = proposalFrom(PLUMBER_A);
        r.store.putIssue({
            id: 'issue-window', session: r.store.session, actorId: TENANT.id, status: 'active', urgency: 'medium', remoteCase: second,
            evidence: [{ eventId: 'seed_window', cursor: 0, actor: TENANT, body: 'The window latch in Flat 12 is broken.', occurredAt: '2026-11-19T11:30:00Z' }],
            engagement: { excludedContractorIds: [], trade: 'plumbing', proposal: windowPlumber },
        });
        await r.send(LANDLORD, 'Both jobs at Flat 12 need sorting — get me the contractor\'s price for each one and I\'ll decide.', SUBJECT);
        assert.equal(orders(r).length, 0, 'quotes are requested; no work order yet');
        assert.equal(messagesTo(r, LANDLORD.id).filter(body => /Which issue/i.test(body)).length, 0);
        const toContractor = messagesTo(r, PLUMBER_A.id);
        assert.ok(toContractor.length >= 2, 'one quote ask per issue');
        const sink = r.store.issues().find(i => i.id === r.issueId)!;
        const window = r.store.issues().find(i => i.id === 'issue-window')!;
        assert.equal(sink.engagement?.awaitingContractor, 'quote');
        assert.equal(window.engagement?.awaitingContractor, 'quote');
        assert.equal(sink.engagement?.landlordId, LANDLORD.id);
        assert.equal(window.engagement?.landlordId, LANDLORD.id);
    }
    finally {
        r.store.close();
    }
});

test('landlord rejection during negotiation sends nothing further to the contractor and creates no order', async () => {
    const r = await rig();
    try {
        await conditional(r);
        await r.send(contractor(PLUMBER_A), OVER_BUDGET);
        const contractorMessages = messagesTo(r, PLUMBER_A.id).length;
        await r.send(LANDLORD, 'I reject this quote. Do not proceed.', SUBJECT);
        assert.equal(orders(r).length, 0);
        assert.equal(messagesTo(r, PLUMBER_A.id).length, contractorMessages);
        assert.equal(issue(r).engagement?.rejected, true);
    }
    finally {
        r.store.close();
    }
});

test('conditional approval missing a timeframe asks the landlord and does not contact the contractor', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve this repair if the price is up to £200.', SUBJECT);
        assert.equal(orders(r).length, 0);
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 0);
        const toLandlord = messagesTo(r, LANDLORD.id);
        assert.equal(toLandlord.length, 1);
        assert.match(toLandlord[0]!, /timeframe/i);
    }
    finally {
        r.store.close();
    }
});

test('landlord-first loop regression: answering "which property?" with no matching open case is held for review, never re-asked', async () => {
    const r = await rig({ seed: 'none' });
    try {
        await r.send(LANDLORD, 'Please go ahead with that repair.', 'Re: your maintenance update');
        await r.send(LANDLORD, 'Flat 12, 14 Elm Road');
        await r.send(LANDLORD, 'Flat 12, 14 Elm Road');
        await r.send(LANDLORD, 'I said Flat 12 at 14 Elm Road, please go ahead.');
        assert.equal(messagesTo(r, LANDLORD.id).length, 1, 'the property question is sent exactly once');
        assert.equal(r.store.issues().length, 1, 'answers do not spawn a fresh placeholder issue each time');
        assert.equal(r.store.issues()[0]!.status, 'review', 'unidentifiable answer is held for a human instead of looping');
        assert.equal(orders(r).length, 0);
    }
    finally {
        r.store.close();
    }
});

test('property-answer regression: "Flat 12" after the property question completes the original approval, and the case is not held for review', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'Please go ahead with that repair.', 'Re: your maintenance update');
        assert.equal(messagesTo(r, LANDLORD.id).length, 1);
        await r.send(LANDLORD, 'Flat 12');
        assert.equal(issue(r).status, 'active', 'bare property answer must not poison the real case to review');
        assert.equal(orders(r).length, 1, 'original "go ahead" + property answer hires once');
        assert.equal(messagesTo(r, LANDLORD.id).length, 1, 'no repeated property question');
        await r.send(LANDLORD, 'I approve the repair at Flat 12, please go ahead.', SUBJECT);
        assert.equal(issue(r).status, 'active', 'landlord can still be helped after answering');
    }
    finally {
        r.store.close();
    }
});

test('missing-timeframe regression: a bare "Thursday" answer completes the conditional approval instead of triggering the property question', async () => {
    const r = await rig();
    try {
        await r.send(LANDLORD, 'I approve the Flat 12 repair if the price is up to £200.', SUBJECT);
        assert.equal(messagesTo(r, LANDLORD.id).length, 1);
        await r.send(LANDLORD, 'Thursday');
        assert.deepEqual(issue(r).engagement?.terms, { budgetGbp: 200, inclusive: true, timeframe: 'Thursday' });
        assert.equal(messagesTo(r, PLUMBER_A.id).length, 1, 'contractor is asked for quote and slot');
        assert.equal(messagesTo(r, LANDLORD.id).length, 1, 'landlord is not asked which property');
        await r.send(contractor(PLUMBER_A), WITHIN);
        assert.equal(orders(r).length, 1);
    }
    finally {
        r.store.close();
    }
});

test('which-issue regression: naming the case title after "which issue?" completes the original approval', async () => {
    const r = await rig();
    try {
        const sinkCaseId = issue(r).remoteCase!.id;
        const second = await r.world.createCase({ title: 'Flat 12 broken window latch', urgency: 'medium' });
        r.world.writes.length = 0;
        r.store.putIssue({ id: 'issue-window', session: r.store.session, actorId: TENANT.id, status: 'active', urgency: 'medium', remoteCase: second, evidence: [{ eventId: 'seed_window', cursor: 0, actor: TENANT, body: 'The window latch in Flat 12 is broken.', occurredAt: '2026-11-19T11:30:00Z' }] });
        await r.send(LANDLORD, 'I approve the repair at Flat 12, please go ahead.', SUBJECT);
        assert.equal(messagesTo(r, LANDLORD.id).length, 1);
        assert.match(messagesTo(r, LANDLORD.id)[0]!, /Which issue/i);
        await r.send(LANDLORD, 'Kitchen sink leak');
        assert.equal(orders(r).length, 1, 'title answer + original approval hires on the named case');
        assert.equal((orders(r)[0]!.input as { case_id: string }).case_id, sinkCaseId);
        assert.equal(messagesTo(r, LANDLORD.id).length, 1, 'no follow-up property question');
    }
    finally {
        r.store.close();
    }
});

test('replaying the same landlord event does not duplicate contractor messages or orders', async () => {
    const r = await rig();
    try {
        const event: WorldEvent = { id: 'evt_replay', cursor: 1, type: 'message.received', channel: 'email', actor: LANDLORD, sim_ms: 1, occurred_at: '2026-11-19T12:00:00Z', payload: { body: 'I approve this repair, please go ahead.', subject: SUBJECT } };
        await r.graph.processEvent(event);
        await r.graph.processEvent(event);
        assert.equal(orders(r).length, 1);
        assert.equal(r.world.workOrders.size, 1);
    }
    finally {
        r.store.close();
    }
});
