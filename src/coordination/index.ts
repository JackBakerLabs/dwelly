import type { WorldEvent } from '../types.js';
import type { Store } from '../store/index.js';

/**
 * Read-only inspection of legacy Coordinator tables left in older session DBs.
 * The Coordinator writer is retired; all live coordination runs on the graph-native
 * engagement path in `src/graph/index.ts` + `src/triage/engagement.ts`.
 */
export function inspectCoordination(store: Store, issueId: string): unknown {
    const exists = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_states'").get();
    if (!exists)
        return undefined;
    const row = store.db.prepare('SELECT data FROM coordination_states WHERE id=?').get(issueId) as { data: string } | undefined;
    const events = (store.db.prepare('SELECT data FROM coordination_events ORDER BY cursor').all() as { data: string }[]).map(r => JSON.parse(r.data) as WorldEvent);
    const effects = (store.db.prepare('SELECT data FROM coordination_effects').all() as { data: string }[]).map(r => JSON.parse(r.data) as { issueId: string });
    return {
        state: row ? JSON.parse(row.data) : undefined,
        events: events.filter(e => e.payload.case_id === store.issue(issueId)?.remoteCase?.id),
        effects: effects.filter(e => e.issueId === issueId),
        note: 'Legacy coordination tables are inspect-only; the graph engagement path is the writer.',
    };
}
