import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../store/index.js';
import {Graph} from '../graph/index.js';
import {ReplayWorldClient} from '../world/index.js';
import type {HistoryCase,Decision,WorldEvent} from '../types.js';

/** Inject the exact captured decision: no model calls and no repair of malformed output. */
export async function replayDecision(history:HistoryCase[],caseId:string,decision:unknown,expectValid=true) {
 const c=history.find(c=>c.id===caseId)!;const m=c.messages.find(m=>m.from==='tenant')!;
 const event:WorldEvent={id:caseId+'-initial',cursor:1,type:'message.received',channel:'email',actor:{id:'eval-tenant',name:m.name,role:'tenant'},sim_ms:0,occurred_at:m.sent_at,payload:{body:m.body,conversation_id:caseId}};
 const dir=mkdtempSync(join(tmpdir(),'dwelly-model-replay-'));const path=join(dir,'state.sqlite');
 let store=new Store({path,session:'model-replay'});const world=new ReplayWorldClient();let calls=0;
 const assess=async()=>{calls++;return decision as Decision;};
 try {
  await new Graph({store,world,assess}).processEvent(event);
  const issue=store.issues()[0]!;assert.ok(issue);assert.equal(store.status(event.id),'done');
  if(!expectValid){assert.equal(world.writes.length,0);assert.equal(issue.status,'review');}
  else {const d=decision as Decision;
   if(d.kind==='open'){assert.equal(world.writes.length,1);assert.equal(world.writes[0]!.operation,'createCase');assert.deepEqual(world.writes[0]!.input,{title:d.title,urgency:d.urgency,...(d.description?{description:d.description}:{})});assert.equal(issue.remoteCase!.id,world.writes[0]!.id);assert.equal(issue.urgency,d.urgency);}
   else if(d.kind==='ask'){assert.equal(world.writes.length,1);assert.equal(world.writes[0]!.operation,'sendMessage');assert.equal(issue.outstandingQuestion,d.question);assert.equal(issue.status,'awaitingReply');}
   else {assert.equal(world.writes.length,0);assert.equal(issue.status,d.kind==='wait'?'waiting':d.kind);}
   assert.equal(issue.humanAction,d.humanAction);
  }
  const before=JSON.stringify(store.inspect(issue.id));const writes=world.writes.length;
  store.close();store=new Store({path,session:'model-replay'});
  await new Graph({store,world,assess}).processEvent(event);
  assert.equal(calls,1);assert.equal(world.writes.length,writes);assert.equal(JSON.stringify(store.inspect(issue.id)),before);
  return {caseId,passed:true,expectedValidation:expectValid?'accept':'reject',writes:world.writes,inspection:store.inspect(issue.id),restartDuplicatePassed:true};
 } catch(error){return {caseId,passed:false,error:error instanceof Error?error.message:String(error),writes:world.writes,trace:store.traces()};}
 finally {store.close();rmSync(dir,{recursive:true,force:true});}
}
