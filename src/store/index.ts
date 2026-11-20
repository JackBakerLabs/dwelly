import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { remoteCaseSchema } from '../world/index.js';
import type { AgentDecision, EventBatch, Issue, RemoteCase, TraceEntry, WorldEvent } from '../types.js';
export interface Intent {
    id: string;
    eventId: string;
    issueId: string;
    decision: AgentDecision;
    state: 'queued' | 'inflight' | 'confirmed' | 'uncertain' | 'failed' | 'deferred';
    attempts: number;
    retryAt?: number;
    result?: unknown;
}
export class Store {
    readonly db!: DatabaseSync;
    readonly session: string;
    private lock?: string;
    constructor(options: {
        path: string;
        session: string;
        identity?: string;
        readOnly?: boolean;
    }) {
        this.session = options.session;
        if (options.path !== ':memory:' && !options.readOnly) {
            const path = resolve(options.path);
            mkdirSync(dirname(path), { recursive: true });
            this.lock = path + '.lock';
            try {
                mkdirSync(this.lock);
            }
            catch {
                let live = true;
                try {
                    const pid = Number(readFileSync(this.lock + '/pid', 'utf8'));
                    process.kill(pid, 0);
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code === 'ESRCH')
                        live = false;
                }
                if (live)
                    throw new Error('Database already has an active writer; inspect the lock if the owner has exited');
                rmSync(this.lock, { recursive: true });
                mkdirSync(this.lock);
            }
            writeFileSync(this.lock + '/pid', String(process.pid));
        }
        try {
            this.db = new DatabaseSync(options.path, { readOnly: options.readOnly ?? false });
            if (options.readOnly) {
                const binding = this.meta('binding');
                if (!binding || JSON.parse(binding).session !== options.session)
                    throw new Error('Database session binding mismatch');
                return;
            }
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,issue_id TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS traces(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);');
            const binding = JSON.stringify({ session: options.session, identity: options.identity ?? options.session });
            const old = this.meta('binding');
            if (old && old !== binding)
                throw new Error('Database session/credential binding mismatch; use a fresh database after reset');
            this.setMeta('binding', binding);
            this.transaction(() => { for (const intent of this.intents().filter(a => a.state === 'inflight')) {
                intent.state = 'uncertain';
                intent.result = { error: 'Process stopped after dispatch; remote outcome unknown' };
                this.putIntent(intent);
                const issue = this.issue(intent.issueId);
                if (issue) {
                    issue.status = 'review';
                    issue.humanAction = 'Uncertain remote write: inspect world events before any retry';
                    this.putIssue(issue);
                }
                this.finish(intent.eventId);
                const event = this.event(intent.eventId);
                if (event)
                    this.trace({ session: this.session, eventId: event.id, cursor: event.cursor, issueId: intent.issueId, node: 'Checkpoint', edge: 'uncertain', evidenceIds: intent.decision.evidenceIds, reason: 'Recovered in-flight action; retry prohibited' });
            } });
        }
        catch (e) {
            try {
                this.db!.close();
            }
            catch { }
            if (this.lock)
                rmSync(this.lock, { recursive: true, force: true });
            throw e;
        }
    }
    meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {
        value: string;
    } | undefined)?.value; }
    setMeta(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value); }
    cursor() { return Number(this.meta('cursor') ?? 0); }
    transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    ingest(batch: EventBatch) { this.transaction(() => { let cursor = this.cursor(); for (const event of batch.events) {
        if (event.cursor <= cursor && !this.event(event.id))
            throw new Error('Out-of-order event batch');
        this.db.prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,'pending')").run(event.id, event.cursor, JSON.stringify(event));
        cursor = Math.max(cursor, event.cursor);
    } if (batch.next_cursor < cursor)
        throw new Error('Cursor regression'); this.setMeta('cursor', String(batch.next_cursor)); }); }
    event(id: string): WorldEvent | undefined { const row = this.db.prepare('SELECT data FROM events WHERE id=?').get(id) as {
        data: string;
    } | undefined; return row ? JSON.parse(row.data) as WorldEvent : undefined; }
    status(id: string) { return (this.db.prepare('SELECT status FROM events WHERE id=?').get(id) as {
        status: string;
    } | undefined)?.status; }
    pending(): WorldEvent[] { return (this.db.prepare("SELECT data FROM events WHERE status='pending' ORDER BY cursor").all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as WorldEvent); }
    finish(id: string) { this.db.prepare("UPDATE events SET status='done' WHERE id=?").run(id); }
    putIssue(issue: Issue) { this.db.prepare('INSERT OR REPLACE INTO issues VALUES(?,?)').run(issue.id, JSON.stringify(issue)); }
    issue(id: string): Issue | undefined { return this.issues().find(i => i.id === id); }
    issues(): Issue[] { return (this.db.prepare('SELECT data FROM issues ORDER BY rowid').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Issue); }
    putIntent(intent: Intent) { this.db.prepare('INSERT OR REPLACE INTO intents VALUES(?,?,?,?)').run(intent.id, intent.eventId, intent.issueId, JSON.stringify(intent)); }
    intents(): Intent[] { return (this.db.prepare('SELECT data FROM intents ORDER BY rowid').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Intent); }
    trace(entry: TraceEntry) { this.db.prepare('INSERT INTO traces(data) VALUES(?)').run(JSON.stringify(entry)); }
    traces(): TraceEntry[] { return (this.db.prepare('SELECT data FROM traces ORDER BY seq').all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as TraceEntry); }
    inspect(id: string) { const issue = this.issue(id); if (!issue)
        throw new Error('Unknown issue ' + id); return { issue, events: this.traces().filter(t => t.issueId === id).map(t => t.eventId).filter((id, index, all) => all.indexOf(id) === index).map(id => this.event(id)), actions: this.intents().filter(i => i.issueId === id), trace: this.traces().filter(t => t.issueId === id) }; }
    /**
     * Operator confirms an observed remote case belongs to the uncertain open intent. Never sends a write.
     * Accepts `case.created` (full case payload) or `case.acknowledged` (title + urgency + case_id only).
     * Acknowledgements carry no description/property, so uniqueness of the uncertain open intent
     * (plus title + urgency match) is the safety property — not field-for-field payload equality.
     */
    reconcileCase(actionId: string, eventId: string) {
        const intent = this.intents().find(i => i.id === actionId);
        const event = this.event(eventId);
        const isOpenDecision = (decision: Intent['decision']): decision is Extract<Intent['decision'], { kind: 'open' }> => !('channel' in decision) && 'kind' in decision && decision.kind === 'open';
        if (!intent || intent.state !== 'uncertain' || !isOpenDecision(intent.decision))
            throw new Error('Only an uncertain case creation can be reconciled');
        if (!event || event.channel !== 'system' || (event.type !== 'case.created' && event.type !== 'case.acknowledged'))
            throw new Error('Choose a persisted system case.created or case.acknowledged event');
        const original = this.event(intent.eventId);
        if (!original || event.cursor <= original.cursor || Date.parse(event.occurred_at) < Date.parse(original.occurred_at))
            throw new Error('Observed creation must follow the original report');
        const issue = this.issue(intent.issueId);
        if (!issue)
            throw new Error('Missing local issue');
        const decision = intent.decision;
        let remote: RemoteCase;
        if (event.type === 'case.created') {
            remote = remoteCaseSchema.parse(event.payload.case);
            const matches = (candidate: Intent) => { if (!isOpenDecision(candidate.decision))
                return false; const local = this.issue(candidate.issueId); return remote.title === candidate.decision.title && remote.urgency === candidate.decision.urgency && remote.description === (candidate.decision.description ?? null) && remote.property_id === (local?.propertyId ?? null); };
            if (!matches(intent) || remote.status !== 'open')
                throw new Error('Observed case does not match the exact original creation fields');
            if (this.issues().some(i => i.remoteCase?.id === remote.id) || this.intents().filter(i => i.state === 'uncertain' && matches(i)).length !== 1)
                throw new Error('Ambiguous or already linked remote case');
        }
        else {
            const caseId = typeof event.payload.case_id === 'string' ? event.payload.case_id : typeof event.payload.caseId === 'string' ? event.payload.caseId : undefined;
            const title = typeof event.payload.title === 'string' ? event.payload.title : undefined;
            const urgency = event.payload.urgency;
            if (!caseId || !title || (urgency !== 'low' && urgency !== 'medium' && urgency !== 'high' && urgency !== 'emergency'))
                throw new Error('case.acknowledged requires case_id, title and urgency');
            if (title !== decision.title || urgency !== decision.urgency)
                throw new Error('Observed acknowledgement does not match the original creation title and urgency');
            const openUncertain = this.intents().filter(i => i.state === 'uncertain' && isOpenDecision(i.decision) && i.decision.title === title && i.decision.urgency === urgency);
            if (openUncertain.length !== 1 || this.issues().some(i => i.remoteCase?.id === caseId))
                throw new Error('Ambiguous or already linked remote case');
            const now = event.occurred_at;
            remote = { id: caseId, title, description: decision.description ?? null, urgency, property_id: issue.propertyId ?? null, status: 'open', created_at: now, updated_at: now };
        }
        this.transaction(() => { intent.state = 'confirmed'; intent.result = { reconciled: true, eventId, case: remote }; this.putIntent(intent); issue.remoteCase = remote; issue.urgency = remote.urgency ?? undefined; issue.status = 'active'; if (decision.humanAction)
            issue.humanAction = decision.humanAction; delete issue.outstandingQuestion; this.putIssue(issue); this.finish(intent.eventId); this.trace({ session: this.session, eventId: event.id, cursor: event.cursor, issueId: issue.id, remoteId: remote.id, node: 'Checkpoint', edge: 'reconciled', evidenceIds: [...decision.evidenceIds, event.id], reason: 'Operator confirmed a uniquely matching observed creation; no remote retry', outcome: { actionId, remoteId: remote.id } }); });
        return this.inspect(issue.id);
    }
    waitingQueue(){return this.issues().filter(i=>i.waiting||['waiting','awaitingReply'].includes(i.status)).map(i=>({issueId:i.id,status:i.status,scope:i.scope??null,waiting:i.waiting??null,humanAction:i.humanAction??(!i.waiting?'Legacy wait has no recorded trigger/deadline; operator review required':null)}));}
    reviewEvents() { const traced = new Set(this.traces().filter(t => t.edge === 'review' && !t.issueId).map(t => t.eventId)); return [...traced].map(id => ({ event: this.event(id), trace: this.traces().filter(t => t.eventId === id) })); }
    close() { this.db.close(); if (this.lock)
        rmSync(this.lock, { recursive: true, force: true }); }
}
