import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/index.js';
import { Graph } from '../src/graph/index.js';
import { ReplayWorldClient } from '../src/world/index.js';
import { observerSnapshot, createObserverServer } from '../src/demo/observer.js';
import type { WorldEvent, Decision } from '../src/types.js';
const event:WorldEvent={id:'e1',cursor:1,type:'message.received',channel:'email',actor:{id:'tenant',name:'Tenant',role:'tenant'},sim_ms:0,occurred_at:'2026-11-20T10:00:00Z',payload:{body:'Kitchen pipe drips into a bucket',conversation_id:'one'}};
const decision:Decision={kind:'open',scope:'maintenance',title:'Pipe leak',urgency:'medium',evidenceIds:['e1'],reason:'Contained leak'};

test('observer sees in-progress graph and committed WAL changes without touching writer state',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dwelly-observe-test-')),path=join(dir,'state.sqlite');
 const store=new Store({path,session:'s'});const world=new ReplayWorldClient();
 let release!:(decision:Decision)=>void;
 const graph=new Graph({store,world,assess:async()=>new Promise<Decision>(resolve=>{release=resolve;})});
 try{
  const processing=graph.processEvent(event);
  const during=observerSnapshot(path,'s');
  assert.equal(during.pending,1);assert.equal(during.messages[0]!.processingStatus,'pending');assert.equal(during.writes.length,0);
  assert.equal(during.traces.at(-1)?.edge,'Assess');
  release(decision);await processing;
  const after=observerSnapshot(path,'s');assert.equal(after.pending,0);assert.equal(after.intents[0]!.state,'confirmed');assert.equal(after.issues[0]!.urgency,'medium');
  const intent=store.intents()[0]!;intent.state='inflight';store.putIntent(intent);
  assert.equal(observerSnapshot(path,'s').intents[0]!.state,'inflight');assert.equal(store.intents()[0]!.state,'inflight');assert.ok(existsSync(path+'.lock'));
  store.db.exec('BEGIN IMMEDIATE');store.setMeta('cursor','99');
  assert.equal(observerSnapshot(path,'s').cursor,1);store.db.exec('COMMIT');assert.equal(observerSnapshot(path,'s').cursor,99);
  assert.throws(()=>observerSnapshot(path,'wrong'),/session binding/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('observer HTTP stays read-only and recovers when a missing database becomes available',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dwelly-observe-http-')),path=join(dir,'later.sqlite');
 const server=createObserverServer({path,session:'s'});server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 let store:Store|undefined;
 try{
  assert.equal((await fetch(base)).status,200);
  assert.equal((await (await fetch(base+'/api/config')).json()).observer,true);
  assert.equal((await fetch(base+'/api/state')).status,503);assert.equal(existsSync(path),false);
  for(const route of ['reset','step','duplicate'])assert.equal((await fetch(base+'/api/'+route,{method:'POST',headers:{Origin:base}})).status,405);
  store=new Store({path,session:'s'});store.ingest({events:[event],next_cursor:1});
  const response=await fetch(base+'/api/state');assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.messages[0].id,'e1');assert.equal(body.pending,1);
  store.close();store=undefined;
  assert.equal((await fetch(base+'/api/state')).status,200); // Database readable is not a worker heartbeat.
 }finally{server.close();await once(server,'close');store?.close();rmSync(dir,{recursive:true,force:true});}
});
