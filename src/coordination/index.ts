import { z } from 'zod';
import type { CoordinationWorldClient, Issue, WorkOrder, WorldEvent } from '../types.js';
import type { Store } from '../store/index.js';
import { WorldError } from '../world/index.js';
interface State {
    issueId: string;
    trade: string;
    phase: 'selecting' | 'pending' | 'coordination' | 'approval' | 'booking' | 'booked' | 'confirmed' | 'complete' | 'review';
    declined: string[];
    order?: WorkOrder;
    landlordId?: string;
    limit?: number;
    approvedQuote?: number;
    quote?: number;
    tenantSlot?: string;
    contractorSlot?: string;
    reason?: string;
}
interface Effect {
    id: string;
    issueId: string;
    operation: string;
    input: unknown;
    state: 'inflight' | 'confirmed' | 'uncertain' | 'failed';
    result?: unknown;
}
const money = z.number().min(0).max(1000000);
const facts = z.object({ case_id: z.string().min(1), work_order_id: z.string().optional(), cost_estimate_gbp: money.optional(), spending_limit_gbp: money.optional(), approved_quote_gbp: money.optional(), slot: z.string().min(1).max(200).optional(), completed: z.boolean().optional() }).strict();
const kinds = new Set(['work_order.accepted', 'work_order.declined', 'coordination.authority', 'coordination.quote', 'coordination.approval', 'coordination.slot', 'coordination.confirmed', 'coordination.completed']);
export class Coordinator {
    private running = false;
    constructor(readonly dependencies: {
        store: Store;
        world: CoordinationWorldClient;
    }) {
        dependencies.store.db.exec('CREATE TABLE IF NOT EXISTS coordination_states(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS coordination_effects(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS coordination_events(id TEXT PRIMARY KEY,cursor INTEGER,data TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,before_state TEXT);');
        if (!(dependencies.store.db.prepare('PRAGMA table_info(coordination_events)').all() as {
            name: string;
        }[]).some(c => c.name === 'before_state'))
            dependencies.store.db.exec('ALTER TABLE coordination_events ADD COLUMN before_state TEXT');
        for (const effect of this.effects().filter(e => e.state === 'inflight')) {
            effect.state = 'uncertain';
            this.putEffect(effect);
            const state = this.state(effect.issueId);
            if (state)
                this.hold(state, 'Process stopped during remote effect; outcome uncertain, no retry');
        }
    }
    private state(id: string): State | undefined { const row = this.dependencies.store.db.prepare('SELECT data FROM coordination_states WHERE id=?').get(id) as {
        data: string;
    } | undefined; return row ? JSON.parse(row.data) : undefined; }
    private save(s: State) { this.dependencies.store.db.prepare('INSERT OR REPLACE INTO coordination_states VALUES(?,?)').run(s.issueId, JSON.stringify(s)); }
    private effects(): Effect[] { return (this.dependencies.store.db.prepare('SELECT data FROM coordination_effects').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Effect); }
    private putEffect(e: Effect) { this.dependencies.store.db.prepare('INSERT OR REPLACE INTO coordination_effects VALUES(?,?)').run(e.id, JSON.stringify(e)); }
    inspect(issueId: string) { return { state: this.state(issueId), effects: this.effects().filter(e => e.issueId === issueId) }; }
    private hold(state: State, reason: string) { state.phase = 'review'; state.reason = reason; this.save(state); const issue = this.dependencies.store.issue(state.issueId); if (issue) {
        issue.status = 'review';
        issue.humanAction = reason;
        this.dependencies.store.putIssue(issue);
    } }
    private async effect<T>(state: State, key: string, operation: string, input: unknown, run: () => Promise<T>): Promise<T> {
        const id = state.issueId + ':' + key;
        const old = this.effects().find(e => e.id === id);
        if (old) {
            if (old.state === 'confirmed')
                return old.result as T;
            throw new Error('Effect held for review: ' + id);
        }
        if (this.dependencies.store.meta('mutationsStopped'))
            throw new Error('Session mutations stopped');
        const effect: Effect = { id, issueId: state.issueId, operation, input, state: 'inflight' };
        this.putEffect(effect);
        try {
            const result = await run();
            effect.state = 'confirmed';
            effect.result = result;
            this.putEffect(effect);
            return result;
        }
        catch (error) {
            effect.state = error instanceof WorldError && !error.uncertain ? 'failed' : 'uncertain';
            effect.result = { error: error instanceof Error ? error.message : 'Remote failure' };
            this.putEffect(effect);
            if (error instanceof WorldError && (error.status === 401 || error.status === 403))
                this.dependencies.store.setMeta('mutationsStopped', error.status === 401 ? 'Authentication failed' : 'Session ended');
            this.hold(state, 'Coordination ' + effect.state + ': inspect effect before continuing');
            throw error;
        }
    }
    private async notify(state: State, key: string, body: string) { const issue = this.dependencies.store.issue(state.issueId)!; for (const actorId of [...new Set([issue.actorId, state.landlordId].filter((id): id is string => !!id))])
        await this.effect(state, key + ':notify:' + actorId, 'sendMessage', { actorId, body }, () => this.dependencies.world.sendMessage(actorId, { body })); }
    async start(issueId: string, trade: string) {
        const issue = this.dependencies.store.issue(issueId);
        if (!issue?.remoteCase)
            throw new Error('Coordination requires confirmed case');
        if (issue.status === 'review' || issue.status === 'outOfScope' || issue.humanAction || ['resolved', 'closed'].includes(issue.remoteCase.status))
            throw new Error('Issue unsuitable for contractor coordination');
        let state = this.state(issueId);
        if (state && state.phase !== 'selecting')
            return;
        state ??= { issueId, trade, phase: 'selecting', declined: [] };
        this.save(state);
        await this.assign(state, issue);
    }
    private async assign(state: State, issue: Issue) {
        const candidates = (await this.dependencies.world.readContractors()).filter(c => c.trade.toLowerCase() === state.trade.toLowerCase() && !state.declined.includes(c.id) && /^(available|immediate|today|now|available today|available now)$/i.test(c.availability.trim())).sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
        this.dependencies.store.trace({ session: this.dependencies.store.session, eventId: 'coordination:' + state.issueId, cursor: this.dependencies.store.cursor(), issueId: state.issueId, remoteId: issue.remoteCase!.id, node: 'Assess', edge: 'contractor-selection', evidenceIds: issue.evidence.map(e => e.eventId), reason: 'Exact trade and explicit current availability; rating tie-break', outcome: { candidates } });
        if (!candidates[0]) {
            this.hold(state, 'No currently listed contractor with explicitly suitable availability');
            return;
        }
        const input = { case_id: issue.remoteCase!.id, contractor_id: candidates[0].id };
        state.order = await this.effect(state, 'assignment:' + state.declined.length, 'createWorkOrder', input, () => this.dependencies.world.createWorkOrder(input));
        state.phase = 'pending';
        this.save(state);
    }
    async processEvent(event: WorldEvent): Promise<boolean> {
        if (!kinds.has(event.type))
            return false;
        this.dependencies.store.db.prepare('INSERT OR IGNORE INTO coordination_events(id,cursor,data,before_state) VALUES(?,?,?,?)').run(event.id, event.cursor, JSON.stringify(event), JSON.stringify(this.dependencies.store.issues().filter(i => i.remoteCase?.id === event.payload.case_id).map(i => this.state(i.id)).filter(Boolean)));
        await this.drain();
        return true;
    }
    async drain() { if (this.running)
        throw new Error('One coordinator worker per session'); this.running = true; try {
        const events = this.dependencies.store.db.prepare('SELECT data,before_state FROM coordination_events WHERE done=0 ORDER BY cursor').all() as {
            data: string;
            before_state: string | null;
        }[];
        for (const row of events) {
            const event = JSON.parse(row.data) as WorldEvent;
            for (const snapshot of JSON.parse(row.before_state ?? '[]') as State[]) {
                if (!this.effects().some(e => e.issueId === snapshot.issueId && ['uncertain', 'failed', 'inflight'].includes(e.state)))
                    this.save(snapshot);
            }
            await this.handle(event);
            this.dependencies.store.db.prepare('UPDATE coordination_events SET done=1 WHERE id=?').run(event.id);
        }
    }
    finally {
        this.running = false;
    } }
    private async handle(event: WorldEvent) {
        const parsed = facts.safeParse(event.payload);
        const matching = this.dependencies.store.issues().filter(i => i.remoteCase?.id === event.payload.case_id);
        const issue = matching.length === 1 ? matching[0] : undefined;
        const state = issue ? this.state(issue.id) : undefined;
        if (!parsed.success || !issue || !state || !event.actor) {
            if (state)
                this.hold(state, 'Unsupported or ambiguous coordination payload; inspect original event');
            this.dependencies.store.trace({ session: this.dependencies.store.session, eventId: event.id, cursor: event.cursor, issueId: issue?.id, node: 'Route', edge: 'review', evidenceIds: [event.id], reason: 'Coordination payload or link invalid', outcome: event });
            return;
        }
        if (state.phase === 'review' || state.phase === 'complete')
            return;
        const p = parsed.data;
        const actor = event.actor;
        const order = state.order;
        const contractor = actor.role === 'contractor' && actor.id === order?.contractor_id;
        if (p.work_order_id !== order?.id && event.type !== 'coordination.authority') {
            this.hold(state, 'Unknown or missing work order reference');
            return;
        }
        const key = event.id;
        switch (event.type) {
            case 'work_order.declined':
                if (!contractor || state.phase !== 'pending') {
                    this.hold(state, 'Invalid decline attribution or transition');
                    return;
                }
                state.declined.push(order!.contractor_id);
                state.phase = 'selecting';
                delete state.order;
                this.save(state);
                await this.assign(state, issue);
                return;
            case 'work_order.accepted':
                if (!contractor || state.phase !== 'pending') {
                    this.hold(state, 'Invalid acceptance attribution or transition');
                    return;
                }
                order!.status = 'accepted';
                state.phase = 'coordination';
                this.save(state);
                return;
            case 'coordination.authority':
                if (actor.role !== 'landlord' || p.spending_limit_gbp === undefined || (state.landlordId && state.landlordId !== actor.id)) {
                    this.hold(state, 'Invalid landlord authority');
                    return;
                }
                state.landlordId = actor.id;
                state.limit = p.spending_limit_gbp;
                break;
            case 'coordination.quote':
                if (!contractor || order?.status !== 'accepted' || p.cost_estimate_gbp === undefined) {
                    this.hold(state, 'Invalid quote attribution or transition');
                    return;
                }
                if (state.quote !== p.cost_estimate_gbp) {
                    delete state.approvedQuote;
                    if (state.phase === 'booked' || state.phase === 'confirmed') {
                        this.hold(state, 'Quote changed after booking; review agreement');
                        return;
                    }
                }
                state.quote = p.cost_estimate_gbp;
                break;
            case 'coordination.approval':
                if (actor.role !== 'landlord' || (state.landlordId && state.landlordId !== actor.id) || p.approved_quote_gbp === undefined || p.approved_quote_gbp !== state.quote) {
                    this.hold(state, 'Approval does not cover current quote');
                    return;
                }
                state.landlordId = actor.id;
                state.approvedQuote = p.approved_quote_gbp;
                break;
            case 'coordination.slot':
                if (!p.slot || order?.status !== 'accepted' || (!contractor && actor.id !== issue.actorId)) {
                    this.hold(state, 'Invalid appointment agreement');
                    return;
                }
                if (order.slot && p.slot !== order.slot) {
                    this.hold(state, 'Appointment changed after agreement; human reconfirmation required');
                    return;
                }
                if (contractor)
                    state.contractorSlot = p.slot;
                else
                    state.tenantSlot = p.slot;
                break;
            case 'coordination.confirmed':
                if (!contractor || state.phase !== 'booked' || p.slot !== order?.slot) {
                    this.hold(state, 'Visit confirmation lacks matching booking');
                    return;
                }
                state.phase = 'confirmed';
                this.save(state);
                await this.notify(state, key, 'The contractor has confirmed the agreed visit: ' + order.slot);
                return;
            case 'coordination.completed':
                if (!contractor || state.phase !== 'confirmed' || p.completed !== true) {
                    this.hold(state, 'Completion is not attributable to confirmed visit');
                    return;
                }
                issue.remoteCase = await this.effect(state, key + ':resolve', 'patchCase', { status: 'resolved' }, () => this.dependencies.world.patchCase(issue.remoteCase!.id, { status: 'resolved' }));
                this.dependencies.store.putIssue(issue);
                state.phase = 'complete';
                this.save(state);
                await this.notify(state, key, 'The contractor reports the repair is complete. Please tell us if the problem remains.');
                return;
        }
        this.save(state);
        await this.coordinate(state, key);
    }
    private async coordinate(state: State, key: string) {
        if (state.quote === undefined || state.order?.status !== 'accepted')
            return;
        const approved = state.approvedQuote === state.quote || (state.limit !== undefined && state.quote <= state.limit);
        const patch = { cost_estimate_gbp: state.quote, landlord_approved: approved };
        if (state.order.cost_estimate_gbp !== state.quote || state.order.landlord_approved !== approved) {
            state.order = await this.effect(state, key + ':quote', 'patchWorkOrder', patch, () => this.dependencies.world.patchWorkOrder(state.order!.id, patch));
            this.save(state);
        }
        if (!approved) {
            state.phase = 'approval';
            this.save(state);
            if (state.landlordId)
                await this.effect(state, 'approval-request:' + state.quote, 'sendMessage', { actorId: state.landlordId, quote: state.quote }, () => this.dependencies.world.sendMessage(state.landlordId!, { body: `The contractor quoted £${state.quote}. Please explicitly approve this amount before booking.` }));
            else {
                state.reason = 'Awaiting known landlord authority before requesting approval';
                this.save(state);
            }
            return;
        }
        state.phase = 'booking';
        this.save(state);
        if (state.tenantSlot && state.tenantSlot === state.contractorSlot && !state.order.slot) {
            state.order = await this.effect(state, key + ':slot', 'patchWorkOrder', { slot: state.tenantSlot }, () => this.dependencies.world.patchWorkOrder(state.order!.id, { slot: state.tenantSlot! }));
            state.phase = 'booked';
            this.save(state);
            await this.notify(state, key, 'A visit slot has been agreed: ' + state.order.slot + '. Awaiting contractor confirmation.');
        }
    }
}
export function inspectCoordination(store: Store, issueId: string): unknown { const exists = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_states'").get(); if (!exists)
    return undefined; const row = store.db.prepare('SELECT data FROM coordination_states WHERE id=?').get(issueId) as {
    data: string;
} | undefined; return { state: row ? JSON.parse(row.data) : undefined, events: (store.db.prepare('SELECT data FROM coordination_events ORDER BY cursor').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as WorldEvent).filter(e => e.payload.case_id === store.issue(issueId)?.remoteCase?.id), effects: (store.db.prepare('SELECT data FROM coordination_effects').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Effect).filter(e => e.issueId === issueId) }; }
