import type { Actor, ApprovalTerms, ContractorAssessment, Issue } from '../types.js';
import { amountAppears, parsePounds } from './landlord.js';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DECLINE = /\b(i\s+(?:must\s+)?decline|i\s+(?:cannot|can't)\s+take|i\s+refuse|we\s+decline|unable\s+to\s+take\s+(?:this|the)\s+job)\b/i;
const VISIT = /\b(?:confirm(?:ing)?\s+the\s+visit|visit\s+(?:is\s+)?confirmed)\b/i;
const COMPLETED = /\b(?:(?:job|work|repair|visit)\s+(?:is\s+)?(?:complete|completed|done|finished)|(?:i(?:'ve| have)\s+)?(?:completed|finished)\s+(?:the\s+)?(?:job|work|repair|visit))\b/i;
const COMPLETED_NEGATION = /\b(?:not\s+(?:yet\s+)?(?:complete|completed|done|finished)|unable\s+to\s+complete|couldn'?t\s+complete)\b/i;
const SLOT = /\b(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning|\s+afternoon|\s+evening)?(?:\s+at)?(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i;
export function quoteWithin(quote: number, terms: ApprovalTerms): boolean {
    return terms.inclusive ? quote <= terms.budgetGbp : quote < terms.budgetGbp;
}
export function slotFitsTimeframe(slot: string, timeframe: string): boolean {
    const lowerSlot = slot.toLowerCase();
    const lowerFrame = timeframe.toLowerCase();
    if (/\bunavailable\b|\bnot available\b/.test(lowerSlot))
        return false;
    const days = WEEKDAYS.filter(day => lowerFrame.includes(day));
    const slotDay = WEEKDAYS.find(day => lowerSlot.includes(day));
    if (days.length === 1)
        return slotDay === days[0];
    if (days.length > 1)
        return !!slotDay && days.includes(slotDay);
    if (/\bthis week\b/.test(lowerFrame))
        return !!slotDay;
    if (/\btoday\b/.test(lowerFrame))
        return /\btoday\b/.test(lowerSlot);
    if (/\btomorrow\b/.test(lowerFrame))
        return /\btomorrow\b/.test(lowerSlot);
    if (/\bwithin\s+\d+\s+days\b/.test(lowerFrame))
        return !!slotDay;
    return lowerSlot.includes(lowerFrame);
}
export function parseQuote(text: string): number | undefined {
    const preferred = text.match(/(?:quote|estimate|price|cost|charge)\s*(?:is|of|:)?\s*£\s*(\d+(?:\.\d{1,2})?)(?!\d)/i);
    if (preferred?.[1])
        return Number(preferred[1]);
    const amounts = parsePounds(text);
    return amounts.length === 1 ? amounts[0] : undefined;
}
function parseSlot(text: string): string | undefined {
    return text.match(SLOT)?.[0]?.trim();
}
export function classifyContractor(issue: Issue, text: string, evidenceIds: string[]): ContractorAssessment {
    const base = { channel: 'contractor' as const, evidenceIds };
    const order = issue.engagement?.order;
    if (VISIT.test(text)) {
        if (order?.status === 'accepted' && order.slot && text.toLowerCase().includes(order.slot.toLowerCase()))
            return { ...base, kind: 'visitConfirmed', reason: 'Contractor confirmed the visit on the accepted order' };
        return { ...base, kind: 'review', reason: 'Visit confirmation requires the slot already saved on the accepted order' };
    }
    if (COMPLETED.test(text) && !COMPLETED_NEGATION.test(text)) {
        if (order?.status === 'accepted' && issue.engagement?.visitConfirmedEventId)
            return { ...base, kind: 'completed', reason: 'Contractor reported the repair complete after visit confirmation' };
        return { ...base, kind: 'review', reason: 'Completion requires an accepted order with a recorded visit confirmation' };
    }
    if (DECLINE.test(text))
        return { ...base, kind: 'reject', reason: 'Contractor declined the job' };
    const quote = parseQuote(text);
    if (/\bunavailable\b/i.test(text)) {
        if (quote !== undefined)
            return { ...base, kind: 'quoteAndAvailability', quoteGbp: quote, slot: 'unavailable', unavailable: true, reason: 'Contractor quoted and is unavailable' };
        return { ...base, kind: 'availability', slot: 'unavailable', unavailable: true, reason: 'Contractor is unavailable' };
    }
    const slot = parseSlot(text);
    if (quote !== undefined && slot)
        return { ...base, kind: 'quoteAndAvailability', quoteGbp: quote, slot, reason: 'Contractor sent a quote and a visit time' };
    if (quote !== undefined)
        return { ...base, kind: 'quote', quoteGbp: quote, reason: 'Contractor sent a quote' };
    if (slot)
        return { ...base, kind: 'availability', slot, reason: 'Contractor sent a visit time' };
    return { ...base, kind: 'review', reason: 'Contractor message has no quote, visit time, decline, or confirmation' };
}
export function validateContractorAssessment(issue: Issue, actor: Actor, text: string, decision: ContractorAssessment): ContractorAssessment {
    if (actor.role !== 'contractor' || !actor.id.trim())
        throw new Error('Unknown contractor actor');
    const allowed = [issue.engagement?.proposal?.id, issue.engagement?.order?.contractor_id].filter((id): id is string => !!id);
    if (!allowed.includes(actor.id))
        throw new Error('Sender is not the contractor on the engagement');
    const ids = new Set(issue.evidence.map(evidence => evidence.eventId));
    if (decision.evidenceIds.some(id => !ids.has(id)))
        throw new Error('Unknown supporting evidence');
    if ((decision.kind === 'quote' || decision.kind === 'quoteAndAvailability') && !amountAppears(text, decision.quoteGbp))
        throw new Error('Quote is not in the contractor message');
    if ((decision.kind === 'availability' || decision.kind === 'quoteAndAvailability') && !text.toLowerCase().includes(decision.slot.toLowerCase()))
        throw new Error('Slot is not in the contractor message');
    if (decision.kind === 'visitConfirmed') {
        const order = issue.engagement?.order;
        if (!order || order.status !== 'accepted' || !order.slot)
            throw new Error('Visit confirmation requires a slot on the accepted order');
        if (!VISIT.test(text) || !text.toLowerCase().includes(order.slot.toLowerCase()))
            throw new Error('Confirmation is not in the contractor message');
    }
    if (decision.kind === 'completed') {
        const order = issue.engagement?.order;
        if (!order || order.status !== 'accepted' || !issue.engagement?.visitConfirmedEventId)
            throw new Error('Completion requires an accepted order with a recorded visit confirmation');
        if (!COMPLETED.test(text) || COMPLETED_NEGATION.test(text))
            throw new Error('Completion wording is not in the contractor message');
    }
    return decision;
}
