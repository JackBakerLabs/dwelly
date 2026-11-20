import {startWaiting,expireWaiting,clearWaiting,WAIT_REVIEW_PREFIX} from '../workflow/waiting.js';
import { randomUUID } from 'node:crypto';
import type { AgentDecision, Assessor, ContractorAssessment, CoordinationWorldClient, Decision, DecodedEvent, EffectDecision, EventBatch, HistoryCase, Issue, LandlordDecision, RemoteCase, TraceEntry, WorkOrder, WorkOrderSignal, WorldEvent } from '../types.js';
import { Store, type Intent } from '../store/index.js';
import { decodeEvent, normaliseThreadKey, WorldError } from '../world/index.js';
import { validateDecision } from '../triage/index.js';
import { classifyContractor, validateContractorAssessment } from '../triage/contractor-reply.js';
import { draftProposal, planContractor, planLandlord, planTenantSlotReply, planWorkOrderAccepted, planWorkOrderDeclined, type Effect, type Plan } from '../triage/engagement.js';
import { NAME_PROPERTY_QUESTION, acceptProposedMatch, bothCasesQuestion, classifyLandlord, explicitIssue, isOpenMaintenanceIssue, isPluralInstruction, issueCorpus, knownLandlordAcross, matchIssueByTitle, matchProperty, propertyPhrases, validateLandlordDecision, whichIssueQuestion } from '../triage/landlord.js';
export interface GraphDependencies {
    store: Store;
    world: CoordinationWorldClient;
    assess: Assessor;
    assessLandlord?: (issue: Issue, text: string) => Promise<LandlordDecision>;
    assessContractor?: (issue: Issue, text: string) => Promise<ContractorAssessment>;
    precedents?: HistoryCase[];
    now?:()=>number;
    reviewAfterMs?:number;
    beforeEvent?: (event: WorldEvent) => Promise<boolean>;
}
export const transitions = { Ingest: ['Route'], Route: ['Assess', 'LandlordTriage', 'ContractorTriage', 'Checkpoint'], Assess: ['Validate'], LandlordTriage: ['Validate'], ContractorTriage: ['Validate'], Validate: ['Act', 'Checkpoint'], Act: ['Checkpoint'], Checkpoint: [] } as const;
export class Graph {
    private running = false;
    constructor(readonly dependencies: GraphDependencies) { if(dependencies.reviewAfterMs!==undefined&&(!Number.isSafeInteger(dependencies.reviewAfterMs)||dependencies.reviewAfterMs<=0))throw new Error('reviewAfterMs must be a positive integer'); }
    ingest(batch: EventBatch) { this.dependencies.store.ingest(batch); }
    async pollOnce() { await this.drain(); const batch = await this.dependencies.world.poll(this.dependencies.store.cursor()); this.ingest(batch); await this.drain(); return batch; }
    async drain() { if (this.running)
        throw new Error('One graph worker per session'); this.running = true; try {
        expireWaiting(this.dependencies.store,(this.dependencies.now??Date.now)());
        for (const event of this.dependencies.store.pending())
            await this.runEvent(event);
    }
    finally {
        this.running = false;
    } }
    async processEvent(event: WorldEvent) { this.ingest({ events: [event], next_cursor: Math.max(this.dependencies.store.cursor(), event.cursor) }); await this.drain(); }
    private trace(event: WorldEvent, node: TraceEntry['node'], edge: string, reason: string, issue?: Issue, outcome?: unknown) { this.dependencies.store.trace({ session: this.dependencies.store.session, eventId: event.id, cursor: event.cursor, issueId: issue?.id, remoteId: issue?.remoteCase?.id, node, edge, evidenceIds: issue?.evidence.map(e => e.eventId) ?? [], reason, outcome }); }
    private complete(event: WorldEvent, issue: Issue | undefined, reason: string) { const s = this.dependencies.store; s.transaction(() => { if (issue)
        s.putIssue(issue); this.trace(event, 'Checkpoint', 'done', reason, issue); s.finish(event.id); }); }
    private async runEvent(event: WorldEvent) {
        const { store: s, assess, precedents = [] } = this.dependencies;
        if (s.status(event.id) === 'done')
            return;
        if (this.dependencies.beforeEvent && await this.dependencies.beforeEvent(event)) {
            this.complete(event, undefined, 'Durable extension handler completed event');
            return;
        }
        const previous = s.intents().filter(i => i.eventId === event.id);
        if (previous.length) {
            const pending = previous.filter(i => i.state === 'queued' || i.state === 'deferred');
            if (pending.length) {
                if (pending.some(i => (i.retryAt ?? 0) > Date.now()) || s.pending().some(e => e.cursor > event.cursor))
                    return;
                for (const intent of pending) {
                    const issue = s.issue(intent.issueId);
                    if (issue)
                        await this.dispatch(event, issue, intent);
                }
            }
            else if (previous.every(i => i.state === 'uncertain' || i.state === 'failed' || i.state === 'confirmed'))
                s.finish(event.id);
            return;
        }
        this.trace(event, 'Ingest', 'Route', 'Durable event loaded');
        if (event.type === 'work_order.accepted' || event.type === 'work_order.declined') {
            await this.runWorkOrder(event);
            return;
        }
        const decoded = decodeEvent(event);
        if (decoded.kind === 'system') {
            await this.runSystem(event, decoded);
            return;
        }
        if (decoded.kind !== 'message' || !decoded.body?.trim() || !event.actor) {
            this.trace(event, 'Route', decoded.kind === 'unknown' ? 'review' : 'ignore', 'Unknown envelope/payload or system echo: no mutation');
            this.complete(event, undefined, 'Retained original event for inspection');
            return;
        }
        if (/^(?:thanks?|thank you|ok(?:ay)?|cheers|got it|understood)[!.\s]*$/i.test(decoded.body.trim())) {
            this.trace(event, 'Route', 'ignore', 'Acknowledgement adds no facts');
            this.complete(event, undefined, 'No new evidence');
            return;
        }
        if (event.actor.role === 'landlord') {
            await this.runLandlord(event, decoded);
            return;
        }
        if (event.actor.role === 'contractor') {
            await this.runContractor(event, decoded);
            return;
        }
        // Tenant slot confirmation is intercepted before Assess when pending.
        {
            const pendingSlot = s.issues().filter(i => i.actorId === event.actor!.id && !!i.engagement?.pendingTenantSlot);
            if (pendingSlot.length === 1) {
                const target = pendingSlot[0]!;
                if (!target.evidence.some(e => e.eventId === event.id))
                    target.evidence.push({ eventId: event.id, cursor: event.cursor, actor: event.actor, body: decoded.body, occurredAt: event.occurred_at, ...(decoded.subject ? { subject: decoded.subject } : {}) });
                this.trace(event, 'Route', 'Assess', 'Tenant slot confirmation intercepted', target);
                const plan = planTenantSlotReply(target, this.messageText(event, decoded.body), event.id);
                await this.commitPlan(event, target, plan, 'Tenant confirmed or changed the offered slot');
                return;
            }
            if (pendingSlot.length > 1) {
                this.trace(event, 'Route', 'review', 'Several issues await tenant slot confirmation from this actor');
                this.complete(event, undefined, 'Routing review required');
                return;
            }
            if (s.issues().some(i => !!i.engagement?.pendingTenantSlot && i.actorId !== event.actor!.id)) {
                // A non-linked party answering a pending slot question is held.
                const foreign = s.issues().filter(i => !!i.engagement?.pendingTenantSlot);
                if (foreign.length && /slot|visit|time|confirm|thursday|monday|tuesday|wednesday|friday|saturday|sunday/i.test(decoded.body)) {
                    this.trace(event, 'Route', 'review', 'Slot confirmation must come from the linked tenant');
                    this.complete(event, undefined, 'Routing review required');
                    return;
                }
            }
        }
        const issues = s.issues();
        const messageText = this.messageText(event, decoded.body);
        let candidates: Issue[] = [];
        let explicit = false;
        let strongLink = false;
        if (issues.some(i => i.evidence.some(e => e.eventId === event.id))) {
            candidates = issues.filter(i => i.evidence.some(e => e.eventId === event.id));
            explicit = true;
        }
        else if (decoded.issueId) {
            candidates = issues.filter(i => i.id === decoded.issueId);
            explicit = true;
        }
        else if (decoded.caseId) {
            candidates = issues.filter(i => i.remoteCase?.id === decoded.caseId);
            explicit = true;
        }
        else if (decoded.replyToEventId) {
            candidates = issues.filter(i => i.evidence.some(e => e.eventId === decoded.replyToEventId));
            explicit = true;
        }
        else if (decoded.conversationId && !decoded.newIssue) {
            candidates = issues.filter(i => i.conversationId === decoded.conversationId);
            explicit = candidates.length > 0;
        }
        else if (!decoded.newIssue) {
            candidates = issues.filter(i => i.actorId === event.actor!.id && i.status === 'awaitingReply' && (!decoded.propertyId || !i.propertyId || i.propertyId === decoded.propertyId));
            if (candidates.length === 0) {
                candidates = strongLinkCandidates(event.actor!.id, decoded, messageText, issues);
                strongLink = candidates.length > 0;
            }
        }
        if (candidates.length > 1 || (explicit && candidates.length !== 1)) {
            this.trace(event, 'Route', 'review', 'Ambiguous or unknown explicit issue reference; held without writes');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        let issue = candidates[0];
        if (issue && !explicit && !strongLink && !decoded.conversationId && !decoded.newIssue) {
            const prior = topicKeywords(issue.evidence.map(e => e.body).join(' '));
            const incoming = topicKeywords(messageText);
            if (prior.size && incoming.size && ![...incoming].some(x => prior.has(x)))
                issue = undefined;
            else if (!incoming.size && !/^(?:yes|no|it|that|this|still|now|actually|the same)\b/i.test(decoded.body.trim())) {
                this.trace(event, 'Route', 'review', 'Unlinked answer cannot be confidently associated with outstanding question');
                this.complete(event, undefined, 'Routing review required');
                return;
            }
        }
        if (issue && ((decoded.caseId && issue.remoteCase?.id !== decoded.caseId) || (decoded.conversationId && issue.conversationId && issue.conversationId !== decoded.conversationId) || (decoded.replyToEventId && !issue.evidence.some(e => e.eventId === decoded.replyToEventId)) || (decoded.propertyId && issue.propertyId && issue.propertyId !== decoded.propertyId))) {
            this.trace(event, 'Route', 'review', 'Conflicting issue, case, property or conversation references');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        if (!issue && !explicit && !decoded.newIssue && !decoded.conversationId && issues.some(i => i.actorId === event.actor!.id) && /^(?:it|that|this|yes|no|also|actually|still|now|the same|sorry|update)\b/i.test(decoded.body.trim())) {
            this.trace(event, 'Route', 'review', 'Possible reply without an unambiguous link; held without writes');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        if (!issue) {
            if (event.actor.role !== 'tenant') {
                this.trace(event, 'Route', 'review', 'Unlinked non-tenant message');
                this.complete(event, undefined, 'Routing review required');
                return;
            }
            issue = { id: 'issue-' + randomUUID(), session: s.session, actorId: event.actor.id, propertyId: decoded.propertyId, conversationId: decoded.conversationId, status: 'active', evidence: [] };
        }
        if(issue.waiting){
            if(issue.waiting.trigger.kind==='tenantReply'&&event.actor.id!==issue.waiting.actorId){this.trace(event,'Route','review','Reply actor does not match outstanding wait',issue);this.complete(event,issue,'Unmatched reply retained without clearing wait');return;}
            if(issue.status==='review'&&issue.humanAction?.startsWith(WAIT_REVIEW_PREFIX))issue.status='active';
            if(issue.waiting.trigger.kind==='tenantReply'){issue.lastQuestion=issue.outstandingQuestion;delete issue.outstandingQuestion;}
            clearWaiting(issue);
        }
        if (decoded.supersedes && !issue.evidence.some(e => e.eventId === decoded.supersedes && e.cursor < event.cursor)) {
            issue.status = 'review';
            issue.humanAction = 'Correction references missing or foreign evidence';
            this.trace(event, 'Route', 'review', issue.humanAction, issue);
            this.complete(event, issue, issue.humanAction);
            return;
        }
        if (!issue.evidence.some(e => e.eventId === event.id))
            issue.evidence.push({ eventId: event.id, cursor: event.cursor, actor: event.actor, body: decoded.body, occurredAt: event.occurred_at, ...(decoded.subject ? { subject: decoded.subject } : {}), ...(decoded.supersedes ? { supersedes: decoded.supersedes } : {}) });
        s.putIssue(issue);
        this.trace(event, 'Route', 'Assess', 'Material observation linked', issue);
        const blocked = s.intents().some(i => i.issueId === issue!.id && ['uncertain', 'deferred', 'queued', 'inflight'].includes(i.state));
        if (issue.status === 'review' || blocked) {
            for (const prior of s.intents().filter(i => i.issueId === issue!.id && ['queued', 'deferred'].includes(i.state))) {
                prior.state = 'failed';
                prior.result = { error: 'New evidence arrived while write deferred; action cancelled for review' };
                s.transaction(() => { s.putIntent(prior); s.finish(prior.eventId); });
            }
            issue.status = 'review';
            this.complete(event, issue, 'Issue held for human review or unresolved prior action');
            return;
        }
        let decision: Decision;
        try {
            const candidate = await assess(issue, issue.evidence, precedents);
            this.trace(event, 'Assess', 'Validate', candidate.reason ?? 'Assess completed', issue);
            decision = validateDecision(issue, candidate);
            this.trace(event, 'Validate', 'Act', decision.reason, issue, decision);
        }
        catch (error) {
            issue.status = 'review';
            issue.humanAction = 'Assessment/validation failed: ' + safeError(error);
            this.trace(event, 'Validate', 'review', issue.humanAction, issue);
            this.complete(event, issue, 'No write on invalid decision');
            return;
        }
        if(decision.scope)issue.scope=decision.scope;
        if (decision.humanAction)
            issue.humanAction = decision.humanAction;
        if (decision.kind === 'wait' || decision.kind === 'review' || decision.kind === 'outOfScope') {
            issue.status = decision.kind === 'wait' ? 'waiting' : decision.kind;
            if(decision.kind==='wait'){
                if(!decision.resume||decision.resume.kind==='operatorReview'){issue.status='review';issue.humanAction='Waiting requires operator review: '+decision.reason;}
                else {startWaiting(issue,event,decision.resume,(this.dependencies.now??Date.now)(),this.dependencies.reviewAfterMs);if(this.dependencies.reviewAfterMs===undefined)issue.status='review';}
            }else clearWaiting(issue);
            if (decision.urgency)
                issue.urgency = decision.urgency;
            this.complete(event, issue, decision.reason);
            return;
        }
        const intent: Intent = { id: 'action-' + randomUUID(), eventId: event.id, issueId: issue.id, decision, state: 'queued', attempts: 0 };
        s.transaction(() => { s.putIssue(issue!); s.putIntent(intent); });
        await this.dispatch(event, issue, intent);
    }
    private async dispatch(event: WorldEvent, issue: Issue, intent: Intent) {
        const { store: s, world } = this.dependencies;
        const stop = s.meta('mutationsStopped');
        if (stop) {
            intent.state = 'failed';
            intent.result = { error: stop };
            issue.status = 'review';
            issue.humanAction = stop;
            s.transaction(() => { s.putIntent(intent); s.putIssue(issue); this.trace(event, 'Checkpoint', 'failed', stop, issue, intent.result); this.finishEventIfIdle(event.id); });
            return;
        }
        intent.state = 'inflight';
        intent.attempts++;
        s.putIntent(intent);
        this.trace(event, 'Act', 'dispatch', intent.decision.reason, issue, { actionId: intent.id });
        const d = intent.decision;
        try {
            let result: unknown;
            if ('channel' in d) {
                result = await this.performChannel(event, issue, d);
            }
            else switch (d.kind) {
                case 'open':
                    result = await world.createCase({ title: d.title, urgency: d.urgency, ...(d.description ? { description: d.description } : {}), ...(issue.propertyId ? { property_id: issue.propertyId } : {}) });
                    issue.remoteCase = result as RemoteCase;
                    issue.urgency = d.urgency;
                    issue.status = 'active';
                    clearWaiting(issue);
                    delete issue.outstandingQuestion;
                    break;
                case 'update':
                    result = await world.patchCase(d.caseId, d.patch);
                    issue.remoteCase = result as RemoteCase;
                    issue.urgency = issue.remoteCase.urgency ?? issue.urgency;
                    issue.status = 'active';
                    clearWaiting(issue);
                    delete issue.outstandingQuestion;
                    break;
                case 'ask':
                    result = await world.sendMessage(d.actorId, { body: d.question });
                    issue.outstandingQuestion = d.question;
                    issue.status = 'awaitingReply';
                    startWaiting(issue,event,{kind:'tenantReply',condition:d.question},(this.dependencies.now??Date.now)(),this.dependencies.reviewAfterMs);
                    break;
                default: throw new Error('Invalid action intent');
            }
            intent.state = 'confirmed';
            intent.result = result;
            s.transaction(() => { s.putIntent(intent); s.putIssue(issue); this.trace(event, 'Checkpoint', 'confirmed', d.reason, issue, result); this.finishEventIfIdle(event.id); });
            if (!('channel' in d) && (d.kind === 'open' || d.kind === 'update'))
                await this.proposeContractor(event, issue);
        }
        catch (error) {
            const status = error instanceof WorldError ? error.status : undefined;
            if (status === 429 && intent.attempts < 4) {
                intent.state = 'deferred';
                intent.retryAt = Date.now() + Math.min(60000, Math.max(1000, (error as WorldError).retryAfterMs ?? 1000 * 2 ** intent.attempts));
                intent.result = { error: safeError(error) };
                s.putIntent(intent);
                this.trace(event, 'Act', 'deferred', 'Confirmed rate limit: persisted bounded retry', issue);
                return;
            }
            intent.state = error instanceof WorldError && !error.uncertain ? 'failed' : 'uncertain';
            intent.result = { error: safeError(error), status, ...(error instanceof WorldError ? { details: error.details, hint: error.hint } : {}) };
            issue.status = 'review';
            issue.humanAction = intent.state === 'uncertain' ? 'Remote outcome uncertain; reconcile before retry' : safeError(error);
            s.transaction(() => { s.putIntent(intent); s.putIssue(issue); this.trace(event, 'Checkpoint', intent.state, issue.humanAction!, issue, intent.result); this.finishEventIfIdle(event.id); if (status === 401 || status === 403)
                s.setMeta('mutationsStopped', status === 401 ? 'Authentication failed' : 'Session ended; mutations stopped'); });
            if (status === 401 || status === 403)
                throw error;
        }
    }
    /** An event with N intents is finished only when every sibling is terminal (confirmed/uncertain/failed). */
    private finishEventIfIdle(eventId: string) {
        const siblings = this.dependencies.store.intents().filter(i => i.eventId === eventId);
        if (siblings.some(i => ['queued', 'deferred', 'inflight'].includes(i.state)))
            return;
        this.dependencies.store.finish(eventId);
    }
    private async proposeContractor(event: WorldEvent, issue: Issue) {
        if (issue.scope === 'externalEmergency' || issue.scope === 'nonMaintenance' || issue.scope === 'unknown')
            return;
        if (issue.urgency !== 'medium' && issue.urgency !== 'high')
            return;
        let contractors;
        try {
            contractors = await this.dependencies.world.readContractors();
        }
        catch (error) {
            if (error instanceof WorldError && (error.status === 401 || error.status === 403))
                throw error;
            return;
        }
        const drafted = draftProposal(issue, contractors, knownLandlordAcross(issue, this.dependencies.store.issues()));
        if (!drafted)
            return;
        if ('review' in drafted) {
            issue.status = 'review';
            issue.humanAction = drafted.review;
            this.dependencies.store.putIssue(issue);
            this.trace(event, 'Act', 'review', drafted.review, issue);
            return;
        }
        issue.engagement = drafted.engagement;
        this.dependencies.store.putIssue(issue);
        if (!drafted.briefing || !issue.engagement.landlordId)
            return;
        // Briefing is a journaled effect — never a silent world call outside an intent.
        const effect: EffectDecision = { channel: 'effect', op: 'sendMessage', actorId: issue.engagement.landlordId, body: drafted.briefing, reason: 'Landlord contractor proposal briefing', evidenceIds: issue.evidence.map(e => e.eventId) };
        const intent: Intent = { id: 'action-' + randomUUID(), eventId: event.id, issueId: issue.id, decision: effect, state: 'queued', attempts: 0 };
        this.dependencies.store.putIntent(intent);
        await this.dispatch(event, issue, intent);
    }
    private effectDecision(effect: Effect, reason: string, evidenceIds: string[]): EffectDecision {
        if (effect.op === 'sendMessage')
            return { channel: 'effect', op: 'sendMessage', actorId: effect.actorId, body: effect.body, reason, evidenceIds };
        if (effect.op === 'createWorkOrder')
            return { channel: 'effect', op: 'createWorkOrder', input: effect.input, reason, evidenceIds };
        if (effect.op === 'patchWorkOrder')
            return { channel: 'effect', op: 'patchWorkOrder', id: effect.id, input: effect.input, reason, evidenceIds };
        return { channel: 'effect', op: 'patchCase', id: effect.id, input: effect.input, reason, evidenceIds };
    }
    private async commitPlan(event: WorldEvent, issue: Issue, plan: Plan, reason: string) {
        issue.engagement = plan.engagement;
        if (plan.status)
            issue.status = plan.status;
        if (plan.humanAction)
            issue.humanAction = plan.humanAction;
        for (const order of plan.mirrorOrders ?? [])
            this.mirrorOrder(order);
        this.dependencies.store.putIssue(issue);
        if (!plan.effects.length) {
            this.complete(event, issue, reason);
            return;
        }
        const evidenceIds = issue.evidence.map(e => e.eventId);
        await this.queuePartyMany(event, plan.effects.map(effect => ({ issue, decision: this.effectDecision(effect, reason, evidenceIds) })));
    }
    private async performEffect(issue: Issue, decision: EffectDecision): Promise<unknown> {
        if (decision.op === 'sendMessage')
            return this.dependencies.world.sendMessage(decision.actorId, { body: decision.body, ...(decision.subject ? { subject: decision.subject } : {}) });
        if (decision.op === 'createWorkOrder') {
            const order = await this.dependencies.world.createWorkOrder(decision.input);
            issue.engagement = { ...(issue.engagement ?? { excludedContractorIds: [] }), order };
            return order;
        }
        if (decision.op === 'patchCase') {
            const remote = await this.dependencies.world.patchCase(decision.id, decision.input);
            issue.remoteCase = remote;
            return remote;
        }
        if (issue.engagement?.order)
            this.mirrorOrder(issue.engagement.order);
        const order = await this.dependencies.world.patchWorkOrder(decision.id, decision.input);
        issue.engagement = { ...(issue.engagement ?? { excludedContractorIds: [] }), order: { ...(issue.engagement?.order ?? order), ...order } };
        return order;
    }
    private async performChannel(event: WorldEvent, issue: Issue, decision: LandlordDecision | ContractorAssessment | WorkOrderSignal | EffectDecision): Promise<unknown> {
        if (!('channel' in decision))
            throw new Error('Invalid action intent');
        if (decision.channel === 'effect')
            return this.performEffect(issue, decision);
        // Legacy single-intent channel decisions still expand through applyEffects for
        // already-persisted rows; new code paths journal one intent per effect via commitPlan.
        if (decision.channel === 'workOrder') {
            const contractors = decision.kind === 'declined' ? await this.dependencies.world.readContractors() : [];
            return this.applyEffects(issue, decision.kind === 'accepted' ? planWorkOrderAccepted(issue) : planWorkOrderDeclined(issue, contractors));
        }
        if (decision.channel === 'landlord') {
            if (!event.actor?.id)
                throw new Error('Unknown landlord actor');
            return this.applyEffects(issue, planLandlord(issue, decision, event.actor.id));
        }
        return this.applyEffects(issue, planContractor(issue, decision, decision.evidenceIds.at(-1) ?? event.id, await this.dependencies.world.readContractors()));
    }
    private async applyEffects(issue: Issue, plan: Plan): Promise<unknown[]> {
        issue.engagement = plan.engagement;
        if (plan.status)
            issue.status = plan.status;
        if (plan.humanAction)
            issue.humanAction = plan.humanAction;
        for (const order of plan.mirrorOrders ?? [])
            this.mirrorOrder(order);
        const results: unknown[] = [];
        for (const effect of plan.effects) {
            if (effect.op === 'sendMessage')
                results.push(await this.dependencies.world.sendMessage(effect.actorId, { body: effect.body }));
            else if (effect.op === 'createWorkOrder') {
                const order = await this.dependencies.world.createWorkOrder(effect.input);
                issue.engagement = { ...(issue.engagement ?? { excludedContractorIds: [] }), order };
                results.push(order);
            }
            else if (effect.op === 'patchCase') {
                const remote = await this.dependencies.world.patchCase(effect.id, effect.input);
                issue.remoteCase = remote;
                results.push(remote);
            }
            else {
                if (issue.engagement?.order)
                    this.mirrorOrder(issue.engagement.order);
                const order = await this.dependencies.world.patchWorkOrder(effect.id, effect.input);
                issue.engagement = { ...(issue.engagement ?? { excludedContractorIds: [] }), order: { ...(issue.engagement?.order ?? order), ...order } };
                results.push(order);
            }
        }
        return results;
    }
    private mirrorOrder(order: WorkOrder) {
        const orders = (this.dependencies.world as CoordinationWorldClient & { workOrders?: Map<string, WorkOrder> }).workOrders;
        const existing = orders?.get(order.id);
        if (existing && orders)
            orders.set(order.id, { ...existing, status: order.status });
    }
    private messageText(event: WorldEvent, body: string): string {
        const subject = typeof event.payload.subject === 'string' ? event.payload.subject : '';
        return [subject, body].filter(Boolean).join('\n');
    }
    private observe(event: WorldEvent, body: string) { return { eventId: event.id, cursor: event.cursor, actor: event.actor, body, occurredAt: event.occurred_at }; }
    private async queueParty(event: WorldEvent, issue: Issue, decision: AgentDecision) {
        // Channel decisions expand into per-effect journaled intents. Tenant Decision
        // rows and already-persisted effect rows stay one-intent-one-remote-call.
        if ('channel' in decision && decision.channel !== 'effect') {
            let plan: Plan;
            if (decision.channel === 'landlord') {
                if (!event.actor?.id)
                    throw new Error('Unknown landlord actor');
                plan = planLandlord(issue, decision, event.actor.id);
            }
            else if (decision.channel === 'workOrder') {
                const contractors = decision.kind === 'declined' ? await this.dependencies.world.readContractors() : [];
                plan = decision.kind === 'accepted' ? planWorkOrderAccepted(issue) : planWorkOrderDeclined(issue, contractors);
            }
            else
                plan = planContractor(issue, decision, decision.evidenceIds.at(-1) ?? event.id, await this.dependencies.world.readContractors());
            await this.commitPlan(event, issue, plan, decision.reason);
            return;
        }
        const intent: Intent = { id: 'action-' + randomUUID(), eventId: event.id, issueId: issue.id, decision, state: 'queued', attempts: 0 };
        this.dependencies.store.transaction(() => { this.dependencies.store.putIssue(issue); this.dependencies.store.putIntent(intent); });
        await this.dispatch(event, issue, intent);
    }
    private async queuePartyMany(event: WorldEvent, items: { issue: Issue; decision: AgentDecision }[]) {
        const queued = items.map(({ issue, decision }) => ({ issue, intent: { id: 'action-' + randomUUID(), eventId: event.id, issueId: issue.id, decision, state: 'queued' as const, attempts: 0 } }));
        this.dependencies.store.transaction(() => {
            for (const { issue, intent } of queued) {
                this.dependencies.store.putIssue(issue);
                this.dependencies.store.putIntent(intent);
            }
        });
        for (const { issue, intent } of queued)
            await this.dispatch(event, issue, intent);
    }
    private async runLandlordFanOut(event: WorldEvent, targets: Issue[], text: string) {
        const body = (decodeEvent(event).body ?? text);
        const items: { issue: Issue; decision: AgentDecision }[] = [];
        let sharedAsk: LandlordDecision | undefined;
        for (const target of targets) {
            if (!target.evidence.some(evidence => evidence.eventId === event.id))
                target.evidence.push(this.observe(event, body));
            if (target.status === 'review' || this.dependencies.store.intents().some(intent => intent.issueId === target.id && ['uncertain', 'deferred', 'queued', 'inflight'].includes(intent.state))) {
                this.trace(event, 'Route', 'review', 'Issue held for human review or unresolved prior action', target);
                this.dependencies.store.putIssue(target);
                continue;
            }
            this.trace(event, 'Route', 'LandlordTriage', 'Landlord plural instruction linked', target);
            try {
                let decision = this.dependencies.assessLandlord ? await this.dependencies.assessLandlord(target, text) : classifyLandlord(text, [event.id]);
                decision = validateLandlordDecision(event.actor!, text, decision, target);
                if (decision.kind === 'ask' || decision.kind === 'review') {
                    sharedAsk ??= { channel: 'landlord', kind: 'ask', question: bothCasesQuestion(targets), evidenceIds: [event.id], reason: 'Plural landlord instruction needs a per-case decision' };
                    continue;
                }
                this.trace(event, 'LandlordTriage', 'Validate', decision.reason, target);
                this.trace(event, 'Validate', 'Act', decision.reason, target, decision);
                items.push({ issue: target, decision });
            }
            catch (error) {
                target.status = 'review';
                target.humanAction = 'Landlord validation failed: ' + safeError(error);
                this.trace(event, 'Validate', 'review', target.humanAction, target);
                this.dependencies.store.putIssue(target);
            }
        }
        if (sharedAsk && !items.length) {
            // One clarifying message listing every case — never "Which issue do you mean?".
            const anchor = targets[0]!;
            if (!anchor.evidence.some(evidence => evidence.eventId === event.id))
                anchor.evidence.push(this.observe(event, body));
            this.trace(event, 'Route', 'LandlordTriage', sharedAsk.reason, anchor);
            await this.queueParty(event, anchor, validateLandlordDecision(event.actor!, text, sharedAsk, anchor));
            return;
        }
        if (!items.length) {
            this.complete(event, undefined, 'Plural landlord instruction held without writes');
            return;
        }
        await this.queuePartyMany(event, items);
    }
    private async runLandlord(event: WorldEvent, decoded: DecodedEvent) {
        const body = decoded.body ?? '';
        const text = this.messageText(event, body);
        const issues = this.dependencies.store.issues();
        const explicit = explicitIssue(decoded, issues);
        const property = matchProperty(text, issues);
        if (explicit.kind === 'ambiguous' || (explicit.kind === 'one' && property.kind === 'one' && explicit.issue.id !== property.issue.id)) {
            this.trace(event, 'Route', 'review', 'Conflicting or unknown landlord reference');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        let issue = explicit.kind === 'one' ? explicit.issue : property.kind === 'one' ? property.issue : undefined;
        const engaged = issues.filter(candidate => candidate.engagement?.landlordId === event.actor!.id && isOpenMaintenanceIssue(candidate));
        if (!issue && property.kind === 'many' && isPluralInstruction(text)) {
            await this.runLandlordFanOut(event, property.issues, text);
            return;
        }
        if (!issue && engaged.length > 1 && isPluralInstruction(text)) {
            await this.runLandlordFanOut(event, engaged, text);
            return;
        }
        // A landlord replying to a question we asked (which property? which
        // issue? missing budget/timeframe?) usually repeats no property phrase
        // and carries no explicit IDs, so explicit/property routing misses it.
        // Without this, every answer spawned a fresh placeholder issue and we
        // re-sent the identical question forever — and if the answer happened
        // to name the property, it was classified on its own as `review`,
        // poisoning the real case so no later landlord message was processed.
        const pendingList = issues.filter(candidate => candidate.engagement?.landlordId === event.actor!.id && !!candidate.engagement?.landlordQuestion);
        const pending = pendingList.length === 1 ? pendingList[0] : undefined;
        let context: Issue | undefined;
        if (!issue && pending) {
            context = pending;
            if (pending.remoteCase)
                issue = pending;
            else {
                // Placeholder from an unidentified-property/which-issue ask:
                // the answer identifies the case by title, if at all.
                issue = matchIssueByTitle(text, property.kind === 'many' ? property.issues : issues);
                if (!issue) {
                    // Answer still identifies nothing: do NOT ask again.
                    // Hold the placeholder for a human instead of looping.
                    if (!pending.evidence.some(evidence => evidence.eventId === event.id))
                        pending.evidence.push(this.observe(event, body));
                    pending.status = 'review';
                    pending.humanAction = 'Landlord reply did not identify a property or issue; operator to identify the case from: ' + text;
                    this.trace(event, 'Route', 'review', pending.humanAction, pending);
                    this.complete(event, pending, 'Landlord answer held for operator review instead of repeating the question');
                    return;
                }
            }
        }
        if (!issue && engaged.length === 1)
            issue = engaged[0];
        if (!issue && engaged.length > 1) {
            issue = { id: 'issue-' + randomUUID(), session: this.dependencies.store.session, actorId: event.actor!.id, status: 'active', evidence: [this.observe(event, body)] };
            const decision: LandlordDecision = { channel: 'landlord', kind: 'ask', question: whichIssueQuestion(engaged), evidenceIds: [event.id], reason: 'Several open issues already engage this landlord' };
            this.trace(event, 'Route', 'LandlordTriage', decision.reason, issue);
            await this.queueParty(event, issue, validateLandlordDecision(event.actor!, text, decision, issue));
            return;
        }
        if (!issue) {
            issue = { id: 'issue-' + randomUUID(), session: this.dependencies.store.session, actorId: event.actor!.id, status: 'active', evidence: [this.observe(event, body)] };
            const decision: LandlordDecision = property.kind === 'many'
                ? { channel: 'landlord', kind: 'ask', question: whichIssueQuestion(property.issues), evidenceIds: [event.id], reason: 'Several open issues match the property' }
                : { channel: 'landlord', kind: 'ask', question: NAME_PROPERTY_QUESTION, evidenceIds: [event.id], reason: 'No property identified' };
            this.trace(event, 'Route', 'LandlordTriage', decision.reason, issue);
            await this.queueParty(event, issue, validateLandlordDecision(event.actor!, text, decision, issue));
            return;
        }
        // Also when this message did name the property (so it routed straight
        // to the real case), a placeholder/earlier question from this same
        // landlord is still the context it may be answering.
        if (!context && pending)
            context = pending;
        if (!context && issue.engagement?.landlordQuestion && issue.engagement?.landlordId === event.actor!.id)
            context = issue;
        if (!issue.evidence.some(evidence => evidence.eventId === event.id))
            issue.evidence.push(this.observe(event, body));
        if (issue.status === 'review' || this.dependencies.store.intents().some(intent => intent.issueId === issue!.id && ['uncertain', 'deferred', 'queued', 'inflight'].includes(intent.state))) {
            this.trace(event, 'Route', 'review', 'Issue held for human review or unresolved prior action', issue);
            this.complete(event, issue, 'Issue held for human review or unresolved prior action');
            return;
        }
        this.trace(event, 'Route', 'LandlordTriage', 'Landlord message linked', issue);
        try {
            let effectiveText = text;
            let decision = this.dependencies.assessLandlord ? await this.dependencies.assessLandlord(issue, text) : classifyLandlord(text, [event.id]);
            if (context && (decision.kind === 'ask' || decision.kind === 'review')) {
                // This message answers our outstanding question, so judge it
                // together with the landlord's earlier message(s) that the
                // question was about (e.g. "…if up to £200" + "Thursday", or
                // "please go ahead" + "Flat 12"). Only fall back to the
                // combined reading when the reply alone states no decision.
                const prior = context.evidence.filter(evidence => evidence.eventId !== event.id && evidence.actor?.role === 'landlord').map(evidence => evidence.body);
                if (prior.length) {
                    const combined = [...prior, text].join('\n');
                    const combinedDecision = this.dependencies.assessLandlord ? await this.dependencies.assessLandlord(issue, combined) : classifyLandlord(combined, [event.id]);
                    if (combinedDecision.kind !== 'ask' && combinedDecision.kind !== 'review') {
                        decision = combinedDecision;
                        effectiveText = combined;
                    }
                    else if (context.id !== issue.id && combinedDecision.kind === 'review') {
                        // Property/issue now identified, but the landlord has
                        // still stated no decision: ask what they want done
                        // with this case rather than holding it for review.
                        decision = { channel: 'landlord', kind: 'ask', question: `Thanks — I've linked this to "${issue.remoteCase?.title ?? 'the repair'}". Would you like to approve it, approve it only within a budget and timeframe, request a written quote, or reject it?`, evidenceIds: [event.id], reason: 'Landlord identified the case but stated no decision' };
                    }
                    else if (combinedDecision.kind === 'ask')
                        decision = combinedDecision;
                }
            }
            if (decision.kind === 'ask' && context?.engagement?.landlordQuestion && decision.question === context.engagement.landlordQuestion) {
                // Never send the identical question twice in a row: the reply
                // did not supply what was asked, so a human takes over.
                decision = { channel: 'landlord', kind: 'review', evidenceIds: [event.id], reason: 'Landlord reply did not answer the outstanding question (' + decision.question + '); held for operator review instead of asking again' };
            }
            if (context && context.id !== issue.id) {
                // Placeholder question is resolved into the real case; retire it
                // so it can never be re-asked or re-matched.
                delete context.engagement!.landlordQuestion;
                this.dependencies.store.putIssue(context);
            }
            if (decision.proposedPropertyText) {
                const accepted = acceptProposedMatch(effectiveText, decision.proposedPropertyText, [...issues.filter(candidate => candidate.id !== issue!.id), issue]);
                if (!accepted || accepted.id !== issue.id)
                    throw new Error('Proposed property match is not in the message or matches another issue');
            }
            decision = validateLandlordDecision(event.actor!, effectiveText, decision, issue);
            this.trace(event, 'LandlordTriage', 'Validate', decision.reason, issue);
            this.trace(event, 'Validate', 'Act', decision.reason, issue, decision);
            await this.queueParty(event, issue, decision);
        }
        catch (error) {
            issue.status = 'review';
            issue.humanAction = 'Landlord validation failed: ' + safeError(error);
            this.trace(event, 'Validate', 'review', issue.humanAction, issue);
            this.complete(event, issue, 'No write on invalid landlord decision');
        }
    }
    private async runContractor(event: WorldEvent, decoded: DecodedEvent) {
        const body = decoded.body ?? '';
        const text = this.messageText(event, body);
        const waiting = this.dependencies.store.issues().filter(issue => issue.engagement?.proposal?.id === event.actor!.id || (issue.engagement?.order?.contractor_id === event.actor!.id && issue.engagement.order.status !== 'declined'));
        let issue = waiting.length === 1 ? waiting[0] : undefined;
        if (waiting.length > 1) {
            const property = matchProperty(text, waiting);
            if (property.kind === 'one')
                issue = property.issue;
        }
        if (!issue) {
            this.trace(event, 'Route', 'review', waiting.length > 1 ? 'Several engagements await this contractor' : 'No outstanding contractor engagement');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        if (!issue.evidence.some(evidence => evidence.eventId === event.id))
            issue.evidence.push(this.observe(event, body));
        this.trace(event, 'Route', 'ContractorTriage', 'Contractor message linked', issue);
        try {
            const decision = validateContractorAssessment(issue, event.actor!, text, this.dependencies.assessContractor ? await this.dependencies.assessContractor(issue, text) : classifyContractor(issue, text, [event.id]));
            this.trace(event, 'ContractorTriage', 'Validate', decision.reason, issue);
            this.trace(event, 'Validate', 'Act', decision.reason, issue, decision);
            await this.queueParty(event, issue, decision);
        }
        catch (error) {
            issue.status = 'review';
            issue.humanAction = 'Contractor validation failed: ' + safeError(error);
            this.trace(event, 'Validate', 'review', issue.humanAction, issue);
            this.complete(event, issue, 'No write on invalid contractor assessment');
        }
    }
    private matchWorkOrder(event: WorldEvent): Issue | 'ambiguous' | undefined {
        const workOrderId = typeof event.payload.work_order_id === 'string' ? event.payload.work_order_id : typeof event.payload.workOrderId === 'string' ? event.payload.workOrderId : undefined;
        const caseId = typeof event.payload.case_id === 'string' ? event.payload.case_id : typeof event.payload.caseId === 'string' ? event.payload.caseId : undefined;
        const issues = this.dependencies.store.issues();
        if (workOrderId) {
            const found = issues.filter(issue => issue.engagement?.order?.id === workOrderId);
            if (found.length === 1)
                return found[0];
            return found.length > 1 ? 'ambiguous' : undefined;
        }
        if (!caseId || !event.actor)
            return undefined;
        const found = issues.filter(issue => issue.remoteCase?.id === caseId && issue.engagement?.order?.contractor_id === event.actor!.id && issue.engagement.order.status === 'pending');
        if (found.length === 1)
            return found[0];
        return found.length > 1 ? 'ambiguous' : undefined;
    }
    private async runWorkOrder(event: WorldEvent) {
        const matched = this.matchWorkOrder(event);
        if (matched === 'ambiguous' || !matched) {
            this.trace(event, 'Route', 'review', 'Work order event could not be tied to the pending order');
            this.complete(event, undefined, 'Routing review required');
            return;
        }
        const order = matched.engagement?.order;
        if (!event.actor || event.actor.role !== 'contractor' || !order || event.actor.id !== order.contractor_id || order.status !== 'pending') {
            this.trace(event, 'Route', 'review', 'Work order event actor does not match the pending order', matched);
            this.complete(event, matched, 'Routing review required');
            return;
        }
        if (!matched.evidence.some(evidence => evidence.eventId === event.id))
            matched.evidence.push(this.observe(event, event.type));
        const decision: WorkOrderSignal = { channel: 'workOrder', kind: event.type === 'work_order.accepted' ? 'accepted' : 'declined', evidenceIds: [event.id], reason: event.type === 'work_order.accepted' ? 'Contractor accepted the work order' : 'Contractor declined the work order' };
        this.trace(event, 'Route', 'ContractorTriage', decision.reason, matched);
        this.trace(event, 'ContractorTriage', 'Validate', decision.reason, matched);
        this.trace(event, 'Validate', 'Act', decision.reason, matched, decision);
        await this.queueParty(event, matched, decision);
    }
    private async runSystem(event: WorldEvent, decoded: DecodedEvent) {
        const s = this.dependencies.store;
        if (event.type === 'session.ended') {
            s.setMeta('mutationsStopped', 'Session ended; mutations stopped');
            this.trace(event, 'Route', 'stop', 'Session ended; mutations stopped');
            this.complete(event, undefined, 'Session ended; mutations stopped');
            return;
        }
        if (event.type === 'session.started') {
            this.trace(event, 'Route', 'ignore', 'Session started; no mutation');
            this.complete(event, undefined, 'Session started retained for inspection');
            return;
        }
        if (event.type === 'case.acknowledged' || event.type === 'case.created' || event.type === 'case.updated') {
            const caseId = decoded.caseId;
            const linked = caseId ? s.issues().filter(issue => issue.remoteCase?.id === caseId) : [];
            if (linked.length === 1) {
                this.trace(event, 'Route', 'acknowledged', `Confirmed remote ${event.type} for linked case`, linked[0]);
                this.complete(event, linked[0], `Remote ${event.type} acknowledged without mutation`);
                return;
            }
            if (linked.length > 1) {
                this.trace(event, 'Route', 'review', `Ambiguous local issues for remote ${event.type}`);
                this.complete(event, undefined, 'Routing review required');
                return;
            }
            // Unmatched acknowledgements / creations stay inspectable — not mislabelled review-unknown.
            // Operator reconciliation may later bind an uncertain open intent to this event.
            this.trace(event, 'Route', 'observe', `Unmatched ${event.type} retained for inspection`);
            this.complete(event, undefined, `Retained ${event.type} for inspection`);
            return;
        }
        this.trace(event, 'Route', 'ignore', 'Unhandled system event');
        this.complete(event, undefined, 'Retained original event for inspection');
    }
}
function topicKeywords(body: string): Set<string> {
    return new Set((body.toLowerCase().match(/leak|water|pipe|drip|window|door|lock|heating|boiler|radiator|electric|socket|light|mould|noise/g) ?? []).map(x => /leak|water|pipe|drip/.test(x) ? 'water' : /heating|boiler|radiator/.test(x) ? 'heat' : /electric|socket|light/.test(x) ? 'electric' : x));
}
function issueThreadKey(issue: Issue): string | undefined {
    for (const evidence of issue.evidence) {
        const key = normaliseThreadKey(evidence.subject);
        if (key)
            return key;
    }
    return undefined;
}
/** Same-actor active/open issues with a strong follow-up link (thread key, property+topic, or topic overlap). */
function strongLinkCandidates(actorId: string, decoded: DecodedEvent, messageText: string, issues: Issue[]): Issue[] {
    const pool = issues.filter(issue => issue.actorId === actorId && ['active', 'awaitingReply', 'waiting'].includes(issue.status) && (!decoded.propertyId || !issue.propertyId || issue.propertyId === decoded.propertyId));
    if (!pool.length)
        return [];
    if (decoded.threadKey) {
        const byThread = pool.filter(issue => issueThreadKey(issue) === decoded.threadKey);
        if (byThread.length)
            return byThread;
    }
    const incoming = topicKeywords(messageText);
    const phrases = propertyPhrases(messageText);
    if (phrases.length && incoming.size) {
        const byPropertyAndTopic = pool.filter(issue => {
            const corpus = issueCorpus(issue).toLowerCase();
            if (!phrases.some(phrase => corpus.includes(phrase.toLowerCase())))
                return false;
            const prior = topicKeywords(issue.evidence.map(e => e.body).join(' '));
            return [...incoming].some(topic => prior.has(topic));
        });
        if (byPropertyAndTopic.length)
            return byPropertyAndTopic;
    }
    if (incoming.size) {
        const byTopic = pool.filter(issue => {
            const prior = topicKeywords(issue.evidence.map(e => e.body).join(' '));
            return prior.size > 0 && [...incoming].some(topic => prior.has(topic));
        });
        if (byTopic.length)
            return byTopic;
    }
    return [];
}
function safeError(error: unknown) { return error instanceof Error ? error.message : 'Unknown failure'; }
export async function processEvent(event: WorldEvent, dependencies: GraphDependencies) { await new Graph(dependencies).processEvent(event); }
