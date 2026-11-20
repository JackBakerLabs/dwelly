import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import type { Assessor, Contractor, Issue, Observation, WorldEvent } from '../src/types.js';

/**
 * Captured live session regression from the 20 Nov 2026 interview demo
 * (`.data/22e795eab1c7b6a55219.sqlite`, session `interview-session-1`).
 * Fixture: `fixtures/live-leaking-sink-2026-11-20.json`.
 *
 * The brief's expected outcomes, locked into this test:
 *  - evt_2 opens exactly one case for Sarah's leak.
 *  - evt_5 attaches to that same case and patches it to high urgency.
 *  - case.acknowledged events (evt_10, evt_13) reconcile silently (no POST).
 *  - evt_17 (landlord's £150 written-estimate requirement) attaches to the
 *    single Flat 12 case: requestQuote with notedBudgetGbp = 150, awaiting
 *    the contractor for a quote. Never a "Which issue/property?" question.
 *  - No placeholder/empty landlord issues (one issue per real complaint).
 *  - evt_115 (Tom's gas leak) is handled as emergency + externalEmergency
 *    + explicit humanAction.
 *  - session.ended (evt_144) stops the session with no further mutations.
 */

const FIXTURE = JSON.parse(readFileSync('fixtures/live-leaking-sink-2026-11-20.json', 'utf8')) as { events: WorldEvent[] };

const PLUMBER: Contractor = { id: 'c_plumb_a', name: 'Aqua Plumbing', trade: 'plumbing', availability: 'available', rating: 5 };
const GAS_SAFE: Contractor = { id: 'c_gas_a', name: 'GasSafe Ltd', trade: 'heating', availability: 'available', rating: 5 };

/** Scripted assessor emulating the brief's expected behaviour: open on first
 *  sight for a leak/damage report; update to high when later evidence shows
 *  the leak has reached another flat; emergency + externalEmergency + human
 *  action for a credible gas leak. Landlord/contractor paths are handled by
 *  the graph's rule-based classifiers, not by this assessor. */
const scripted: Assessor = async (issue, evidence) => {
    const latest = evidence.at(-1)!;
    const body = latest.body.toLowerCase();
    const evidenceIds = [latest.eventId];
    if (/gas|smell of gas/.test(body))
        return { kind: 'open', scope: 'externalEmergency', title: 'Suspected gas leak in stairwell', urgency: 'emergency', humanAction: 'Call the National Gas Emergency Service (0800 111 999); evacuate and ventilate as instructed by qualified emergency responders.', evidenceIds, reason: 'Credible immediate gas hazard' };
    if (!issue.remoteCase)
        return { kind: 'open', scope: 'maintenance', title: 'Leak under kitchen sink with damp smell - Flat 12', urgency: 'medium', description: 'Tenant reports dripping under the kitchen sink with a damp smell in the cupboard.', evidenceIds, reason: 'Contained active leak requires routine repair' };
    if (/ceiling|downstairs|flat below|neighbour/.test(body))
        return { kind: 'update', caseId: issue.remoteCase.id, patch: { urgency: 'high', title: 'Active leak under kitchen sink causing ceiling stain in flat below (Flat 12, 14 Elm Road)', description: 'Leak now causing visible staining on the downstairs neighbour\'s ceiling; damp smell worsening.' }, evidenceIds, reason: 'New evidence shows spreading damage to another flat' };
    return { kind: 'wait', resume: { kind: 'caseUpdate', condition: 'Await material change or operator review' }, evidenceIds, reason: 'No new justified remote change' };
};

function allEvents(): WorldEvent[] { return structuredClone(FIXTURE.events); }

function rig() {
    const store = new Store({ path: ':memory:', session: 'live-replay-test' });
    const world = new ReplayWorldClient({ events: [], contractors: [PLUMBER, GAS_SAFE] });
    const graph = new Graph({ store, world, assess: scripted });
    return { store, world, graph };
}

async function drive(graph: Graph, events: WorldEvent[]) {
    for (const event of events)
        await graph.processEvent(event);
}

test('live replay: tenant leak opens exactly one case and later update attaches to the same case', async () => {
    const { store, world, graph } = rig();
    try {
        const events = allEvents();
        const evt2 = events.find(e => e.id === 'evt_2')!;
        const evt5 = events.find(e => e.id === 'evt_5')!;
        await drive(graph, [evt2, evt5]);
        const issues = store.issues();
        const sarah = issues.filter(i => i.actorId === 'act_tenant_1');
        assert.equal(sarah.length, 1, 'exactly one tenant issue for Sarah, not two');
        const creates = world.writes.filter(w => w.operation === 'createCase');
        const patches = world.writes.filter(w => w.operation === 'patchCase');
        assert.equal(creates.length, 1, 'exactly one case created for Sarah\'s leak');
        assert.equal(patches.length, 1, 'exactly one patch applied to that same case');
        const createdId = creates[0]!.id;
        assert.equal(patches[0]!.id, createdId, 'patch targets the same case id');
        assert.equal(sarah[0]!.remoteCase?.id, createdId);
        assert.equal(sarah[0]!.remoteCase?.urgency, 'high');
    }
    finally {
        store.close();
    }
});

