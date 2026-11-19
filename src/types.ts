export type Urgency = 'low' | 'medium' | 'high' | 'emergency';
export interface Actor {
    id: string;
    role: string;
    name: string;
}
export interface WorldEvent {
    id: string;
    cursor: number;
    type: string;
    channel: 'email' | 'system';
    actor: Actor | null;
    sim_ms: number;
    occurred_at: string;
    payload: Record<string, unknown>;
}
export interface EventBatch {
    events: WorldEvent[];
    next_cursor: number;
}
export interface CaseCreate {
    title: string;
    urgency: Urgency;
    description?: string;
    property_id?: string;
}
export interface CasePatch {
    title?: string;
    urgency?: Urgency;
    description?: string;
    status?: 'open' | 'in_progress' | 'resolved' | 'closed';
}
export interface RemoteCase {
    id: string;
    title: string;
    description: string | null;
    urgency: Urgency | null;
    property_id: string | null;
    status: 'open' | 'in_progress' | 'resolved' | 'closed';
    created_at: string;
    updated_at: string;
}
export interface HistoryCase {
    id: string;
    property: {
        id: string;
        address: string;
    };
    title: string;
    reported_at: string;
    messages: {
        from: 'tenant' | 'manager' | 'landlord' | 'contractor';
        name: string;
        sent_at: string;
        body: string;
    }[];
    classification: {
        urgency: Urgency;
        rationale: string;
    };
    contractor: {
        id: string | null;
        company: string | null;
        trade: string | null;
    } | null;
    cost_gbp: number | null;
    resolution: {
        status: 'resolved' | 'closed_out_of_scope' | 'escalated_externally';
        closed_at: string;
        summary: string;
    };
}
export interface WorldClient {
    poll(after: number): Promise<EventBatch>;
    readHistory(): Promise<HistoryCase[]>;
    createCase(input: CaseCreate): Promise<RemoteCase>;
    patchCase(id: string, input: CasePatch): Promise<RemoteCase>;
    sendMessage(actorId: string, input: {
        body: string;
        subject?: string;
    }): Promise<{
        status: 'accepted';
        note: string;
    }>;
}
export interface Observation {
    eventId: string;
    cursor: number;
    actor: Actor | null;
    body: string;
    occurredAt: string;
    supersedes?: string;
}
export interface Issue {
    id: string;
    session: string;
    actorId: string;
    propertyId?: string;
    conversationId?: string;
    status: 'active' | 'awaitingReply' | 'waiting' | 'outOfScope' | 'review';
    evidence: Observation[];
    remoteCase?: RemoteCase;
    outstandingQuestion?: string;
    urgency?: Urgency;
    humanAction?: string;
}
export interface DecisionBase {
    evidenceIds: string[];
    reason: string;
    humanAction?: string;
}
export type Decision = DecisionBase & ({
    kind: 'ask';
    actorId: string;
    question: string;
} | {
    kind: 'open';
    title: string;
    description?: string;
    urgency: Urgency;
} | {
    kind: 'update';
    caseId: string;
    patch: CasePatch;
} | {
    kind: 'wait';
    urgency?: Urgency;
} | {
    kind: 'outOfScope';
    urgency: Urgency;
} | {
    kind: 'review';
    urgency?: Urgency;
});
export type Assessor = (issue: Issue, evidence: Observation[], precedents: HistoryCase[]) => Promise<Decision>;
export interface TraceEntry {
    session: string;
    eventId: string;
    cursor: number;
    issueId?: string;
    remoteId?: string;
    node: 'Ingest' | 'Route' | 'Assess' | 'Validate' | 'Act' | 'Checkpoint';
    edge: string;
    evidenceIds: string[];
    reason: string;
    outcome?: unknown;
}
export interface DecodedEvent {
    kind: 'message' | 'echo' | 'unknown';
    body?: string;
    propertyId?: string;
    issueId?: string;
    caseId?: string;
    conversationId?: string;
    replyToEventId?: string;
    supersedes?: string;
    newIssue?: boolean;
}
export interface Contractor {
    id: string;
    name: string;
    trade: string;
    rating: number;
    availability: string;
}
export interface WorkOrder {
    id: string;
    case_id: string;
    contractor_id: string;
    slot: string | null;
    status: 'pending' | 'accepted' | 'declined';
    cost_estimate_gbp: number | null;
    landlord_approved: boolean | null;
    created_at: string;
}
export interface WorkOrderCreate {
    case_id: string;
    contractor_id: string;
    slot?: string;
    cost_estimate_gbp?: number;
}
export interface WorkOrderPatch {
    cost_estimate_gbp?: number;
    landlord_approved?: boolean;
    slot?: string;
}
export interface CoordinationWorldClient extends WorldClient {
    readContractors(): Promise<Contractor[]>;
    createWorkOrder(input: WorkOrderCreate): Promise<WorkOrder>;
    patchWorkOrder(id: string, input: WorkOrderPatch): Promise<WorkOrder>;
}
