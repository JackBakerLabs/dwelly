import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../store/index.js';
import type { WorldEvent } from '../types.js';

/** A short read transaction provides one coherent WAL snapshot, without writer recovery. */
export function observerSnapshot(path: string, session: string) {
    const store = new Store({ path, session, readOnly: true });
    try {
        store.db.exec('BEGIN');
        const rows = store.db.prepare('SELECT data,status FROM events ORDER BY cursor').all() as {data:string;status:string}[];
        const messages = rows.map(row => ({ ...JSON.parse(row.data) as WorldEvent, processingStatus: row.status }));
        const issues = store.issues();
        const traces = store.traces();
        const intents = store.intents();
        const coordination = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('coordination_states','coordination_effects')").all() as {name:string}[];
        const extra: Record<string, unknown[]> = {};
        for (const {name} of coordination) extra[name] = (store.db.prepare(`SELECT data FROM ${name}`).all() as {data:string}[]).map(row => JSON.parse(row.data));
        const result = { observer:true, mode:'Read-only database observer', session, database:resolve(path), refreshedAt:new Date().toISOString(),
            notice:'Connected to the database. Refreshing every second. This confirms database access, not worker liveness.',
            position:messages.length, total:messages.length, messages, nextMessage:null, issues, traces, intents,
            writes:intents.map(i => ({operation:('kind' in i.decision ? i.decision.kind : i.decision.op), id:i.id, state:i.state, decision:i.decision, result:i.result})),
            cursor:store.cursor(), pending:rows.filter(row => row.status === 'pending').length, coordination:extra };
        store.db.exec('COMMIT');
        return result;
    } finally { store.close(); }
}

export function createObserverServer(options: {path:string;session:string}) {
    const assets:Record<string,[string,string]> = {'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    const server = createServer((req,res) => {
        const reply = (status:number,data:unknown) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data)); };
        const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
        if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(req.headers.host ?? '')) { reply(403,{error:'Local requests only'});return; }
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        if (req.method !== 'GET') { reply(405,{error:'Observer is read-only; no mutations are available'});return; }
        const route = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (route === '/api/config') { reply(200,{observer:true,session:options.session,database:resolve(options.path)});return; }
        if (route === '/api/state') {
            try { reply(200,observerSnapshot(options.path,options.session)); }
            catch { reply(503,{error:'Database unavailable or session does not match. Check DWELLY_DB and DWELLY_SESSION_ID. Retrying automatically.'}); }
            return;
        }
        const asset = assets[route];
        if (!asset) { reply(404,{error:'Unknown route'});return; }
        try { res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store'});res.end(readFileSync(new URL('../../../web/demo/'+asset[0],import.meta.url))); }
        catch { res.end(); }
    });
    return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const session = process.env.DWELLY_SESSION_ID;
    if (!session) throw new Error('Set DWELLY_SESSION_ID to the live worker session. DWELLY_DB may override its default path.');
    const path = process.env.DWELLY_DB ?? resolve('.data',createHash('sha256').update(session).digest('hex').slice(0,20)+'.sqlite');
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
    const server = createObserverServer({path,session});
    server.on('error',error=>{console.error(error.message);process.exitCode=1;});
    server.listen(port,'127.0.0.1',()=>console.log(`Read-only observer: http://localhost:${port} — session ${session}; database ${resolve(path)}`));
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>server.close());
}
