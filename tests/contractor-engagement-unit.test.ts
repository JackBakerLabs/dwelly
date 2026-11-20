import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyLandlord, validateLandlordDecision, classifyContractor, validateContractorAssessment, matchProperty,
    draftProposal, planLandlord, planContractor, planWorkOrderAccepted, planWorkOrderDeclined, proposalFrom, NAME_PROPERTY_QUESTION,
} from '../src/triage/index.js';
import type { Actor, Contractor, ContractorAssessment, Issue, LandlordDecision, WorkOrder } from '../src/types.js';

/** Pure triage-helper tests: no graph, store, or world client. */

const A: Contractor = { id: 'c_a', name: 'Aqua Plumbing', trade: 'plumbing', availability: 'available', rating: 5 };
const B: Contractor = { id: 'c_b', name: 'Brook Plumbing', trade: 'plumbing', availability: 'available', rating: 4 };
const BUSY: Contractor = { id: 'c_busy', name: 'Busy Plumbing', trade: 'plumbing', availability: 'unavailable', rating: 5 };
const DIRECTORY = [A, B, BUSY, { id: 'c_e', name: 'Spark', trade: 'electrical', availability: 'available', rating: 5 }];
const LANDLORD: Actor = { id: 'act_landlord_1', role: 'landlord', name: 'David Okafor' };
const TENANT: Actor = { id: 'act_tenant_1', role: 'tenant', name: 'Sarah Mitchell' };
const SUBJECT = 'Re: maintenance case at 14 Elm Road, Flat 12';
const EVT16 = `${SUBJECT}\nHello, I will not sign off any repair over £150 without a written estimate from the contractor. I'll make a call once I see the price.`;
const CASE_ID = '483a38ac-90eb-4800-b72d-40c9280ea292';

function baseIssue(engagement: Issue['engagement'] = { excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A) }): Issue {
    return {
        id: 'issue-1', session: 's', actorId: TENANT.id, status: 'active', urgency: 'medium', scope: 'maintenance',
        remoteCase: { id: CASE_ID, title: 'Kitchen sink leak at Flat 12', description: null, urgency: 'medium', property_id: null, status: 'open', created_at: '2026-11-19T11:00:00Z', updated_at: '2026-11-19T11:00:00Z' },
        evidence: [
            { eventId: 'tenant_1', cursor: 1, actor: TENANT, body: 'The kitchen sink at 14 Elm Road, Flat 12 is leaking.', occurredAt: '2026-11-19T11:00:00Z' },
            { eventId: 'evt_16', cursor: 16, actor: LANDLORD, body: EVT16, occurredAt: '2026-11-19T12:00:00Z' },
        ],
        engagement,
    };
}
const order = (patch: Partial<WorkOrder> = {}): WorkOrder => ({ id: 'wo-1', case_id: CASE_ID, contractor_id: A.id, slot: null, status: 'pending', cost_estimate_gbp: null, landlord_approved: null, created_at: '2026-11-19T12:00:00Z', ...patch });
const terms = { budgetGbp: 200, inclusive: true, timeframe: 'on Thursday' };
const reply = (kind: ContractorAssessment['kind'], extra: Record<string, unknown>): ContractorAssessment => ({ channel: 'contractor', kind, evidenceIds: ['evt_16'], reason: 'test', ...extra } as ContractorAssessment);
const sent = (plan: { effects: { op: string }[] }, op: string) => plan.effects.filter(e => e.op === op);
const sentTo = (plan: { effects: { op: string; actorId?: string }[] }, id: string) => plan.effects.filter(e => e.op === 'sendMessage' && e.actorId === id);

test('classifyLandlord: evt_16 is requestQuote with the £150 noted, not an approval', () => {
    const decision = classifyLandlord(EVT16, ['evt_16']);
    assert.equal(decision.kind, 'requestQuote');
    assert.equal(decision.kind === 'requestQuote' ? decision.notedBudgetGbp : undefined, 150);
    assert.equal(validateLandlordDecision(LANDLORD, EVT16, decision, baseIssue()).kind, 'requestQuote');
});

test('classifyLandlord: approve, approveIf, reject, and one-sided conditions', () => {
    assert.equal(classifyLandlord('I approve this repair, please go ahead.', ['e']).kind, 'approve');
    const conditional = classifyLandlord('I approve this repair if the price is up to £200 and the visit is on Thursday.', ['e']);
    assert.equal(conditional.kind, 'approveIf');
    if (conditional.kind === 'approveIf') {
        assert.equal(conditional.budgetGbp, 200);
        assert.equal(conditional.inclusive, true);
        assert.match(conditional.timeframe, /thursday/i);
    }
    assert.equal(classifyLandlord('I reject this. Please do not proceed.', ['e']).kind, 'reject');
    assert.equal(classifyLandlord('I approve this if the price is up to £200.', ['e']).kind, 'ask');
    assert.equal(classifyLandlord('I approve this if the visit is on Thursday.', ['e']).kind, 'ask');
});