test('live replay: case.acknowledged reconciles silently and produces no second create', async () => {
    const { store, world, graph } = rig();
    try {
        const events = allEvents();
        const ids = ['evt_2', 'evt_5', 'evt_10', 'evt_13'];
        await drive(graph, events.filter(e => ids.includes(e.id)));
        const creates = world.writes.filter(w => w.operation === 'createCase');
        assert.equal(creates.length, 1, 'acknowledgement must not spawn an extra create');
        const review = store.traces().filter(t => t.edge === 'review');
        for (const r of review)
            assert.ok(!/acknowledged/i.test(r.reason ?? ''), 'acknowledgement not mislabelled review-unknown');
    }
    finally {
        store.close();
    }
});

test('live replay: landlord £150 attaches to the open sink case, requests a quote, never asks which property', async () => {
    const { store, world, graph } = rig();
    try {
        const events = allEvents();
        const ids = ['evt_2', 'evt_5', 'evt_10', 'evt_13', 'evt_17'];
        await drive(graph, events.filter(e => ids.includes(e.id)));
        const issues = store.issues();
        // No placeholder/empty landlord issues allowed.
        for (const issue of issues) {
            if (issue.actorId === 'act_landlord_1')
                assert.fail('a landlord-owned issue was created from evt_17; the message must attach to Sarah\'s existing case');
        }
        const sarah = issues.filter(i => i.actorId === 'act_tenant_1');
        assert.equal(sarah.length, 1);
        const landlordMessages = world.writes.filter(w => w.operation === 'sendMessage' && w.id === 'act_landlord_1').map(w => (w.input as { body: string }).body);
        for (const body of landlordMessages) {
            assert.ok(!/which property/i.test(body), 'landlord already named Flat 12; never ask which property');
            assert.ok(!/which issue/i.test(body), 'landlord named one case only; never ask which issue');
        }
        const engagement = sarah[0]!.engagement;
        assert.equal(engagement?.notedBudgetGbp, 150, 'landlord\'s £150 ceiling is recorded');
        assert.equal(engagement?.awaitingContractor, 'quote', 'proposed contractor is asked for a written quote');
        assert.equal(engagement?.landlordId, 'act_landlord_1');
        const contractorAsks = world.writes.filter(w => w.operation === 'sendMessage' && w.id === PLUMBER.id);
        assert.ok(contractorAsks.length >= 1, 'contractor was asked for a written quote');
    }
    finally {
        store.close();
    }
});

test('live replay: tenant gas leak at evt_115 opens an emergency case with external escalation and human action', async () => {
    const { store, world, graph } = rig();
    try {
        const events = allEvents();
        const evt115 = events.find(e => e.id === 'evt_115')!;
        await graph.processEvent(evt115);
        const tom = store.issues().find(i => i.actorId === 'act_tenant_2');
        assert.ok(tom, 'gas report creates an issue');
        assert.equal(tom!.urgency, 'emergency');
        assert.equal(tom!.scope, 'externalEmergency');
        assert.ok(tom!.humanAction && /gas|emergency|999|evacuate/i.test(tom!.humanAction), 'human action names the external emergency response');
        const createCase = world.writes.filter(w => w.operation === 'createCase');
        assert.equal(createCase.length, 1);
    }
    finally {
        store.close();
    }
});

test('live replay: session.ended stops the worker with no further mutations', async () => {
    const { store, world, graph } = rig();
    try {
        const events = allEvents();
        // Drive through session.ended; then re-processing any later message must not mutate.
        await drive(graph, events);
        const writesBefore = world.writes.length;
        // Simulated subsequent attempt: if the loop ignored session.ended, extra writes
        // would appear. Replay the last message event and confirm no new mutations.
        const last = events[events.length - 2]!; // last non-session.ended message
        await graph.processEvent(last);
        assert.equal(world.writes.length, writesBefore, 'no mutations after session.ended');
        assert.ok(store.meta('mutationsStopped'), 'session.ended records the mutationsStopped meta');
    }
    finally {
        store.close();
    }
});

test('live replay: full fixture runs without placeholder landlord issues and without "Which issue?" loops', async () => {
    const { store, world, graph } = rig();
    try {
        await drive(graph, allEvents());
        const issues = store.issues();
        for (const issue of issues) {
            if (issue.actorId === 'act_landlord_1' && issue.evidence.every(e => e.actor?.role === 'landlord'))
                assert.fail('a landlord-only placeholder issue was created; landlord mail must attach to the real case');
        }
        const landlordMessages = world.writes.filter(w => w.operation === 'sendMessage' && w.id === 'act_landlord_1').map(w => (w.input as { body: string }).body);
        const whichLoops = landlordMessages.filter(b => /which issue|which property/i.test(b)).length;
        assert.equal(whichLoops, 0, 'the "Which issue?" / "Which property?" loop must not recur');
        // Verify: the regression never writes more than one tenant-sink case + its single patch,
        // plus the gas case for Tom.
        const createCases = world.writes.filter(w => w.operation === 'createCase');
        assert.equal(createCases.length, 2, 'one case for Sarah, one for Tom');
        // Satisfy unused-var lint
        void issues;
    }
    finally {
        store.close();
    }
});

// Help silence the unused-import warning if `Issue`/`Observation` are not used
// in a given trim. They stay in the signature import to document intent.
void ({} as Issue | Observation);
