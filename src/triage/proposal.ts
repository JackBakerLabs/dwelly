import { z } from 'zod';
import type { Issue, Observation, Decision } from '../types.js';
import { validateDecision,scopeSchema,resumeSchema } from './validation.js';
export const CONTRACT_VERSION = 'assessment-v3-scope-wait';
const urgency = z.enum(['low', 'medium', 'high', 'emergency']);
const common = { scope:scopeSchema, evidenceIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1).max(2000), humanAction: z.string().min(1).max(2000).nullable() };
const fields = { title: z.string().min(1).max(300).nullable(), description: z.string().max(10000).nullable(), urgency: urgency.nullable(), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).nullable() };
// Nullable fields are explicit and required on the wire, as strict provider schemas require.
export const proposalBranches = {
    ask: z.object({ ...common, kind: z.literal('ask'), question: z.string().min(1).max(10000) }).strict(),
    open: z.object({ ...common, kind: z.literal('open'), title: z.string().min(1).max(300), description: fields.description, urgency }).strict(),
    update: z.object({ ...common, kind: z.literal('update'), patch: z.object(fields).strict() }).strict(),
    wait: z.object({ ...common, kind: z.literal('wait'), urgency: fields.urgency,resume:resumeSchema }).strict(),
    outOfScope: z.object({ ...common, kind: z.literal('outOfScope'), urgency }).strict(),
    review: z.object({ ...common, kind: z.literal('review'), urgency: fields.urgency }).strict(),
};
export const proposalSchema = z.discriminatedUnion('kind', [proposalBranches.ask, proposalBranches.open, proposalBranches.update, proposalBranches.wait, proposalBranches.outOfScope, proposalBranches.review]);
export type DecisionProposal = z.infer<typeof proposalSchema>;
import { allowedActions, type Action } from './permissions.js';
export { allowedActions } from './permissions.js';
export function buildAssessmentContext(issue: Issue, evidence: Observation[], guidance: unknown) {
    const superseded = new Set(evidence.flatMap(e => e.supersedes ? [e.supersedes] : []));
    return { contractVersion: CONTRACT_VERSION, localIssueId: issue.id, remoteCase: issue.remoteCase ? { title: issue.remoteCase.title, description: issue.remoteCase.description, urgency: issue.remoteCase.urgency, status: issue.remoteCase.status } : null,
        scope:issue.scope??null,waiting:issue.waiting??null,allowedActions: allowedActions(issue), outstandingQuestion: issue.outstandingQuestion ?? null,lastQuestion:issue.lastQuestion??null,
        currentObservations: evidence.filter(e => !superseded.has(e.eventId)), guidance };
}
export function proposalResponseSchema(issue: Issue) {
    const branches = allowedActions(issue).map(kind => proposalBranches[kind]);
    const schema = z.object({ decision: z.union(branches as [
            typeof branches[number],
            typeof branches[number],
            ...typeof branches[number][]
        ]) }).strict();
    const json = z.toJSONSchema(schema, { target: 'draft-7' });
    delete json.$schema;
    return { schema, json };
}
export class ProposalError extends Error {
    constructor(readonly code: string, readonly path: string[], message: string) { super(message); }
}
export function bindProposal(issue: Issue, input: unknown): Decision {
    // Check action before parsing to give an actionable transition error, without accepting arbitrary fields.
    const envelope = z.object({ decision: z.unknown() }).strict().parse(input);
    const kind = (envelope.decision as {
        kind?: unknown;
    } | null)?.kind;
    if (typeof kind === 'string' && !allowedActions(issue).includes(kind as Action))
        throw new ProposalError('ACTION_NOT_ALLOWED', ['decision', 'kind'], `Action ${kind} is unavailable. Allowed actions: ${allowedActions(issue).join(', ')}. Remote case ${issue.remoteCase ? 'exists' : 'does not exist'}.`);
    const p = proposalSchema.parse(envelope.decision);
    const common = { scope:p.scope, evidenceIds: p.evidenceIds, reason: p.reason, ...(p.humanAction !== null ? { humanAction: p.humanAction } : {}) };
    let decision: Decision;
    switch (p.kind) {
        case 'ask':
            decision = { ...common, kind: p.kind, actorId: issue.actorId, question: p.question };
            break;
        case 'update':
            decision = { ...common, kind: p.kind, caseId: issue.remoteCase!.id, patch: Object.fromEntries(Object.entries(p.patch).filter(([, v]) => v !== null)) };
            break;
        case 'open':
            decision = { ...common, kind: p.kind, title: p.title, urgency: p.urgency, ...(p.description !== null ? { description: p.description } : {}) };
            break;
        case 'wait':
            decision={...common,kind:'wait',resume:p.resume,...(p.urgency!==null?{urgency:p.urgency}:{})};break;
        case 'outOfScope':
            decision = { ...common, kind: p.kind, urgency: p.urgency };
            break;
        default: decision = { ...common, kind: p.kind, ...(p.urgency !== null ? { urgency: p.urgency } : {}) };
    }
    return validateDecision(issue, decision);
}
export function validationErrors(error: unknown) {
    if (error instanceof z.ZodError)
        return error.issues.map(i => ({ code: i.code, path: i.path.map(String), message: i.message }));
    if (error instanceof ProposalError)
        return [{ code: error.code, path: error.path, message: error.message }];
    const message = error instanceof Error ? error.message : String(error);
    const rules: [
        RegExp,
        string,
        string[]
    ][] = [[/scope|Scope|External emergency/,'SCOPE_ACTION_CONFLICT',['decision','scope']],[/wait requires/,'WAIT_TRIGGER_INVALID',['decision','resume']],[/supporting evidence/, 'EVIDENCE_REFERENCE_INVALID', ['decision', 'evidenceIds']], [/Emergency requires/, 'HUMAN_ACTION_REQUIRED', ['decision', 'humanAction']], [/Question already/, 'QUESTION_ALREADY_OUTSTANDING', ['decision', 'question']], [/Patch changes nothing|Empty patch/, 'PATCH_NO_CHANGE', ['decision', 'patch']], [/Closure requires/, 'COMPLETION_EVIDENCE_REQUIRED', ['decision', 'patch', 'status']], [/Unknown recipient/, 'RECIPIENT_NOT_KNOWN', ['decision']]];
    const match = rules.find(([pattern]) => pattern.test(message));
    return [{ code: error instanceof SyntaxError ? 'INVALID_JSON' : match?.[1] ?? 'SEMANTIC_VALIDATION_FAILED', path: match?.[2] ?? [], message }];
}