test('validateLandlordDecision: invented money, second landlord, and non-landlord senders are refused', () => {
    const invented: LandlordDecision = { channel: 'landlord', kind: 'approveIf', budgetGbp: 999, inclusive: true, timeframe: 'on Thursday', evidenceIds: ['evt_16'], reason: 'x' };
    assert.throws(() => validateLandlordDecision(LANDLORD, 'I approve if up to £200 on Thursday.', invented, baseIssue()), /Budget is not in/);
    const other = baseIssue({ excludedContractorIds: [], landlordId: 'someone_else', proposal: proposalFrom(A) });
    assert.throws(() => validateLandlordDecision(LANDLORD, EVT16, classifyLandlord(EVT16, ['evt_16']), other), /Second landlord/);
    assert.throws(() => validateLandlordDecision(TENANT, EVT16, classifyLandlord(EVT16, ['evt_16']), baseIssue()), /Unknown landlord actor/);
});

test('matchProperty: evt_16 names Flat 12 and attaches to the single open sink issue; unknown property is none', () => {
    const sink = baseIssue();
    const match = matchProperty(EVT16, [sink]);
    assert.equal(match.kind, 'one');
    assert.equal(matchProperty('Please go ahead with the repair.', [sink]).kind, 'none');
    assert.equal(matchProperty(EVT16, []).kind, 'none');
    const window: Issue = { ...baseIssue(), id: 'issue-2', remoteCase: { ...sink.remoteCase!, id: 'other', title: 'Flat 12 window latch' } };
    assert.equal(matchProperty(EVT16, [sink, window]).kind, 'many');
    assert.ok(NAME_PROPERTY_QUESTION.length > 0);
});

test('planLandlord requestQuote (evt_16): asks the proposed contractor only, no work order, no landlord message', () => {
    const issue = baseIssue();
    const plan = planLandlord(issue, classifyLandlord(EVT16, ['evt_16']), LANDLORD.id);
    assert.equal(sent(plan, 'createWorkOrder').length, 0);
    assert.equal(sentTo(plan, A.id).length, 1);
    assert.equal(sentTo(plan, LANDLORD.id).length, 0);
    assert.equal(plan.engagement.notedBudgetGbp, 150);
    assert.equal(plan.engagement.awaitingContractor, 'quote');
    assert.equal(plan.engagement.landlordId, LANDLORD.id);
});

test('planLandlord approveIf with nothing stored asks the contractor for both facts; approve hires one order', () => {
    const conditional = planLandlord(baseIssue(), { channel: 'landlord', kind: 'approveIf', ...terms, evidenceIds: ['evt_16'], reason: 'x' }, LANDLORD.id);
    assert.equal(sent(conditional, 'createWorkOrder').length, 0);
    assert.equal(conditional.engagement.awaitingContractor, 'both');
    assert.equal(sentTo(conditional, A.id).length, 1);
    const approved = planLandlord(baseIssue(), { channel: 'landlord', kind: 'approve', evidenceIds: ['evt_16'], reason: 'x' }, LANDLORD.id);
    assert.equal(sent(approved, 'createWorkOrder').length, 1);
    assert.deepEqual((approved.effects[0] as { input: unknown }).input, { case_id: CASE_ID, contractor_id: A.id });
});

test('classifyContractor: quote+slot, quote only, slot only, unavailable, decline, review', () => {
    const issue = baseIssue();
    assert.equal(classifyContractor(issue, 'My quote is £180 and I can attend on Thursday morning.', ['e']).kind, 'quoteAndAvailability');
    assert.equal(classifyContractor(issue, 'My quote is £180.', ['e']).kind, 'quote');
    assert.equal(classifyContractor(issue, 'I can attend on Thursday morning.', ['e']).kind, 'availability');
    const unavailable = classifyContractor(issue, 'My quote is £150 but I am unavailable this week.', ['e']);
    assert.equal(unavailable.kind, 'quoteAndAvailability');
    assert.equal(classifyContractor(issue, 'I must decline this job.', ['e']).kind, 'reject');
    assert.equal(classifyContractor(issue, 'Hello there.', ['e']).kind, 'review');
});

