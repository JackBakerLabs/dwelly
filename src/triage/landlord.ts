import type { Actor, DecodedEvent, Engagement, Issue, LandlordDecision } from '../types.js';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FLAT_SOURCE = String.raw`\bflat\s+\d+[a-z]?\b`;
const STREET_SOURCE = String.raw`\b\d+\s+[a-z]+(?:\s+[a-z]+){0,3}\s+(?:road|street|avenue|lane|drive|close|court|place|way|gardens|square|crescent|terrace)\b`;
const NEEDS_WRITTEN_ESTIMATE = /\b(before\s+i(?:'ll| will)\s+sign\s+off|price\s+in\s+writing|i(?:'ll| will)\s+make\s+a\s+call|need\s+an\s+estimate|written\s+estimate|get\s+me\s+the\s+(?:contractor'?s\s+)?prices?|send\s+(?:me\s+)?the\s+contractor'?s\s+prices?|contractor'?s\s+price)\b/i;
const REJECT = /\b(i\s+reject|rejected|do\s+not\s+proceed|don't\s+proceed|i\s+do\s+not\s+approve|i\s+don't\s+approve|will\s+not\s+approve|won't\s+approve|not\s+approved)\b/i;
const HARD_REJECT = /\b(i\s+reject|do\s+not\s+proceed|don't\s+proceed)\b/i;
const APPROVAL = /\b(i\s+approve|approved|go\s+ahead|please\s+proceed|you\s+may\s+proceed)\b/i;
const AVAILABILITY_REQUEST = /\b(when\s+(?:can|could)\s+(?:they|the\s+contractor)|request\s+availability|ask\s+(?:them|the\s+contractor)\s+(?:for\s+)?availability|what\s+times?\s+(?:are|is)\s+(?:they|the\s+contractor)\s+available)\b/i;
export const NAME_PROPERTY_QUESTION = 'Which property does this concern? Please name the address or flat.';
/** Explicit plural landlord instruction against several open issues ("both", "each", …). */
export function isPluralInstruction(text: string): boolean {
    return /\b(?:both(?:\s+(?:jobs|issues|cases|of\s+them))?|each(?:\s+(?:one|job|issue|case))?|all\s+of\s+them|the\s+two\s+jobs|all\s+(?:open\s+)?(?:jobs|issues|cases)|every\s+(?:one|job|issue|case))\b/i.test(text);
}
export function bothCasesQuestion(issues: Issue[]): string {
    const lines = issues.map(issue => `- ${issue.remoteCase?.title ?? 'Untitled issue'}: please say whether to approve, approve only within a budget and timeframe, request a written quote, or reject.`);
    return `You referred to more than one open case. For each, tell me what you want done:\n${lines.join('\n')}`;
}
export function issueCorpus(issue: Issue): string {
    return [issue.propertyId, issue.remoteCase?.title, issue.remoteCase?.description, ...issue.evidence.map(e => e.body)].filter((part): part is string => !!part).join('\n');
}
export function propertyPhrases(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(new RegExp(FLAT_SOURCE, 'gi')))
        found.add(match[0].trim());
    for (const match of text.matchAll(new RegExp(STREET_SOURCE, 'gi')))
        found.add(match[0].trim());
    return [...found];
}
export function isOpenMaintenanceIssue(issue: Issue): boolean {
    if (issue.status === 'outOfScope')
        return false;
    if (issue.remoteCase && (issue.remoteCase.status === 'resolved' || issue.remoteCase.status === 'closed'))
        return false;
    if (issue.remoteCase && (issue.remoteCase.status === 'open' || issue.remoteCase.status === 'in_progress'))
        return true;
    return issue.evidence.some(e => e.actor?.role === 'tenant') && ['active', 'awaitingReply', 'waiting', 'review'].includes(issue.status);
}
export function sameProperty(left: Issue, right: Issue): boolean {
    if (left.propertyId && right.propertyId && left.propertyId === right.propertyId)
        return true;
    const phrases = propertyPhrases(issueCorpus(left));
    const flats = phrases.filter(phrase => /^flat\s/i.test(phrase));
    const needles = flats.length ? flats : phrases;
    const corpus = issueCorpus(right).toLowerCase();
    return needles.some(phrase => corpus.includes(phrase.toLowerCase()));
}
export type PropertyMatch = { kind: 'none' } | { kind: 'one'; issue: Issue } | { kind: 'many'; issues: Issue[] };
export function matchProperty(text: string, issues: Issue[]): PropertyMatch {
    const open = issues.filter(isOpenMaintenanceIssue);
    const phrases = propertyPhrases(text);
    const flats = phrases.filter(phrase => /^flat\s/i.test(phrase));
    const needles = flats.length ? flats : phrases;
    const matched = needles.length ? open.filter(issue => needles.some(phrase => issueCorpus(issue).toLowerCase().includes(phrase.toLowerCase()))) : open.filter(issue => !!issue.propertyId && text.toLowerCase().includes(issue.propertyId.toLowerCase()));
    if (!needles.length && matched.length === 0)
        return { kind: 'none' };
    if (matched.length === 1)
        return { kind: 'one', issue: matched[0]! };
    if (matched.length > 1)
        return { kind: 'many', issues: matched };
    return { kind: 'none' };
}
/** Landlord answering "which issue?" usually names the case title, not a property phrase. Match a full title, or a distinctive fragment of one, against the open issues. */
export function matchIssueByTitle(text: string, issues: Issue[]): Issue | undefined {
    const hay = text.toLowerCase();
    const cleaned = hay.replace(/\b(the|one|please|it|that|this|case|issue)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const hits = issues.filter(isOpenMaintenanceIssue).filter(issue => {
        const title = issue.remoteCase?.title?.trim().toLowerCase();
        if (!title)
            return false;
        return hay.includes(title) || (cleaned.length >= 4 && title.includes(cleaned));
    });
    return hits.length === 1 ? hits[0] : undefined;
}
export function whichIssueQuestion(issues: Issue[]): string {
    return `Which issue do you mean? Open cases: ${issues.map(issue => issue.remoteCase?.title ?? 'Untitled issue').join('; ')}.`;
}
export function explicitIssue(decoded: DecodedEvent, issues: Issue[]): { kind: 'none' } | { kind: 'one'; issue: Issue } | { kind: 'ambiguous' } {
    let candidates: Issue[] | undefined;
    if (decoded.issueId)
        candidates = issues.filter(issue => issue.id === decoded.issueId);
    else if (decoded.caseId)
        candidates = issues.filter(issue => issue.remoteCase?.id === decoded.caseId);
    else if (decoded.replyToEventId)
        candidates = issues.filter(issue => issue.evidence.some(evidence => evidence.eventId === decoded.replyToEventId));
    else if (decoded.conversationId && !decoded.newIssue)
        candidates = issues.filter(issue => issue.conversationId === decoded.conversationId);
    else
        return { kind: 'none' };
    return candidates.length === 1 ? { kind: 'one', issue: candidates[0]! } : { kind: 'ambiguous' };
}
export function acceptProposedMatch(text: string, proposed: string, issues: Issue[]): Issue | undefined {
    if (!proposed.trim() || !text.toLowerCase().includes(proposed.toLowerCase()))
        return undefined;
    const hits = issues.filter(isOpenMaintenanceIssue).filter(issue => issueCorpus(issue).toLowerCase().includes(proposed.toLowerCase()));
    return hits.length === 1 ? hits[0] : undefined;
}
export function amountAppears(text: string, amount: number): boolean {
    if (!Number.isFinite(amount))
        return false;
    const rendered = Number.isInteger(amount) ? String(amount) : String(amount);
    const escaped = rendered.replace('.', '\\.');
    return new RegExp(`£\\s*${escaped}(?!\\d)|\\b${escaped}\\s*(?:gbp|pounds?)\\b`, 'i').test(text);
}
export function parsePounds(text: string): number[] {
    const amounts: number[] = [];
    const pattern = /£\s*(\d+(?:\.\d{1,2})?)(?!\d)/gi;
    for (const match of text.matchAll(pattern))
        amounts.push(Number(match[1]));
    return amounts;
}
export function parseBudget(text: string): { amount: number; inclusive: boolean } | undefined {
    const patterns: { re: RegExp; inclusive: boolean }[] = [
        { re: /(?:under|below|less\s+than)\s*£\s*(\d+(?:\.\d{1,2})?)(?!\d)/i, inclusive: false },
        { re: /£\s*(\d+(?:\.\d{1,2})?)(?!\d)\s*or\s+less/i, inclusive: true },
        { re: /(?:up\s+to|no\s+more\s+than|at\s+most|maximum(?:\s+of)?|within)\s*£\s*(\d+(?:\.\d{1,2})?)(?!\d)/i, inclusive: true },
    ];
    const found: { amount: number; inclusive: boolean }[] = [];
    for (const pattern of patterns) {
        const match = pattern.re.exec(text);
        if (match?.[1])
            found.push({ amount: Number(match[1]), inclusive: pattern.inclusive });
    }
    if (found.length !== 1)
        return undefined;
    return found[0];
}
export function parseTimeframe(text: string): string | undefined {
    const patterns = [
        /\b(?:on|this|next|by|before)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning|\s+afternoon|\s+evening)?\b/i,
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning|\s+afternoon|\s+evening)?\b/i,
        /\bthis week\b/i,
        /\btoday\b/i,
        /\btomorrow\b/i,
        /\bwithin\s+\d+\s+days\b/i,
    ];
    const matches = patterns.flatMap(pattern => text.match(pattern)?.[0] ? [text.match(pattern)![0]] : []);
    if (!matches.length)
        return undefined;
    const days = WEEKDAYS.filter(day => text.toLowerCase().includes(day));
    if (new Set(days).size > 1)
        return undefined;
    return matches.sort((a, b) => b.length - a.length)[0];
}
function askForMissingCondition(text: string, evidenceIds: string[]): LandlordDecision {
    const budget = parseBudget(text);
    const timeframe = parseTimeframe(text);
    const question = budget && !timeframe ? `Please confirm both a budget and a timeframe. I can see a budget of £${budget.amount} but no timeframe.` : timeframe && !budget ? `Please confirm both a budget and a timeframe. I can see a timeframe (${timeframe}) but no budget.` : 'Please confirm both a budget and a timeframe.';
    return { channel: 'landlord', kind: 'ask', question, evidenceIds, reason: 'Conditional approval is missing a budget or a timeframe' };
}
export function classifyLandlord(text: string, evidenceIds: string[]): LandlordDecision {
    const base = { channel: 'landlord' as const, evidenceIds };
    if (NEEDS_WRITTEN_ESTIMATE.test(text) && !HARD_REJECT.test(text)) {
        const amounts = parsePounds(text);
        return { ...base, kind: 'requestQuote', ...(amounts.length === 1 ? { notedBudgetGbp: amounts[0] } : {}), reason: 'Landlord asked for a written price before deciding' };
    }
    if (REJECT.test(text))
        return { ...base, kind: 'reject', reason: 'Landlord rejected the engagement' };
    if (AVAILABILITY_REQUEST.test(text) && !APPROVAL.test(text))
        return { ...base, kind: 'requestAvailability', reason: 'Landlord asked for availability only' };
    if (APPROVAL.test(text)) {
        if (/\bif\b/i.test(text)) {
            const budget = parseBudget(text);
            const timeframe = parseTimeframe(text);
            if (budget && timeframe)
                return { ...base, kind: 'approveIf', budgetGbp: budget.amount, inclusive: budget.inclusive, timeframe, reason: 'Landlord approved only if the budget and timeframe are both met' };
            return askForMissingCondition(text, evidenceIds);
        }
        return { ...base, kind: 'approve', reason: 'Landlord approved the repair outright' };
    }
    return { ...base, kind: 'review', reason: 'Landlord message did not state a supported decision' };
}
export function rememberLandlord(engagement: Engagement, actorId: string): void {
    engagement.landlordId = actorId;
    engagement.landlordWrote = true;
    delete engagement.queuedBriefing;
}
export function knownLandlordAcross(issue: Issue, issues: Issue[]): string | undefined {
    if (issue.engagement?.landlordId)
        return issue.engagement.landlordId;
    for (const other of issues) {
        if (other.id === issue.id || !sameProperty(issue, other))
            continue;
        if (other.engagement?.landlordId)
            return other.engagement.landlordId;
        const actorId = other.evidence.find(evidence => evidence.actor?.role === 'landlord')?.actor?.id;
        if (actorId)
            return actorId;
    }
    return undefined;
}
export function validateLandlordDecision(actor: Actor, text: string, decision: LandlordDecision, issue?: Issue): LandlordDecision {
    if (actor.role !== 'landlord' || !actor.id.trim())
        throw new Error('Unknown landlord actor');
    if (!decision.evidenceIds.length)
        throw new Error('Landlord decision needs evidence');
    if (issue) {
        const ids = new Set(issue.evidence.map(evidence => evidence.eventId));
        if (decision.evidenceIds.some(id => !ids.has(id)))
            throw new Error('Unknown supporting evidence');
        if (issue.engagement?.landlordId && issue.engagement.landlordId !== actor.id)
            throw new Error('Second landlord');
    }
    else if (decision.kind !== 'ask' && decision.kind !== 'review')
        throw new Error('Linked issue required');
    if (decision.proposedPropertyText && !text.toLowerCase().includes(decision.proposedPropertyText.toLowerCase()))
        throw new Error('Proposed property text is not in the message');
    if (decision.kind === 'approveIf') {
        if (!Number.isFinite(decision.budgetGbp) || !decision.timeframe.trim())
            throw new Error('Conditional approval requires a budget and a timeframe');
        if (!amountAppears(text, decision.budgetGbp))
            throw new Error('Budget is not in the landlord message');
        if (!text.toLowerCase().includes(decision.timeframe.toLowerCase()))
            throw new Error('Timeframe is not in the landlord message');
    }
    if (decision.kind === 'requestQuote' && decision.notedBudgetGbp !== undefined && !amountAppears(text, decision.notedBudgetGbp))
        throw new Error('Noted budget is not in the landlord message');
    if ((decision.kind === 'approve' || decision.kind === 'approveIf' || decision.kind === 'reject' || decision.kind === 'requestQuote' || decision.kind === 'requestAvailability') && !issue?.remoteCase && decision.kind !== 'reject')
        throw new Error('Linked case required');
    if (decision.kind === 'reject' && !issue)
        throw new Error('Linked issue required');
    if (decision.kind === 'ask' && !decision.question.trim())
        throw new Error('Question required');
    return decision;
}
