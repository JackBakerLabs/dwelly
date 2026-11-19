import { z } from 'zod';
import { allowedActions } from './permissions.js';
import type { Decision, Issue } from '../types.js';
const urgency = z.enum(['low', 'medium', 'high', 'emergency']);
const base = { evidenceIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1).max(2000), humanAction: z.string().min(1).max(2000).optional() };
const patch = z.object({ title: z.string().min(1).max(300).optional(), description: z.string().max(10000).optional(), urgency: urgency.optional(), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Empty patch');
export const decisionSchema = z.discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('ask'), actorId: z.string().min(1), question: z.string().min(1).max(10000) }).strict(),
    z.object({ ...base, kind: z.literal('open'), title: z.string().min(1).max(300), description: z.string().max(10000).optional(), urgency }).strict(),
    z.object({ ...base, kind: z.literal('update'), caseId: z.string().min(1), patch }).strict(),
    z.object({ ...base, kind: z.literal('wait'), urgency: urgency.optional() }).strict(),
    z.object({ ...base, kind: z.literal('outOfScope'), urgency }).strict(),
    z.object({ ...base, kind: z.literal('review'), urgency: urgency.optional() }).strict(),
]);
export function validateDecision(issue: Issue, input: unknown): Decision {
    const d = decisionSchema.parse(input) as Decision;
    if (!allowedActions(issue).includes(d.kind))
        throw new Error('Action unavailable in current issue state');
    const superseded = new Set(issue.evidence.flatMap(e => e.supersedes ? [e.supersedes] : []));
    const ids = new Set(issue.evidence.map(e => e.eventId));
    if (d.evidenceIds.some(id => !ids.has(id) || superseded.has(id)))
        throw new Error('Unknown or superseded supporting evidence');
    if (issue.status === 'review' && ['open', 'update', 'ask'].includes(d.kind))
        throw new Error('Review hold blocks mutations');
    if (d.kind === 'ask') {
        if (d.actorId !== issue.actorId || !issue.evidence.some(e => e.actor?.id === d.actorId))
            throw new Error('Unknown recipient');
        if (issue.outstandingQuestion === d.question)
            throw new Error('Question already outstanding');
    }
    const proposedUrgency = d.kind === 'update' ? d.patch.urgency : d.kind === 'ask' ? undefined : d.urgency;
    if (proposedUrgency === 'emergency' && !d.humanAction)
        throw new Error('Emergency requires explicit human action');
    if (d.kind === 'open' && issue.remoteCase)
        throw new Error('Issue already has a case');
    if (d.kind === 'update') {
        if (!issue.remoteCase || d.caseId !== issue.remoteCase.id)
            throw new Error('Unknown case');
        if (d.patch.status === 'resolved' || d.patch.status === 'closed') {
            const completion = issue.evidence.some(e => d.evidenceIds.includes(e.eventId) && ['tenant', 'contractor'].includes(e.actor?.role ?? '') && /\b(repair(?:ed| complete)|fixed|resolved|working (?:again|now)|all dry|no further leaks)\b/i.test(e.body) && !(/\b(not|never|isn't|wasn't|hasn't|still broken|not yet)\b/i.test(e.body)));
            if (!completion)
                throw new Error('Closure requires attributable completion evidence');
        }
        if (!Object.entries(d.patch).some(([k, v]) => issue.remoteCase![k as keyof typeof issue.remoteCase] !== v))
            throw new Error('Patch changes nothing');
    }
    return d;
}
