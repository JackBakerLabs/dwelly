import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import { buildCase04Replay, case04ScriptedAssessor } from '../src/triage/index.js';
import type { HistoryCase } from '../src/types.js';
test('real archive case04 replays across restart: one create, same-case high update, zero announcements',async()=>{
 const history=JSON.parse(readFileSync('snapshots/2026-11-19/history.json','utf8')).cases as HistoryCase[];
 const events=buildCase04Replay(history);const world=new ReplayWorldClient();
 const dir=mkdtempSync(join(tmpdir(),'dwelly-e2e-'));const path=join(dir,'state.sqlite');
 let store=new Store({path,session:'case04'});
 try {
  let graph=new Graph({store,world,assess:case04ScriptedAssessor});
  await graph.processEvent(events[0]!);const id=store.issues()[0]!.remoteCase!.id;
  assert.equal(store.issues()[0]!.urgency,'medium');
  assert.equal(store.issues()[0]!.evidence.length,1);
  store.close();store=new Store({path,session:'case04'});graph=new Graph({store,world,assess:case04ScriptedAssessor});
  for(const e of events.slice(1))await graph.processEvent(e);
  for(const e of events)await graph.processEvent(e);
  assert.equal(store.issues().length,1);assert.equal(store.issues()[0]!.remoteCase!.id,id);assert.equal(store.issues()[0]!.urgency,'high');
  assert.deepEqual(world.writes.map(w=>w.operation),['createCase','patchCase']);
  const traces=store.traces();assert.ok(traces.some(t=>t.node==='Validate'&&t.reason.includes('another flat')));
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
