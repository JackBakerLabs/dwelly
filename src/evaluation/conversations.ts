import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/index.js';
import { Graph } from '../graph/index.js';
import { ReplayWorldClient } from '../world/index.js';
import { assessmentFailure } from '../triage/index.js';
import type { Assessor, Decision, HistoryCase, MaintenanceScope, Urgency, WorldEvent } from '../types.js';

interface Turn { variants: [string,string]; scope: MaintenanceScope; urgency?: Urgency; actions: Decision['kind'][] }
// Frozen synthetic regression labels, authored before the first v4 run. Never sent to the model.
export const conversations: {id:string; turns:Turn[]}[] = [
 {id:'leak-escalation',turns:[
  {variants:['Something is wrong in the kitchen. Can you help?','There is a problem in my kitchen but I cannot describe it yet.'],scope:'unknown',actions:['ask']},
  {variants:['The cold water pipe under the kitchen sink drips slowly. A bucket catches all the water. No damage, electrics or loss of water supply.','It is a slow drip from the cold supply pipe below the sink, fully caught in a bowl. Water works, nothing is damaged and no electrics are nearby.'],scope:'maintenance',urgency:'medium',actions:['open']},
  {variants:['The leak is now pouring and the ceiling in the flat below is getting soaked. No electrics are affected and there is no immediate danger to people.','Update: water is running continuously and damaging the downstairs flat ceiling. No electrical involvement or immediate danger to anyone.'],scope:'maintenance',urgency:'high',actions:['update']}
 ]},
 {id:'scope-correction',turns:[
  {variants:['My neighbour plays loud music at night. Nothing in the flat is broken.','Noise complaint: next door has late parties. There is no physical defect in my home.'],scope:'nonMaintenance',urgency:'low',actions:['outOfScope']},
  {variants:['Correction: I also have a separate repair in this flat. The kitchen tap drips continuously into the sink. No flooding, damage, electrics or loss of supply.','I need to correct my report: the actual repair is a continuously dripping kitchen tap, safely draining into the sink. No damage or supply loss.'],scope:'maintenance',urgency:'medium',actions:['open']}
 ]},
 {id:'cosmetic',turns:[{variants:['There is a small stable scratch in the hallway paint. No damp, sharp edges, loose material or other damage. Please record it for a future touch-up.','A tiny scuff on the hall wall paint has not changed. It is dry, safe and only cosmetic. Please log a future touch-up.'],scope:'maintenance',urgency:'low',actions:['open']}]}
];

export async function runConversations(history:HistoryCase[], assessor:Assessor, repeats=2) {
 if(!Number.isSafeInteger(repeats)||repeats<1||repeats>3)throw new Error('repeats must be 1–3');
 const rows=[];
 for(const fixture of conversations)for(let variant=0;variant<2;variant++)for(let repeat=0;repeat<repeats;repeat++){
  const dir=mkdtempSync(join(tmpdir(),'dwelly-conversation-'));const path=join(dir,'state.sqlite');
  let store=new Store({path,session:'benchmark'});const world=new ReplayWorldClient({history});let calls=0;let decision:Decision|undefined;
  const assess:Assessor=async(...args)=>{calls++;decision=await assessor(...args);return decision;};
  try{for(const [index,turn] of fixture.turns.entries()){
   decision=undefined;const event:WorldEvent={id:`${fixture.id}-${index}`,cursor:index+1,type:'message.received',channel:'email',actor:{id:'tenant',name:'Synthetic tenant',role:'tenant'},sim_ms:index*1000,occurred_at:'2026-11-19T00:00:00Z',payload:{body:turn.variants[variant],conversation_id:fixture.id}};
   const before=world.writes.length;const start=Date.now();
   await new Graph({store,world,assess,precedents:history,reviewAfterMs:86400000,now:()=>1000}).processEvent(event);
   const elapsedMs=Date.now()-start;const actual=decision as Decision|undefined;const issue=store.issues()[0];
   const newWrites=world.writes.slice(before);const operation=actual?.kind==='open'?'createCase':actual?.kind==='ask'?'sendMessage':actual?.kind==='update'?'patchCase':undefined;
   const expectedInput=actual?.kind==='open'?{title:actual.title,urgency:actual.urgency,...(actual.description?{description:actual.description}:{})}:actual?.kind==='update'?actual.patch:actual?.kind==='ask'?{body:actual.question}:undefined;
   const expectedId=actual?.kind==='update'?actual.caseId:actual?.kind==='ask'?actual.actorId:issue?.remoteCase?.id;
   const executionPassed=!!actual&&newWrites.length===(operation?1:0)&&(!operation||(newWrites[0]?.operation===operation&&isDeepStrictEqual(newWrites[0]?.input,expectedInput)&&newWrites[0]?.id===expectedId));
   const beforeDuplicate=JSON.stringify(store.inspect(issue!.id));const callCount=calls;const writeCount=world.writes.length;
   store.close();store=new Store({path,session:'benchmark'});
   await new Graph({store,world,assess,precedents:history,reviewAfterMs:86400000,now:()=>1000}).processEvent(event);
   const restartDuplicatePassed=calls===callCount&&world.writes.length===writeCount&&JSON.stringify(store.inspect(issue!.id))===beforeDuplicate;
   rows.push({fixture:fixture.id,variant,repeat,turn:index,expected:{scope:turn.scope,urgency:turn.urgency,actions:turn.actions},decision:actual,scopePassed:actual?.scope===turn.scope,urgencyPassed:turn.urgency===undefined?null:issue?.urgency===turn.urgency,actionPassed:!!actual&&turn.actions.includes(actual.kind),failure:actual?assessmentFailure(actual):'graph-no-assessment',executionPassed,restartDuplicatePassed,elapsedMs,writes:newWrites});
  }}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 }
 return {fixtureVersion:'conversations-v1',limitation:'Synthetic regression cases, not independent expert-labelled accuracy. Actual decisions run through a fake World API; no live Dwelly writes.',repeats,rows,summary:{turns:rows.length,scopePassed:rows.filter(r=>r.scopePassed).length,urgencyScored:rows.filter(r=>r.urgencyPassed!==null).length,urgencyPassed:rows.filter(r=>r.urgencyPassed===true).length,actionPassed:rows.filter(r=>r.actionPassed).length,failures:rows.filter(r=>r.failure).length,executionPassed:rows.filter(r=>r.executionPassed).length,restartDuplicatePassed:rows.filter(r=>r.restartDuplicatePassed).length}};
}
