import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CaseCreate, CasePatch, DecodedEvent, EventBatch, HistoryCase, RemoteCase, CoordinationWorldClient, Contractor, WorkOrder, WorkOrderCreate, WorkOrderPatch, WorldEvent } from '../types.js';
const urgency = z.enum(['low', 'medium', 'high', 'emergency']);
const status = z.enum(['open', 'in_progress', 'resolved', 'closed']);
const actor = z.object({ id: z.string().min(1), role: z.string(), name: z.string() });
export const eventSchema = z.object({ id: z.string().min(1), cursor: z.number().int().nonnegative(), type: z.string(), channel: z.enum(['email', 'system']), actor: actor.nullable(), sim_ms: z.number().int(), occurred_at: z.string().datetime({ offset: true }), payload: z.record(z.string(), z.unknown()) });
const batchSchema = z.object({ events: z.array(eventSchema), next_cursor: z.number().int().nonnegative() });
const createSchema = z.object({ title: z.string().min(1).max(300), urgency, description: z.string().max(10000).optional(), property_id: z.string().max(100).optional() }).strict();
const patchSchema = z.object({ title: z.string().min(1).max(300).optional(), urgency: urgency.optional(), description: z.string().max(10000).optional(), status: status.optional() }).strict().refine(x => Object.values(x).some(v => v !== undefined), 'At least one changed field is required');
const caseSchema = z.object({ id: z.string().uuid(), title: z.string(), description: z.string().nullable(), urgency: urgency.nullable(), property_id: z.string().nullable(), status, created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }) });
const messageSchema = z.object({ body: z.string().min(1).max(10000), subject: z.string().max(300).optional() }).strict();
const acceptedSchema = z.object({ status: z.literal('accepted'), note: z.string() });
const historySchema = z.object({ cases: z.array(z.object({ id: z.string().regex(/^case-\d{2}$/), property: z.object({ id: z.string(), address: z.string() }), title: z.string(), reported_at: z.string().datetime({ offset: true }), messages: z.array(z.object({ from: z.enum(['tenant', 'manager', 'landlord', 'contractor']), name: z.string(), sent_at: z.string().datetime({ offset: true }), body: z.string().min(1) })).min(3), classification: z.object({ urgency, rationale: z.string() }), contractor: z.object({ id: z.string().nullable(), company: z.string().nullable(), trade: z.string().nullable() }).nullable(), cost_gbp: z.number().nonnegative().nullable(), resolution: z.object({ status: z.enum(['resolved', 'closed_out_of_scope', 'escalated_externally']), closed_at: z.string().datetime({ offset: true }), summary: z.string() }) })) });
const contractorSchema = z.object({ id: z.string(), name: z.string(), trade: z.string(), rating: z.number(), availability: z.string() });
const contractorsSchema = z.object({ contractors: z.array(contractorSchema) });
const workOrderSchema = z.object({ id: z.string().uuid(), case_id: z.string().uuid(), contractor_id: z.string(), slot: z.string().nullable(), status: z.enum(['pending', 'accepted', 'declined']), cost_estimate_gbp: z.number().nonnegative().nullable(), landlord_approved: z.boolean().nullable(), created_at: z.string().datetime({ offset: true }) });
const workOrderCreateSchema = z.object({ case_id: z.string().uuid(), contractor_id: z.string().min(1), slot: z.string().max(200).optional(), cost_estimate_gbp: z.number().min(0).max(1000000).optional() }).strict();
const workOrderPatchSchema = z.object({ cost_estimate_gbp: z.number().min(0).max(1000000).optional(), landlord_approved: z.boolean().optional(), slot: z.string().min(1).max(200).optional() }).strict().refine(x => Object.values(x).some(v => v !== undefined), 'At least one changed field is required');
export class WorldError extends Error {
    constructor(message: string, public readonly status: number | undefined = undefined, public readonly uncertain = false, public readonly retryAfterMs?: number, public readonly details?: unknown, public readonly hint?: string) { super(message); this.name = 'WorldError'; }
}
export interface LiveOptions {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    readRetries?: number;
}
export class LiveWorldClient implements CoordinationWorldClient {
    private readonly fetcher: typeof fetch;
    private readonly base: string;
    private mutationsClosed = false;
    constructor(private readonly options: LiveOptions) {
        const url = new URL(options.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('World API requires HTTPS without URL credentials');
        if (!options.token.trim())
            throw new Error('World API token is required');
        this.base = options.baseUrl.replace(/\/$/, '');
        this.fetcher = options.fetch ?? fetch;
    }
    private async request<T>(path: string, method: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
        const mutation = method !== 'GET';
        if (mutation && this.mutationsClosed)
            throw new WorldError('Session has ended; mutations are closed', 403);
        const attempts = mutation ? 1 : 1 + Math.min(3, Math.max(0, this.options.readRetries ?? 2));
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                let response: Response;
                try {
                    response = await this.fetcher(`${this.base}${path}`, { method, headers: { Authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000), redirect: 'error' });
                }
                catch {
                    throw new WorldError('World API transport failed or timed out', undefined, mutation);
                }
                if (response.status === 403 && mutation)
                    this.mutationsClosed = true;
                let data: unknown;
                try {
                    data = await response.json();
                }
                catch {
                    throw new WorldError('World API returned invalid JSON', response.status, mutation && (response.ok || response.status >= 500));
                }
                if (!response.ok) {
                    if (response.status === 403 && mutation)
                        this.mutationsClosed = true;
                    const error = z.object({ error: z.string(), details: z.unknown().optional(), hint: z.string().optional() }).safeParse(data);
                    const retryHeader = response.headers.get('retry-after');
                    const delay = retryHeader ? (Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now()) : 1000;
                    throw new WorldError(error.success ? error.data.error : `World API HTTP ${response.status}`, response.status, mutation && response.status >= 500, response.status === 429 ? Math.min(60000, Math.max(1000, delay || 1000)) : undefined, error.success ? error.data.details : undefined, error.success ? error.data.hint : undefined);
                }
                const expected = method === 'POST' ? (path.startsWith('/actors/') ? 202 : 201) : 200;
                if (response.status !== expected)
                    throw new WorldError(`Unexpected HTTP status ${response.status}; expected ${expected}`, response.status, mutation);
                const parsed = schema.safeParse(data);
                if (!parsed.success)
                    throw new WorldError('World API response failed contract validation', response.status, mutation, undefined, parsed.error.issues);
                return parsed.data;
            }
            catch (error) {
                if (!(error instanceof WorldError) || mutation || attempt === attempts - 1 || !(error.status === undefined || error.status >= 500))
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
            }
        }
        throw new Error('Unreachable request state');
    }
    async poll(after: number): Promise<EventBatch> {
        z.number().int().nonnegative().parse(after);
        const batch = await this.request(`/events?after=${after}`, 'GET', batchSchema);
        let previous = after;
        for (const event of batch.events) {
            if (event.cursor <= previous)
                throw new WorldError('Event cursors must be strictly increasing');
            previous = event.cursor;
        }
        if (batch.next_cursor < previous || (!batch.events.length && batch.next_cursor !== after))
            throw new WorldError('Invalid next_cursor in event feed');
        return batch;
    }
    async readHistory(): Promise<HistoryCase[]> { return (await this.request('/history/cases', 'GET', historySchema)).cases; }
    createCase(input: CaseCreate): Promise<RemoteCase> { return this.request('/cases', 'POST', caseSchema, createSchema.parse(input)); }
    patchCase(id: string, input: CasePatch): Promise<RemoteCase> { z.string().min(1).parse(id); return this.request(`/cases/${encodeURIComponent(id)}`, 'PATCH', caseSchema, patchSchema.parse(input)); }
    async readContractors(): Promise<Contractor[]> { return (await this.request('/contractors', 'GET', contractorsSchema)).contractors; }
    createWorkOrder(input: WorkOrderCreate): Promise<WorkOrder> { return this.request('/work-orders', 'POST', workOrderSchema.refine(order => order.status === 'pending', 'A newly created work order must be pending'), workOrderCreateSchema.parse(input)); }
    patchWorkOrder(id: string, input: WorkOrderPatch): Promise<WorkOrder> { z.string().min(1).parse(id); return this.request(`/work-orders/${encodeURIComponent(id)}`, 'PATCH', workOrderSchema, workOrderPatchSchema.parse(input)); }
    sendMessage(actorId: string, input: {
        body: string;
        subject?: string;
    }) { z.string().min(1).parse(actorId); return this.request(`/actors/${encodeURIComponent(actorId)}/messages`, 'POST', acceptedSchema, messageSchema.parse(input)); }
}
/** Strip leading Re:/Fwd:/Fw: prefixes, trim, and case-fold for email thread matching. */
export function normaliseThreadKey(subject?: string): string | undefined {
    if (!subject)
        return undefined;
    let key = subject.trim();
    while (/^(?:re|fwd|fw)\s*:/i.test(key))
        key = key.replace(/^(?:re|fwd|fw)\s*:/i, '').trim();
    return key ? key.toLowerCase() : undefined;
}
/** Only documented envelope fields are guaranteed. These payload aliases are explicit integration assumptions. */
export function decodeEvent(event: WorldEvent): DecodedEvent {
    const p = event.payload;
    const str = (...keys: string[]) => { for (const key of keys) {
        const value = p[key];
        if (typeof value === 'string' && value.trim())
            return value;
    } return undefined; };
    const links = { propertyId: str('property_id', 'propertyId'), issueId: str('issue_id', 'issueId'), caseId: str('case_id', 'caseId'), conversationId: str('conversation_id', 'thread_id', 'conversationId'), replyToEventId: str('reply_to_event_id', 'in_reply_to', 'replyToEventId'), supersedes: str('supersedes_event_id', 'supersedes'), newIssue: p.new_issue === true || p.newIssue === true };
    const systemTypes = ['session.started', 'case.acknowledged', 'case.created', 'case.updated', 'session.ended'] as const;
    if ((systemTypes as readonly string[]).includes(event.type)) {
        const urgencyRaw = str('urgency');
        const urgency = urgencyRaw === 'low' || urgencyRaw === 'medium' || urgencyRaw === 'high' || urgencyRaw === 'emergency' ? urgencyRaw : undefined;
        return { kind: 'system', ...links, ...(str('title') ? { title: str('title') } : {}), ...(urgency ? { urgency } : {}) };
    }
    if (['message.sent', 'message.delivered', 'message.accepted'].includes(event.type))
        return { kind: 'echo', ...links };
    if (event.type !== 'message.received' || !event.actor || event.channel !== 'email')
        return { kind: 'unknown', ...links };
    const body = str('body', 'text', 'message');
    if (!body)
        return { kind: 'unknown', ...links };
    const subject = str('subject');
    const threadKey = normaliseThreadKey(subject);
    const subjectFields = { ...(subject ? { subject } : {}), ...(threadKey ? { threadKey } : {}) };
    if (/^(thanks?( you)?|thank you( very much)?|ok(ay)?|cheers|noted|received)[.!\s]*$/i.test(body.trim()))
        return { kind: 'echo', body, ...subjectFields, ...links };
    return { kind: 'message', body, ...subjectFields, ...links };
}
export interface RecordedWrite {
    operation: 'createCase' | 'patchCase' | 'sendMessage' | 'createWorkOrder' | 'patchWorkOrder';
    input: unknown;
    id?: string;
}
export class ReplayWorldClient implements CoordinationWorldClient {
    readonly writes: RecordedWrite[] = [];
    readonly cases = new Map<string, RemoteCase>();
    readonly workOrders = new Map<string, WorkOrder>();
    private readonly contractors: Contractor[];
    private readonly events: WorldEvent[];
    private readonly history: HistoryCase[];
    constructor(options: {
        events?: WorldEvent[];
        history?: HistoryCase[];
        contractors?: Contractor[];
    } = {}) { this.contractors = (options.contractors ?? []).map(c => contractorSchema.parse(c)); this.events = (options.events ?? []).map(e => eventSchema.parse(e)).sort((a, b) => a.cursor - b.cursor); this.history = options.history ?? []; }
    async poll(after: number): Promise<EventBatch> { const events = this.events.filter(e => e.cursor > after); return structuredClone({ events, next_cursor: events.at(-1)?.cursor ?? after }); }
    async readHistory(): Promise<HistoryCase[]> { return structuredClone(this.history); }
    async createCase(input: CaseCreate): Promise<RemoteCase> { const valid = createSchema.parse(input); const now = new Date().toISOString(); const result: RemoteCase = { id: randomUUID(), title: valid.title, description: valid.description ?? null, urgency: valid.urgency, property_id: valid.property_id ?? null, status: 'open', created_at: now, updated_at: now }; this.cases.set(result.id, result); this.writes.push({ operation: 'createCase', input: structuredClone(valid), id: result.id }); return structuredClone(result); }
    async patchCase(id: string, input: CasePatch): Promise<RemoteCase> { const valid = Object.fromEntries(Object.entries(patchSchema.parse(input)).filter(([, value]) => value !== undefined)) as CasePatch; const existing = this.cases.get(id); if (!existing)
        throw new WorldError('case_not_found', 404); const result = { ...existing, ...valid, updated_at: new Date().toISOString() }; this.cases.set(id, result); this.writes.push({ operation: 'patchCase', input: structuredClone(valid), id }); return structuredClone(result); }
    async readContractors(): Promise<Contractor[]> { return structuredClone(this.contractors); }
    async createWorkOrder(input: WorkOrderCreate): Promise<WorkOrder> {
        const valid = workOrderCreateSchema.parse(input);
        if (!this.cases.has(valid.case_id))
            throw new WorldError('case_not_found', 404);
        if (!this.contractors.some(c => c.id === valid.contractor_id))
            throw new WorldError('contractor_not_found', 404);
        const order: WorkOrder = { id: randomUUID(), case_id: valid.case_id, contractor_id: valid.contractor_id, slot: valid.slot ?? null, status: 'pending', cost_estimate_gbp: valid.cost_estimate_gbp ?? null, landlord_approved: null, created_at: new Date().toISOString() };
        this.workOrders.set(order.id, order);
        this.writes.push({ operation: 'createWorkOrder', input: structuredClone(valid), id: order.id });
        return structuredClone(order);
    }
    async patchWorkOrder(id: string, input: WorkOrderPatch): Promise<WorkOrder> {
        const valid = Object.fromEntries(Object.entries(workOrderPatchSchema.parse(input)).filter(([, value]) => value !== undefined)) as WorkOrderPatch;
        const existing = this.workOrders.get(id);
        if (!existing)
            throw new WorldError('work_order_not_found', 404);
        if (valid.slot !== undefined && existing.status !== 'accepted')
            throw new WorldError('work_order_not_accepted', 400);
        const result = { ...existing, ...valid };
        this.workOrders.set(id, result);
        this.writes.push({ operation: 'patchWorkOrder', input: structuredClone(valid), id });
        return structuredClone(result);
    }
    async sendMessage(actorId: string, input: {
        body: string;
        subject?: string;
    }): Promise<{
        status: 'accepted';
        note: string;
    }> { z.string().min(1).parse(actorId); const valid = messageSchema.parse(input); this.writes.push({ operation: 'sendMessage', input: structuredClone(valid), id: actorId }); return { status: 'accepted', note: 'Replay accepted for delivery' }; }
}
// Used by explicit operator reconciliation; never infer a remote case from a title match.
export { caseSchema as remoteCaseSchema };
