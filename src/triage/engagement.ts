import type { CasePatch, Contractor, ContractorAssessment, Engagement, Issue, LandlordDecision, WorkOrder, WorkOrderCreate, WorkOrderPatch } from '../types.js';
import { quoteWithin, slotFitsTimeframe } from './contractor-reply.js';
import { inferTrade, proposalFrom, selectContractor } from './directory.js';
import { rememberLandlord } from './landlord.js';
export interface SendEffect { op: 'sendMessage'; actorId: string; body: string }
export interface CreateEffect { op: 'createWorkOrder'; input: WorkOrderCreate }
export interface PatchEffect { op: 'patchWorkOrder'; id: string; input: WorkOrderPatch }
export interface PatchCaseEffect { op: 'patchCase'; id: string; input: CasePatch }
export type Effect = SendEffect | CreateEffect | PatchEffect | PatchCaseEffect;
export interface Plan {
    engagement: Engagement;
    effects: Effect[];
    mirrorOrders?: WorkOrder[];
    status?: Issue['status'];
    humanAction?: string;
}
export function cloneEngagement(issue: Issue): Engagement {
    const current = issue.engagement;
    return {
        excludedContractorIds: [...(current?.excludedContractorIds ?? [])],
        ...(current?.trade ? { trade: current.trade } : {}),
        ...(current?.proposal ? { proposal: { ...current.proposal } } : {}),
        ...(current?.landlordId ? { landlordId: current.landlordId } : {}),
        ...(current?.landlordWrote ? { landlordWrote: true } : {}),
        ...(current?.landlordQuestion ? { landlordQuestion: current.landlordQuestion } : {}),
        ...(current?.queuedBriefing ? { queuedBriefing: current.queuedBriefing } : {}),
        ...(current?.briefingSent ? { briefingSent: true } : {}),
        ...(current?.rejected ? { rejected: true } : {}),
        ...(current?.unconditional ? { unconditional: true } : {}),
        ...(current?.terms ? { terms: { ...current.terms } } : {}),
        ...(current?.notedBudgetGbp !== undefined ? { notedBudgetGbp: current.notedBudgetGbp } : {}),
        ...(current?.quoteGbp !== undefined ? { quoteGbp: current.quoteGbp } : {}),
        ...(current?.slot ? { slot: current.slot } : {}),
        ...(current?.unavailable ? { unavailable: true } : {}),
        ...(current?.awaitingContractor ? { awaitingContractor: current.awaitingContractor } : {}),
        ...(current?.order ? { order: { ...current.order } } : {}),
        ...(current?.visitConfirmedEventId ? { visitConfirmedEventId: current.visitConfirmedEventId } : {}),
        ...(current?.replacement ? { replacement: true } : {}),
        ...(current?.pendingTenantSlot ? { pendingTenantSlot: current.pendingTenantSlot } : {}),
        ...(current?.tenantSlotQuestion ? { tenantSlotQuestion: current.tenantSlotQuestion } : {}),
    };
}
function liveOrder(engagement: Engagement): WorkOrder | undefined {
    return engagement.order && engagement.order.status !== 'declined' ? engagement.order : undefined;
}
function review(engagement: Engagement, reason: string): Plan {
    return { engagement, effects: [], status: 'review', humanAction: reason };
}
function budgetPhrase(engagement: Engagement): string {
    const terms = engagement.terms;
    if (!terms)
        return 'no budget';
    return terms.inclusive ? `£${terms.budgetGbp} or less` : `under £${terms.budgetGbp}`;
}
function send(actorId: string, body: string): SendEffect { return { op: 'sendMessage', actorId, body }; }
function quoteQuestion(issue: Issue, engagement: Engagement): string {
    const title = issue.remoteCase?.title ?? 'the repair';
    const noted = engagement.notedBudgetGbp !== undefined ? ` The landlord asked for the price in writing and noted £${engagement.notedBudgetGbp}; that figure is not approval to start work.` : '';
    return `Please send a written estimate for "${title}".${noted} This is a question, not a work order.`;
}
function bothQuestion(issue: Issue, engagement: Engagement): string {
    const title = issue.remoteCase?.title ?? 'the repair';
    return `Please send a written quote and the visit time you can offer for "${title}". The landlord is considering approval only if the quote is ${budgetPhrase(engagement)} and the visit fits this timeframe: ${engagement.terms?.timeframe}. This is a question, not a work order.`;
}
function slotQuestion(engagement: Engagement): string {
    const known = engagement.quoteGbp !== undefined ? ` The quote on record is £${engagement.quoteGbp}.` : '';
    return `Please send the visit time you can offer.${known} This is a question, not a work order.`;
}
function priceQuestion(engagement: Engagement): string {
    const known = engagement.slot && !engagement.unavailable ? ` The visit time on record is ${engagement.slot}.` : '';
    return `Please send the written price for this job.${known} This is a question, not a work order.`;
}
function negotiation(engagement: Engagement, existingOrder = false): string {
    const outcome = existingOrder
        ? 'The price is recorded on the existing work order and landlord approval is false. Please send an updated approval if you want to continue.'
        : 'Those figures miss the stored conditions, so no work order was created. Please send an updated approval if you want to continue.';
    return [
        `The contractor ${engagement.proposal?.name ?? 'on this case'} quoted ${engagement.quoteGbp !== undefined ? `£${engagement.quoteGbp}` : 'no price'}.`,
        `Assessed availability: ${engagement.unavailable ? 'unavailable' : (engagement.slot ?? 'not yet known')}.`,
        `Directory availability: ${engagement.proposal?.directoryAvailability ?? 'not listed'}.`,
        engagement.terms ? `Current conditions: ${budgetPhrase(engagement)}, timeframe ${engagement.terms.timeframe}.` : 'No conditional approval is stored.',
        outcome,
    ].join(' ');
}
function hireInput(issue: Issue, engagement: Engagement): WorkOrderCreate | undefined {
    if (!issue.remoteCase || !engagement.proposal)
        return undefined;
    const input: WorkOrderCreate = { case_id: issue.remoteCase.id, contractor_id: engagement.proposal.id };
    if (engagement.slot && !engagement.unavailable)
        input.slot = engagement.slot;
    if (engagement.quoteGbp !== undefined)
        input.cost_estimate_gbp = engagement.quoteGbp;
    return input;
}
function termsMet(engagement: Engagement): boolean {
    const terms = engagement.terms;
    return !!terms && engagement.quoteGbp !== undefined && !!engagement.slot && !engagement.unavailable && quoteWithin(engagement.quoteGbp, terms) && slotFitsTimeframe(engagement.slot, terms.timeframe);
}
function termsMiss(engagement: Engagement): boolean {
    const terms = engagement.terms;
    if (!terms)
        return false;
    if (engagement.unavailable)
        return true;
    if (engagement.quoteGbp !== undefined && !quoteWithin(engagement.quoteGbp, terms))
        return true;
    if (engagement.slot && !slotFitsTimeframe(engagement.slot, terms.timeframe))
        return true;
    return false;
}
function toLandlord(engagement: Engagement, body: string): Effect[] {
    return engagement.landlordId ? [send(engagement.landlordId, body)] : [];
}
function askContractor(engagement: Engagement, body: string): Plan | undefined {
    if (!engagement.proposal)
        return undefined;
    return { engagement, effects: [send(engagement.proposal.id, body)] };
}
export function briefingBody(issue: Issue): string {
    const proposal = issue.engagement?.proposal;
    if (!proposal)
        throw new Error('Briefing requires a proposed contractor');
    const report = issue.evidence.filter(evidence => evidence.actor?.role === 'tenant').map(evidence => evidence.body).join('\n') || 'No tenant report is stored.';
    return [
        'A tenant maintenance report was received.',
        `Case: ${issue.remoteCase?.title ?? 'Untitled'}.`,
        `Urgency: ${issue.urgency ?? 'unspecified'}.`,
        `Tenant report: ${report}`,
        `Proposed contractor: ${proposal.name}, trade ${proposal.trade}, rating ${proposal.rating}, directory availability ${proposal.directoryAvailability}.`,
        'Quote: not yet known.',
        'Visit time: not yet known.',
        'No work is ordered until you approve it.',
    ].join('\n');
}
export type DraftResult = { engagement: Engagement; briefing?: string } | { review: string };
export function draftProposal(issue: Issue, contractors: Contractor[], landlordId?: string): DraftResult | undefined {
    if (issue.engagement?.proposal || issue.engagement?.order)
        return undefined;
    if (issue.scope === 'externalEmergency' || issue.scope === 'nonMaintenance' || issue.scope === 'unknown')
        return undefined;
    if (issue.urgency !== 'medium' && issue.urgency !== 'high')
        return undefined;
    // Empty directory: nothing to propose (offline replays without contractors stay silent).
    if (!contractors.length)
        return undefined;
    const text = [issue.remoteCase?.title, issue.remoteCase?.description, ...issue.evidence.map(evidence => evidence.body)].filter((part): part is string => !!part).join('\n');
    const trade = inferTrade(text, contractors);
    if (!trade)
        return { review: 'No exact trade could be inferred from the report; contractor proposal held for review' };
    const chosen = selectContractor(contractors, trade, issue.engagement?.excludedContractorIds ?? []);
    if (!chosen)
        return { review: `No explicitly available ${trade} contractor remains after exclusions; proposal held for review` };
    const engagement = cloneEngagement(issue);
    engagement.trade = trade;
    engagement.proposal = proposalFrom(chosen);
    const wrote = issue.evidence.some(evidence => evidence.actor?.role === 'landlord') || engagement.landlordWrote;
    const briefing = briefingBody({ ...issue, engagement });
    if (wrote)
        return { engagement };
    if (landlordId) {
        engagement.landlordId = landlordId;
        engagement.briefingSent = true;
        return { engagement, briefing };
    }
    engagement.queuedBriefing = briefing;
    return { engagement };
}
export function planLandlord(issue: Issue, decision: LandlordDecision, actorId: string): Plan {
    const engagement = cloneEngagement(issue);
    rememberLandlord(engagement, actorId);
    if (decision.kind === 'review')
        return review(engagement, decision.reason);
    if (decision.kind === 'ask') {
        // Remember the exact outstanding question so the landlord's next
        // message is routed back here and interpreted as its answer, instead
        // of being treated as a brand-new, property-less enquiry.
        engagement.landlordQuestion = decision.question;
        return { engagement, effects: [send(actorId, decision.question)] };
    }
    // Any substantive decision answers/clears the outstanding question.
    // (`review` above deliberately keeps it: the issue is held for a human,
    // and a later landlord message must route back to that held issue.)
    delete engagement.landlordQuestion;
    if (decision.kind === 'reject') {
        engagement.rejected = true;
        engagement.unconditional = false;
        delete engagement.awaitingContractor;
        const order = liveOrder(engagement);
        if (!order)
            return { engagement, effects: [], humanAction: 'Landlord rejected the engagement before a work order existed' };
        return { engagement, status: 'review', humanAction: 'Landlord rejected the engagement after a work order existed', effects: [{ op: 'patchWorkOrder', id: order.id, input: { landlord_approved: false } }, send(order.contractor_id, 'The landlord has rejected this engagement. The work order remains on record and is not described as cancelled. Please do not proceed with the visit.')] };
    }
    if (decision.kind === 'requestQuote' || decision.kind === 'requestAvailability') {
        if (decision.kind === 'requestQuote' && decision.notedBudgetGbp !== undefined)
            engagement.notedBudgetGbp = decision.notedBudgetGbp;
        if (!engagement.proposal)
            return review(engagement, 'No proposed contractor to question');
        engagement.awaitingContractor = decision.kind === 'requestQuote' ? 'quote' : 'availability';
        const body = decision.kind === 'requestQuote' ? quoteQuestion(issue, engagement) : 'Please send the visit times you can offer. This is a question, not a work order.';
        return { engagement, effects: [send(engagement.proposal.id, body)] };
    }
    if (decision.kind === 'approve') {
        engagement.unconditional = true;
        engagement.rejected = false;
        delete engagement.terms;
        delete engagement.awaitingContractor;
        const order = liveOrder(engagement);
        if (order) {
            const patch: WorkOrderPatch = { landlord_approved: true };
            if (engagement.quoteGbp !== undefined)
                patch.cost_estimate_gbp = engagement.quoteGbp;
            if (order.status === 'accepted' && engagement.slot && !engagement.unavailable)
                patch.slot = engagement.slot;
            return { engagement, effects: [{ op: 'patchWorkOrder', id: order.id, input: patch }] };
        }
        const input = hireInput(issue, engagement);
        if (!input)
            return review(engagement, 'Approval needs a linked case and a proposed contractor');
        return { engagement, effects: [{ op: 'createWorkOrder', input }] };
    }
    engagement.terms = { budgetGbp: decision.budgetGbp, inclusive: decision.inclusive, timeframe: decision.timeframe };
    engagement.unconditional = false;
    engagement.rejected = false;
    const order = liveOrder(engagement);
    if (termsMet(engagement)) {
        delete engagement.awaitingContractor;
        if (order) {
            const patch: WorkOrderPatch = { landlord_approved: true, cost_estimate_gbp: engagement.quoteGbp };
            if (order.status === 'accepted' && engagement.slot)
                patch.slot = engagement.slot;
            return { engagement, effects: [{ op: 'patchWorkOrder', id: order.id, input: patch }] };
        }
        const input = hireInput(issue, engagement);
        if (!input)
            return review(engagement, 'Updated approval needs a linked case and a proposed contractor');
        return { engagement, effects: [{ op: 'createWorkOrder', input }] };
    }
    if (termsMiss(engagement) || (engagement.quoteGbp !== undefined && engagement.slot && !termsMet(engagement))) {
        engagement.awaitingContractor = 'revision';
        const asked = askContractor(engagement, `The landlord can approve ${budgetPhrase(engagement)} within this timeframe: ${engagement.terms.timeframe}. Your quote is ${engagement.quoteGbp !== undefined ? `£${engagement.quoteGbp}` : 'not yet received'} and your offered time is ${engagement.unavailable ? 'unavailable' : (engagement.slot ?? 'not yet received')}. Please send a revised quote and visit time if you can meet those conditions. This is a question, not a work order.`);
        return asked ?? review(engagement, 'No proposed contractor to revise');
    }
    if (engagement.quoteGbp !== undefined && !engagement.slot) {
        engagement.awaitingContractor = 'availability';
        return askContractor(engagement, slotQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
    }
    if (engagement.slot && engagement.quoteGbp === undefined) {
        engagement.awaitingContractor = 'quote';
        return askContractor(engagement, priceQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
    }
    engagement.awaitingContractor = 'both';
    return askContractor(engagement, bothQuestion(issue, engagement)) ?? review(engagement, 'No proposed contractor to question');
}
function absorbReply(engagement: Engagement, assessment: ContractorAssessment): void {
    if (assessment.kind === 'quote' || assessment.kind === 'quoteAndAvailability') {
        engagement.quoteGbp = assessment.quoteGbp;
        if (assessment.kind === 'quote')
            engagement.unavailable = false;
    }
    if (assessment.kind === 'availability' || assessment.kind === 'quoteAndAvailability') {
        engagement.slot = assessment.slot;
        engagement.unavailable = !!assessment.unavailable;
    }
}
export function planContractor(issue: Issue, assessment: ContractorAssessment, evidenceId: string, contractors: Contractor[]): Plan {
    const engagement = cloneEngagement(issue);
    if (engagement.rejected && assessment.kind !== 'visitConfirmed')
        return { engagement, effects: [], humanAction: 'Landlord rejected the engagement; contractor reply makes no further change' };
    if (assessment.kind === 'visitConfirmed') {
        const order = liveOrder(engagement);
        if (!order || order.status !== 'accepted' || !order.slot)
            return review(engagement, 'Visit confirmation requires a slot on the accepted order');
        engagement.visitConfirmedEventId = evidenceId;
        const effects: Effect[] = [
            ...toLandlord(engagement, `The contractor confirmed the visit for ${order.slot}.`),
            send(issue.actorId, `The contractor confirmed the visit for ${order.slot}.`),
        ];
        return { engagement, effects };
    }
    if (assessment.kind === 'completed') {
        const order = liveOrder(engagement);
        if (!order || order.status !== 'accepted' || !engagement.visitConfirmedEventId || !issue.remoteCase)
            return review(engagement, 'Completion requires an accepted order with a recorded visit confirmation');
        delete engagement.awaitingContractor;
        return {
            engagement,
            effects: [
                { op: 'patchCase', id: issue.remoteCase.id, input: { status: 'resolved' } },
                ...toLandlord(engagement, 'The contractor reported the repair complete; the case is marked resolved.'),
                send(issue.actorId, 'The contractor reported the repair complete; thank you for your patience.'),
            ],
        };
    }
    if (assessment.kind === 'reject')
        return planEmailDecline(engagement, contractors);
    if (assessment.kind === 'review')
        return review(engagement, assessment.reason);
    absorbReply(engagement, assessment);
    const order = liveOrder(engagement);
    if (order)
        return planPostOrder(issue, engagement, order);
    if (!engagement.awaitingContractor)
        return review(engagement, 'No outstanding contractor question');
    if (engagement.terms) {
        if (termsMiss(engagement)) {
            delete engagement.awaitingContractor;
            return { engagement, effects: toLandlord(engagement, negotiation(engagement)) };
        }
        if (termsMet(engagement)) {
            delete engagement.awaitingContractor;
            const input = hireInput(issue, engagement);
            if (!input)
                return review(engagement, 'Hire needs a linked case and a proposed contractor');
            return { engagement, effects: [{ op: 'createWorkOrder', input }] };
        }
        if (engagement.quoteGbp !== undefined && !engagement.slot) {
            engagement.awaitingContractor = 'availability';
            return askContractor(engagement, slotQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
        }
        if (engagement.slot && engagement.quoteGbp === undefined) {
            engagement.awaitingContractor = 'quote';
            return askContractor(engagement, priceQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
        }
        return review(engagement, 'Reply did not include a usable quote or visit time');
    }
    if ((engagement.awaitingContractor === 'quote' || engagement.awaitingContractor === 'revision' || engagement.awaitingContractor === 'both') && engagement.quoteGbp !== undefined && engagement.awaitingContractor !== 'both') {
        delete engagement.awaitingContractor;
        return { engagement, effects: toLandlord(engagement, `The written price from ${engagement.proposal?.name ?? 'the contractor'} is £${engagement.quoteGbp}. No work order has been created. Please tell us how you want to proceed.`) };
    }
    if (engagement.awaitingContractor === 'both' && engagement.quoteGbp !== undefined && !engagement.slot) {
        engagement.awaitingContractor = 'availability';
        return askContractor(engagement, slotQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
    }
    if ((engagement.awaitingContractor === 'quote' || engagement.awaitingContractor === 'both') && engagement.quoteGbp === undefined && engagement.slot) {
        engagement.awaitingContractor = 'quote';
        return askContractor(engagement, priceQuestion(engagement)) ?? review(engagement, 'No proposed contractor to question');
    }
    if (engagement.awaitingContractor === 'availability' && engagement.slot && !engagement.unavailable) {
        delete engagement.awaitingContractor;
        return { engagement, effects: toLandlord(engagement, `The contractor ${engagement.proposal?.name ?? ''} can offer this visit time: ${engagement.slot}. No work order has been created. Please tell us how you want to proceed.`) };
    }
    if ((engagement.awaitingContractor === 'quote' || engagement.awaitingContractor === 'revision') && engagement.quoteGbp !== undefined) {
        delete engagement.awaitingContractor;
        return { engagement, effects: toLandlord(engagement, `The written price from ${engagement.proposal?.name ?? 'the contractor'} is £${engagement.quoteGbp}. No work order has been created. Please tell us how you want to proceed.`) };
    }
    return review(engagement, 'Contractor reply did not answer the outstanding question');
}
function planEmailDecline(engagement: Engagement, contractors: Contractor[]): Plan {
    const order = liveOrder(engagement);
    const declinedId = order?.contractor_id ?? engagement.proposal?.id;
    if (!declinedId)
        return review(engagement, 'Decline has no contractor to withdraw');
    if (!engagement.excludedContractorIds.includes(declinedId))
        engagement.excludedContractorIds.push(declinedId);
    const declinedName = contractors.find(contractor => contractor.id === declinedId)?.name ?? engagement.proposal?.name ?? declinedId;
    if (order) {
        delete engagement.awaitingContractor;
        return { engagement, status: 'review', humanAction: 'Contractor declined by email after a work order existed; no replacement order was raised', effects: toLandlord(engagement, `${declinedName} declined by email after the work order existed. No replacement order was created.`) };
    }
    const trade = engagement.trade ?? engagement.proposal?.trade ?? contractors.find(contractor => contractor.id === declinedId)?.trade;
    const next = trade ? selectContractor(contractors, trade, engagement.excludedContractorIds) : undefined;
    if (next) {
        engagement.proposal = proposalFrom(next);
        engagement.trade = next.trade;
    }
    else
        delete engagement.proposal;
    delete engagement.awaitingContractor;
    const body = next
        ? `${declinedName} declined the job before a work order was raised. No work order was created. Next proposed contractor: ${next.name}, trade ${next.trade}, rating ${next.rating}, directory availability ${next.availability}.`
        : `${declinedName} declined the job before a work order was raised. No work order was created. No other exact-trade contractor is explicitly available.`;
    return { engagement, effects: toLandlord(engagement, body) };
}
function planPostOrder(issue: Issue, engagement: Engagement, order: WorkOrder): Plan {
    // Changed quote/slot after a booked slot (or visit confirmed) holds for review — never auto-patch with landlord_approved: false.
    // First-time recording of a quote/slot on the accepted order still proceeds.
    if ((order.slot || engagement.visitConfirmedEventId) && order.status === 'accepted') {
        const quoteChanged = engagement.quoteGbp !== undefined && order.cost_estimate_gbp !== null && engagement.quoteGbp !== order.cost_estimate_gbp;
        const slotChanged = !!engagement.slot && !engagement.unavailable && order.slot !== null && engagement.slot !== order.slot && engagement.slot !== engagement.pendingTenantSlot;
        if (quoteChanged || slotChanged)
            return review(engagement, 'Contractor changed terms after booking; held for operator review');
    }
    const patch: WorkOrderPatch = {};
    if (engagement.quoteGbp !== undefined && engagement.quoteGbp !== order.cost_estimate_gbp)
        patch.cost_estimate_gbp = engagement.quoteGbp;
    const met = termsMet(engagement);
    const miss = termsMiss(engagement);
    if (met)
        patch.landlord_approved = true;
    else if (miss)
        patch.landlord_approved = false;
    else if (engagement.unconditional && !engagement.replacement && engagement.quoteGbp !== undefined && !engagement.terms)
        patch.landlord_approved = true;
    const effects: Effect[] = [];
    if (Object.keys(patch).length)
        effects.push({ op: 'patchWorkOrder', id: order.id, input: patch });
    // Slot on an accepted order requires tenant confirmation before PATCH.
    if (engagement.slot && !engagement.unavailable && order.status === 'accepted' && engagement.slot !== order.slot && !engagement.pendingTenantSlot) {
        const question = `The contractor offered ${engagement.slot} for "${issue.remoteCase?.title ?? 'the repair'}". Please confirm that time works, or tell us a different time that does.`;
        engagement.pendingTenantSlot = engagement.slot;
        engagement.tenantSlotQuestion = question;
        effects.push(send(issue.actorId, question));
    }
    if (miss)
        effects.push(...toLandlord(engagement, negotiation(engagement, true)));
    else if (!met && engagement.terms && engagement.quoteGbp !== undefined && !engagement.slot) {
        engagement.awaitingContractor = 'availability';
        const asked = askContractor(engagement, slotQuestion(engagement));
        if (asked)
            effects.push(...asked.effects);
    }
    else if (!met && engagement.terms && engagement.slot && engagement.quoteGbp === undefined) {
        engagement.awaitingContractor = 'quote';
        const asked = askContractor(engagement, priceQuestion(engagement));
        if (asked)
            effects.push(...asked.effects);
    }
    return { engagement, effects };
}
export function planWorkOrderAccepted(issue: Issue): Plan {
    const engagement = cloneEngagement(issue);
    const order = engagement.order;
    if (!order || order.status !== 'pending')
        return review(engagement, 'Acceptance could not be tied to the pending order');
    order.status = 'accepted';
    const patch: WorkOrderPatch = {};
    const met = termsMet(engagement) || (engagement.unconditional && !engagement.replacement && !engagement.rejected);
    if (met && order.landlord_approved !== true)
        patch.landlord_approved = true;
    engagement.order = order;
    const effects: Effect[] = Object.keys(patch).length ? [{ op: 'patchWorkOrder', id: order.id, input: patch }] : [];
    // Defer slot onto the accepted order until the tenant confirms it.
    if (!order.slot && engagement.slot && !engagement.unavailable && !engagement.pendingTenantSlot) {
        const question = `The contractor offered ${engagement.slot} for "${issue.remoteCase?.title ?? 'the repair'}". Please confirm that time works, or tell us a different time that does.`;
        engagement.pendingTenantSlot = engagement.slot;
        engagement.tenantSlotQuestion = question;
        effects.push(send(issue.actorId, question));
    }
    return { engagement, mirrorOrders: [{ ...order }], effects };
}
export function planTenantSlotReply(issue: Issue, text: string, evidenceId: string): Plan {
    const engagement = cloneEngagement(issue);
    const pending = engagement.pendingTenantSlot;
    const order = liveOrder(engagement);
    if (!pending || !order || order.status !== 'accepted')
        return review(engagement, 'No pending tenant slot confirmation');
    const confirm = /\b(yes|confirm|confirmed|that works|works for me|ok(?:ay)?|fine|agreed)\b/i.test(text) && !/\b(not|cannot|can't|different|instead|rather)\b/i.test(text);
    const changed = text.match(/\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning|\s+afternoon|\s+evening)?(?:\s+at)?(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i)?.[0]?.trim();
    delete engagement.tenantSlotQuestion;
    if (confirm && (!changed || changed.toLowerCase() === pending.toLowerCase())) {
        delete engagement.pendingTenantSlot;
        engagement.slot = pending;
        return { engagement, effects: [{ op: 'patchWorkOrder', id: order.id, input: { slot: pending } }] };
    }
    if (changed && changed.toLowerCase() !== pending.toLowerCase()) {
        delete engagement.pendingTenantSlot;
        engagement.slot = changed;
        const body = `The tenant cannot make ${pending} and asked for ${changed} instead. Please confirm whether you can attend then, or send another time. This is a question, not a work order.`;
        engagement.awaitingContractor = 'availability';
        return askContractor(engagement, body) ?? review(engagement, 'No proposed contractor to rebook');
    }
    return review(engagement, `Tenant slot reply was unclear (pending ${pending}; evidence ${evidenceId}); held for operator review`);
}
export function planWorkOrderDeclined(issue: Issue, contractors: Contractor[]): Plan {
    const engagement = cloneEngagement(issue);
    const order = engagement.order;
    if (!order || order.status !== 'pending')
        return review(engagement, 'Decline could not be tied to the pending order');
    order.status = 'declined';
    const mirrorOrders = [{ ...order }];
    engagement.order = order;
    if (!engagement.excludedContractorIds.includes(order.contractor_id))
        engagement.excludedContractorIds.push(order.contractor_id);
    if (engagement.rejected)
        return { engagement, mirrorOrders, effects: [], humanAction: 'Landlord already rejected this engagement; no replacement order' };
    const trade = contractors.find(contractor => contractor.id === order.contractor_id)?.trade ?? engagement.trade ?? engagement.proposal?.trade;
    const next = trade ? selectContractor(contractors, trade, engagement.excludedContractorIds) : undefined;
    const declinedName = contractors.find(contractor => contractor.id === order.contractor_id)?.name ?? order.contractor_id;
    delete engagement.quoteGbp;
    delete engagement.slot;
    engagement.unavailable = false;
    delete engagement.awaitingContractor;
    if (!next) {
        delete engagement.proposal;
        return { engagement, mirrorOrders, effects: toLandlord(engagement, `${declinedName} declined the work order. No other exact-trade contractor is explicitly available. No replacement order was created.`) };
    }
    engagement.proposal = proposalFrom(next);
    engagement.trade = next.trade;
    engagement.replacement = true;
    if (!issue.remoteCase)
        return review(engagement, 'Replacement needs the remote case');
    return { engagement, mirrorOrders, effects: [{ op: 'createWorkOrder', input: { case_id: issue.remoteCase.id, contractor_id: next.id } }, ...toLandlord(engagement, `${declinedName} declined the work order. ${next.name} is the replacement and has been sent the next work order. No further order was sent to ${declinedName}.`)] };
}
