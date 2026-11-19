import { z } from 'zod';
import { allowedActions } from './permissions.js';
import type { Decision, Issue } from '../types.js';
const urgency = z.enum(['low', 'medium', 'high', 'emergency']);
export const scopeSchema=z.enum(['maintenance','nonMaintenance','externalEmergency','unknown']);
export const resumeSchema=z.object({kind:z.enum(['tenantReply','caseUpdate','operatorReview']),condition:z.string().min(1).max(1000)}).strict();
const base = { scope:scopeSchema.optional(), evidenceIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1).max(2000), humanAction: z.string().min(1).max(2000).optional() };
const patch = z.object({ title: z.string().min(1).max(300).optional(), description: z.string().max(10000).optional(), urgency: urgency.optional(), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Empty patch');
export const decisionSchema = z.discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('ask'), actorId: z.string().min(1), question: z.string().min(1).max(10000) }).strict(),
    z.object({ ...base, kind: z.literal('open'), title: z.string().min(1).max(300), description: z.string().max(10000).optional(), urgency }).strict(),
    z.object({ ...base, kind: z.literal('update'), caseId: z.string().min(1), patch }).strict(),
    z.object({ ...base, kind: z.literal('wait'), urgency: urgency.optional(),resume:resumeSchema.optional() }).strict(),
    z.object({ ...base, kind: z.literal('outOfScope'), urgency }).strict(),
    z.object({ ...base, kind: z.literal('review'), urgency: urgency.optional() }).strict(),
]);
export function validateDecision(issue: Issue, input: unknown): Decision {
    const d = decisionSchema.parse(input) as Decision;
    if (!allowedActions(issue).includes(d.kind))
        throw new Error('Action unavailable in current issue state');
    if(d.scope==='nonMaintenance'&&!['outOfScope','review'].includes(d.kind))throw new Error('Non-maintenance scope requires outOfScope or review');
    if(d.scope==='maintenance'&&d.kind==='outOfScope')throw new Error('Maintenance scope cannot be outOfScope');
    if(d.scope==='unknown'&&!['ask','review'].includes(d.kind))throw new Error('Unknown scope requires clarification or review');
    if(d.kind==='outOfScope'&&d.scope&&d.scope!=='nonMaintenance')throw new Error('Out-of-scope action requires nonMaintenance scope');
    if(d.scope==='externalEmergency'){
      const urgency=d.kind==='update'?(d.patch.urgency??issue.remoteCase?.urgency):d.kind==='ask'?undefined:d.urgency;
      if(!['open','update','review'].includes(d.kind)||urgency!=='emergency'||!d.humanAction)throw new Error('External emergency requires emergency urgency and human escalation');
    }
    if(d.kind==='wait'&&d.resume){
      if(d.resume.kind==='tenantReply'&&!issue.outstandingQuestion)throw new Error('Tenant reply wait requires an outstanding question');
      if(d.resume.kind==='caseUpdate'&&!issue.remoteCase)throw new Error('Case update wait requires an existing remote case');
    }
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