test('validateContractorAssessment: only the proposed contractor, and only figures present in the message', () => {
    const issue = baseIssue();
    const text = 'My quote is £180 and I can attend on Thursday morning.';
    const ok = classifyContractor(issue, text, ['evt_16']);
    assert.equal(validateContractorAssessment(issue, { id: A.id, role: 'contractor', name: A.name }, text, ok).kind, 'quoteAndAvailability');
    assert.throws(() => validateContractorAssessment(issue, { id: B.id, role: 'contractor', name: B.name }, text, ok), /not the contractor/);
    assert.throws(() => validateContractorAssessment(issue, { id: A.id, role: 'contractor', name: A.name }, text, reply('quote', { quoteGbp: 99 })), /Quote is not in/);
    assert.throws(() => validateContractorAssessment(issue, { id: A.id, role: 'tenant', name: A.name }, text, ok), /Unknown contractor actor/);
});

test('planContractor match: in-budget quote and in-timeframe slot hire once and message nobody', () => {
    const issue = baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, terms, awaitingContractor: 'both' });
    const plan = planContractor(issue, reply('quoteAndAvailability', { quoteGbp: 180, slot: 'on Thursday morning' }), 'e', DIRECTORY);
    assert.equal(sent(plan, 'createWorkOrder').length, 1);
    assert.equal(sent(plan, 'sendMessage').length, 0);
    assert.deepEqual((plan.effects[0] as { input: unknown }).input, { case_id: CASE_ID, contractor_id: A.id, slot: 'on Thursday morning', cost_estimate_gbp: 180 });
});

test('planContractor miss: over budget, wrong slot, or unavailable asks the landlord and creates no order', () => {
    const issue = () => baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, terms, awaitingContractor: 'both' });
    for (const assessment of [
        reply('quoteAndAvailability', { quoteGbp: 240, slot: 'on Thursday afternoon' }),
        reply('quoteAndAvailability', { quoteGbp: 120, slot: 'on Saturday morning' }),
        reply('quoteAndAvailability', { quoteGbp: 120, slot: 'unavailable', unavailable: true }),
    ]) {
        const plan = planContractor(issue(), assessment, 'e', DIRECTORY);
        assert.equal(sent(plan, 'createWorkOrder').length, 0);
        assert.equal(sentTo(plan, LANDLORD.id).length, 1);
        assert.equal(sentTo(plan, A.id).length, 0);
        assert.match((plan.effects[0] as { body: string }).body, /updated approval/i);
    }
});

test('planLandlord updated approval: stored quote+slot covered hires with no contractor message; still missing counters', () => {
    const stored = () => baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, terms, quoteGbp: 240, slot: 'on Thursday afternoon' });
    const covered = planLandlord(stored(), { channel: 'landlord', kind: 'approveIf', budgetGbp: 250, inclusive: true, timeframe: 'on Thursday', evidenceIds: ['evt_16'], reason: 'x' }, LANDLORD.id);
    assert.equal(sent(covered, 'createWorkOrder').length, 1);
    assert.equal(sent(covered, 'sendMessage').length, 0);
    assert.equal((covered.effects[0] as { input: { cost_estimate_gbp?: number } }).input.cost_estimate_gbp, 240);
    const still = planLandlord(stored(), { channel: 'landlord', kind: 'approveIf', budgetGbp: 220, inclusive: true, timeframe: 'on Thursday', evidenceIds: ['evt_16'], reason: 'x' }, LANDLORD.id);
    assert.equal(sent(still, 'createWorkOrder').length, 0);
    assert.equal(sentTo(still, A.id).length, 1);
    assert.equal(still.engagement.awaitingContractor, 'revision');
});

test('planContractor pre-order decline: no work order, contractor excluded, next candidate only proposed', () => {
    const issue = baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, terms, awaitingContractor: 'both' });
    const plan = planContractor(issue, reply('reject', {}), 'e', DIRECTORY);
    assert.equal(sent(plan, 'createWorkOrder').length, 0);
    assert.deepEqual(plan.engagement.excludedContractorIds, [A.id]);
    assert.equal(plan.engagement.proposal?.id, B.id);
    assert.equal(sentTo(plan, LANDLORD.id).length, 1);
});

