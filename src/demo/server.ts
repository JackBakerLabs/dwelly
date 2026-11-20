import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../store/index.js';
import { Graph, transitions } from '../graph/index.js';
import { ReplayWorldClient } from '../world/index.js';
import { buildCase04Replay, case04ScriptedAssessor, createModelAssessor, type ModelOptions, type AssessmentDiagnostic } from '../triage/index.js';
import { modelConfiguration } from '../triage/config.js';
import type { HistoryCase } from '../types.js';

/** All Dwelly effects stay simulated; optional model credentials remain server-side. */
export function createDemoServer(options: {model?:ModelOptions} = {}) {
    const diagnostics:AssessmentDiagnostic[] = [];
    const assess = options.model ? createModelAssessor({...options.model, onDiagnostic:entry=>diagnostics.push(entry)}) : case04ScriptedAssessor;
    const config = {observer:false, assessment:options.model ? 'llm' : 'scripted', provider:options.model?.provider ?? (options.model ? 'openai' : null), model:options.model?.model ?? (options.model ? 'gpt-4.1-mini' : null)};
    const root = new URL('../../../', import.meta.url);
    const history = JSON.parse(readFileSync(new URL('snapshots/2026-11-19/history.json', root), 'utf8')).cases as HistoryCase[];
    const events = buildCase04Replay(history);
    const directory = mkdtempSync(join(tmpdir(), 'dwelly-demo-'));
    let generation = 0;
    let store = new Store({ path: join(directory, '0.sqlite'), session: 'interview-demo' });
    let world = new ReplayWorldClient({ history });
    const graph = () => new Graph({ store, world, assess, precedents: history, reviewAfterMs: 86400000 });
    let position = 0;
    let busy = false;
    let notice = 'Ready. Deliver the first archived tenant message to begin.';
    const snapshot = () => ({ mode: options.model ? 'Real LLM assessment · simulated Dwelly API' : 'Scripted assessment · simulated Dwelly API', assessment:config.assessment, model:config.model, diagnostics, position, total: events.length, busy, notice, transitions,
        messages: events.slice(0, position), nextMessage: events[position] ?? null,
        issues: store.issues(), traces: store.traces(), intents: store.intents(), writes: world.writes, cursor: store.cursor() });
    const assets: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const server = createServer(async (req, res) => {
        const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
        if (!hosts.includes(req.headers.host ?? '')) { reply(403, { error: 'Local requests only' }); return; }
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        try {
            if (req.method === 'GET' && assets[path]) {
                const [file, type] = assets[path];
                res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(readFileSync(new URL('web/demo/' + file, root))); return;
            }
            if (req.method === 'GET' && path === '/api/config') { reply(200, config); return; }
            if (req.method === 'GET' && path === '/api/state') { reply(200, snapshot()); return; }
            if (req.method !== 'POST' || !['/api/step', '/api/duplicate', '/api/reset'].includes(path)) { reply(404, { error: 'Unknown route' }); return; }
            if (!hosts.some(host => req.headers.origin === `http://${host}`)) { reply(403, { error: 'Same-origin request required' }); return; }
            if (busy) { reply(409, { error: 'An event is already processing' }); return; }
            busy = true;
            try {
                if (path === '/api/reset') {
                    store.close();
                    store = new Store({ path: join(directory, `${++generation}.sqlite`), session: 'interview-demo' });
                    world = new ReplayWorldClient({ history }); position = 0; diagnostics.length = 0;
                    notice = 'Demo reset. Existing live and CLI databases are untouched.';
                } else if (path === '/api/step') {
                    const event = events[position];
                    if (!event) { reply(409, { error: 'All archived demo messages have been delivered' }); return; }
                    await graph().processEvent(event); position++;
                    notice = 'Message processed through the existing graph. Select a trace entry to inspect its evidence.';
                } else {
                    const event = events[position - 1];
                    if (!event) { reply(409, { error: 'Deliver a message first' }); return; }
                    const count = world.writes.length;
                    await graph().processEvent(event);
                    notice = `Same event ID delivered again: ${world.writes.length - count} additional API writes. Existing case and action records retained.`;
                }
            } finally { busy = false; }
            reply(200, snapshot());
        } catch { reply(500, { error: 'Demo request failed. Restart the demo to recover.' }); }
    });
    server.on('close', () => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
    const llm = process.argv.includes('--llm');
    const server = createDemoServer(llm ? {model:modelConfiguration()} : {});
    server.on('error', error => { console.error(error.message); server.close(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Interview demo: http://localhost:${port} — ${llm ? 'real LLM assessor (paid calls)' : 'scripted assessor'}; Dwelly API simulated.`));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
