import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store/index.js';
import { Coordinator, inspectCoordination } from './coordination/index.js';
import { Graph } from './graph/index.js';
import { LiveWorldClient, ReplayWorldClient } from './world/index.js';
import { buildCase04Replay, case04ScriptedAssessor, createModelAssessor, runEvaluation } from './triage/index.js';
import { diagnose } from './evaluation/diagnose.js';
import type { AssessmentDiagnostic } from './triage/index.js';
import { modelConfiguration } from './triage/config.js';
import type { HistoryCase } from './types.js';
const archive = (): HistoryCase[] => JSON.parse(readFileSync(new URL('../../snapshots/2026-11-19/history.json', import.meta.url), 'utf8')).cases as HistoryCase[];
function required(name: string): string {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing ${name}. See README.md for configuration.`);
    return value;
}
function dataPath(session: string): string { mkdirSync('.data', { recursive: true }); return resolve('.data', `${createHash('sha256').update(session).digest('hex').slice(0, 20)}.sqlite`); }
export async function main(args = process.argv.slice(2)): Promise<void> {
    const [command, arg] = args;
    if (command === 'replay') {
        if (arg !== 'case-04')
            throw new Error('Usage: npm run replay -- case-04');
        const history = archive();
        const session = `replay-case-04-${Date.now()}`;
        const path = process.env.DWELLY_DB ?? dataPath(session);
        const store = new Store({ path, session });
        try {
            const world = new ReplayWorldClient({ events: buildCase04Replay(history), history });
            const graph = new Graph({ store, world, assess: case04ScriptedAssessor, precedents: [] });
            await graph.pollOnce();
            console.log(JSON.stringify({ mode: 'offline scripted replay; not model evaluation', database: path, session, issues: store.issues(), writes: world.writes }, null, 2));
            for (const issue of store.issues())
                console.log(JSON.stringify(store.inspect(issue.id), null, 2));
            console.log(`Inspect: DWELLY_SESSION_ID=${session} DWELLY_DB=${path} npm run inspect -- ${store.issues()[0]?.id ?? '<issue-id>'}`);
        }
        finally {
            store.close();
        }
    }
    else if (command === 'inspect') {
        if (!arg)
            throw new Error('Usage: DWELLY_SESSION_ID=... DWELLY_DB=... npm run inspect -- <issue-id>');
        const session = required('DWELLY_SESSION_ID');
        const store = new Store({ path: process.env.DWELLY_DB ?? dataPath(session), session, readOnly: true });
        try {
            console.log(JSON.stringify(arg === '--review' ? store.reviewEvents() : { ...store.inspect(arg), coordination: inspectCoordination(store, arg) }, null, 2));
        }
        finally {
            store.close();
        }
    }
    else if (command === 'coordinate' || command === 'reconcile') {
        if (!arg || !args[2])
            throw new Error('Usage: npm run coordinate -- <issue-id> <trade> or npm run reconcile -- <action-id> <event-id>');
        const session = required('DWELLY_SESSION_ID');
        const token = required('DWELLY_TOKEN');
        const store = new Store({ path: process.env.DWELLY_DB ?? dataPath(session), session, identity: createHash('sha256').update(token).digest('hex') });
        try {
            if (command === 'reconcile')
                console.log(JSON.stringify(store.reconcileCase(arg, args[2]), null, 2));
            else {
                const world = new LiveWorldClient({ baseUrl: process.env.DWELLY_BASE_URL ?? 'https://167.172.96.156.sslip.io', token });
                const coordinator = new Coordinator({ store, world });
                await coordinator.start(arg, args[2]);
                console.log(JSON.stringify(coordinator.inspect(arg), null, 2));
            }
        }
        finally {
            store.close();
        }
    }
    else if (command === 'diagnose') {
        const models = args.slice(1).filter(a => a !== '--saved');
        await diagnose(models, models.length ? required('OPENROUTER_API_KEY') : undefined);
    }
    else if (command === 'eval' || command === 'eval-fresh') {
        const modelConfig = modelConfiguration();
        const diagnostics: AssessmentDiagnostic[] = [];
        const report = await runEvaluation(archive(), createModelAssessor({ ...modelConfig, onDiagnostic: d => diagnostics.push(d) }), command === 'eval-fresh' ? JSON.parse(readFileSync(new URL('../../fixtures/assessment-v2-fresh.json', import.meta.url), 'utf8')) : undefined);
        console.log(JSON.stringify({ ...report, provider: modelConfig.provider, model: modelConfig.model, diagnostics }, null, 2));
        if (report.passed !== report.total)
            process.exitCode = 1;
    }
    else if (command === 'live') {
        const token = required('DWELLY_TOKEN');
        const session = required('DWELLY_SESSION_ID');
        const modelConfig = modelConfiguration();
        const world = new LiveWorldClient({ baseUrl: process.env.DWELLY_BASE_URL ?? 'https://167.172.96.156.sslip.io', token });
        const store = new Store({ path: process.env.DWELLY_DB ?? dataPath(session), session, identity: createHash('sha256').update(token).digest('hex') });
        let stopped = false;
        const stop = () => { stopped = true; };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
            const precedents = await world.readHistory();
            const coordinator = new Coordinator({ store, world });
            await coordinator.drain();
            const graph = new Graph({ store, world, beforeEvent: event => coordinator.processEvent(event), assess: createModelAssessor(modelConfig), precedents });
            await graph.drain();
            console.log(`Live session ${session}; cursor ${store.cursor()}; Ctrl-C to stop.`);
            while (!stopped) {
                await graph.pollOnce();
                if (!stopped)
                    await delay(2000);
            }
        }
        finally {
            store.close();
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
        }
    }
    else {
        console.log('Dwelly maintenance agent\nCommands: replay case-04 | inspect <issue-id> | eval | live | coordinate <issue-id> <trade> | reconcile <action-id> <event-id>\nSee README.md for environment configuration.');
        if (command)
            process.exitCode = 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