test('planWorkOrderDeclined: one replacement for the next contractor; none when no candidate or landlord rejected', () => {
    const pending = (extra: Partial<NonNullable<Issue['engagement']>> = {}) => baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, unconditional: true, order: order(), ...extra });
    const replaced = planWorkOrderDeclined(pending(), DIRECTORY);
    const creates = replaced.effects.filter(e => e.op === 'createWorkOrder') as { input: { contractor_id: string } }[];
    assert.equal(creates.length, 1);
    assert.equal(creates[0]!.input.contractor_id, B.id);
    assert.ok(replaced.engagement.excludedContractorIds.includes(A.id));
    assert.equal(sentTo(replaced, LANDLORD.id).length, 1);

    const none = planWorkOrderDeclined(pending(), [A, BUSY]);
    assert.equal(sent(none, 'createWorkOrder').length, 0);
    assert.equal(sentTo(none, LANDLORD.id).length, 1);

    const rejected = planWorkOrderDeclined(pending({ rejected: true }), DIRECTORY);
    assert.equal(rejected.effects.length, 0);
});

test('planContractor post-order quote: first quote on accepted order patches; later quote/slot change after booking holds for review', () => {
    const firstQuote = planContractor(
        baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, unconditional: true, order: order({ status: 'accepted', slot: 'on Thursday morning', cost_estimate_gbp: null, landlord_approved: true }) }),
        reply('quote', { quoteGbp: 190 }), 'e', DIRECTORY);
    assert.deepEqual(firstQuote.effects, [{ op: 'patchWorkOrder', id: 'wo-1', input: { cost_estimate_gbp: 190, landlord_approved: true } }]);

    const changed = planContractor(
        baseIssue({ excludedContractorIds: [], trade: 'plumbing', proposal: proposalFrom(A), landlordId: LANDLORD.id, terms, quoteGbp: 180, slot: 'on Thursday morning', order: order({ status: 'accepted', slot: 'on Thursday morning', cost_estimate_gbp: 180, landlord_approved: true }) }),
        reply('quote', { quoteGbp: 260 }), 'e', DIRECTORY);
    assert.equal(changed.status, 'review');
    assert.match(changed.humanAction ?? '', /changed terms after booking/i);
    assert.equal(changed.effects.length, 0);
});

test('planContractor visitConfirmed: notifies tenant and landlord; refused without a slot on the accepted order', () => {
    const accepted = baseIssue({ excludedContractorIds: [], proposal: proposalFrom(A), landlordId: LANDLORD.id, order: order({ status: 'accepted', slot: 'on Thursday morning' }) });
    const confirm = 'Visit is confirmed: on Thursday morning.';
    const assessment = classifyContractor(accepted, confirm, ['evt_16']);
    assert.equal(assessment.kind, 'visitConfirmed');
    assert.equal(validateContractorAssessment(accepted, { id: A.id, role: 'contractor', name: A.name }, confirm, assessment).kind, 'visitConfirmed');
    const plan = planContractor(accepted, assessment, 'evt_16', DIRECTORY);
    assert.equal(plan.engagement.visitConfirmedEventId, 'evt_16');
    assert.equal(sentTo(plan, LANDLORD.id).length, 1);
    assert.equal(sentTo(plan, accepted.actorId).length, 1);

    const noSlot = baseIssue({ excludedContractorIds: [], proposal: proposalFrom(A), order: order({ status: 'accepted', slot: null }) });
    assert.equal(classifyContractor(noSlot, confirm, ['e']).kind, 'review');
});

test('planWorkOrderAccepted asks the tenant to confirm the stored slot; draftProposal never creates an order and skips low urgency', () => {
    const issue = baseIssue({ excludedContractorIds: [], proposal: proposalFrom(A), landlordId: LANDLORD.id, unconditional: true, slot: 'on Thursday morning', order: order() });
    const plan = planWorkOrderAccepted(issue);
    assert.equal(plan.engagement.order?.status, 'accepted');
    assert.equal(plan.engagement.pendingTenantSlot, 'on Thursday morning');
    assert.deepEqual(plan.effects[0], { op: 'patchWorkOrder', id: 'wo-1', input: { landlord_approved: true } });
    assert.equal(plan.effects[1]?.op, 'sendMessage');
    assert.equal((plan.effects[1] as { actorId: string }).actorId, issue.actorId);

    const fresh: Issue = { ...baseIssue(), engagement: undefined };
    const drafted = draftProposal(fresh, DIRECTORY);
    assert.ok(drafted && !('review' in drafted));
    assert.equal(drafted.engagement.proposal?.id, A.id);
    assert.equal(draftProposal({ ...fresh, urgency: 'low' }, DIRECTORY), undefined);
    assert.equal(draftProposal({ ...fresh, scope: 'externalEmergency' }, DIRECTORY), undefined);
});
