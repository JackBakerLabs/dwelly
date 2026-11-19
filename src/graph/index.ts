import { randomUUID } from 'node:crypto';
import type { Assessor, Decision, EventBatch, HistoryCase, Issue, RemoteCase, TraceEntry, WorldClient, WorldEvent } from '../types.js';
import { Store, type Intent } from '../store/index.js';
import { decodeEvent, WorldError } from '../world/index.js';
import { validateDecision } from '../triage/index.js';
export interface GraphDependencies { store:Store;world:WorldClient;assess:Assessor;precedents?:HistoryCase[] }
export const transitions={Ingest:['Route'],Route:['Assess','Checkpoint'],Assess:['Validate'],Validate:['Act','Checkpoint'],Act:['Checkpoint'],Checkpoint:[]} as const;
export class Graph {
 private running=false;
 constructor(readonly dependencies:GraphDependencies){}
 ingest(batch:EventBatch){this.dependencies.store.ingest(batch);}
 async pollOnce(){await this.drain();const batch=await this.dependencies.world.poll(this.dependencies.store.cursor());this.ingest(batch);await this.drain();return batch;}
 async drain(){if(this.running)throw new Error('One graph worker per session');this.running=true;try{for(const event of this.dependencies.store.pending())await this.runEvent(event);}finally{this.running=false;}}
 async processEvent(event:WorldEvent){this.ingest({events:[event],next_cursor:Math.max(this.dependencies.store.cursor(),event.cursor)});await this.drain();}
 private trace(event:WorldEvent,node:TraceEntry['node'],edge:string,reason:string,issue?:Issue,outcome?:unknown){this.dependencies.store.trace({session:this.dependencies.store.session,eventId:event.id,cursor:event.cursor,issueId:issue?.id,remoteId:issue?.remoteCase?.id,node,edge,evidenceIds:issue?.evidence.map(e=>e.eventId)??[],reason,outcome});}
 private complete(event:WorldEvent,issue:Issue|undefined,reason:string){const s=this.dependencies.store;s.transaction(()=>{if(issue)s.putIssue(issue);this.trace(event,'Checkpoint','done',reason,issue);s.finish(event.id);});}
 private async runEvent(event:WorldEvent){
  const {store:s,assess,precedents=[]}=this.dependencies;if(s.status(event.id)==='done')return;
  const previous=s.intents().find(i=>i.eventId===event.id);
  if(previous){if(previous.state==='queued'||previous.state==='deferred'){if((previous.retryAt??0)>Date.now())return;const issue=s.issue(previous.issueId);if(issue)await this.dispatch(event,issue,previous);}else if(previous.state==='uncertain'||previous.state==='failed'||previous.state==='confirmed')s.finish(event.id);return;}
  this.trace(event,'Ingest','Route','Durable event loaded');const decoded=decodeEvent(event);
  if(decoded.kind!=='message'||!decoded.body?.trim()||!event.actor){this.trace(event,'Route',decoded.kind==='unknown'?'review':'ignore','Unknown envelope/payload or system echo: no mutation');this.complete(event,undefined,'Retained original event for inspection');return;}
  if(/^(?:thanks?|thank you|ok(?:ay)?|cheers|got it|understood)[!.\s]*$/i.test(decoded.body.trim())){this.trace(event,'Route','ignore','Acknowledgement adds no facts');this.complete(event,undefined,'No new evidence');return;}
  const issues=s.issues();let candidates:Issue[]=[];let explicit=false;
  if(decoded.issueId){candidates=issues.filter(i=>i.id===decoded.issueId);explicit=true;}
  else if(decoded.caseId){candidates=issues.filter(i=>i.remoteCase?.id===decoded.caseId);explicit=true;}
  else if(decoded.replyToEventId){candidates=issues.filter(i=>i.evidence.some(e=>e.eventId===decoded.replyToEventId));explicit=true;}
  else if(decoded.conversationId&&!decoded.newIssue){candidates=issues.filter(i=>i.conversationId===decoded.conversationId);explicit=candidates.length>0;}
  else if(!decoded.newIssue){candidates=issues.filter(i=>i.actorId===event.actor!.id&&i.status==='awaitingReply'&&(!decoded.propertyId||i.propertyId===decoded.propertyId));}
  if(candidates.length>1||(explicit&&candidates.length!==1)){this.trace(event,'Route','review','Ambiguous or unknown explicit issue reference; held without writes');this.complete(event,undefined,'Routing review required');return;}
  let issue=candidates[0];
  if(!issue&&!explicit&&!decoded.newIssue&&!decoded.conversationId&&issues.some(i=>i.actorId===event.actor!.id)&&/^(?:it|that|this|yes|no|also|actually|still|now|the same|sorry|update)\b/i.test(decoded.body.trim())){this.trace(event,'Route','review','Possible reply without an unambiguous link; held without writes');this.complete(event,undefined,'Routing review required');return;}
  if(!issue){if(event.actor.role!=='tenant'){this.trace(event,'Route','review','Unlinked non-tenant message');this.complete(event,undefined,'Routing review required');return;}issue={id:'issue-'+randomUUID(),session:s.session,actorId:event.actor.id,propertyId:decoded.propertyId,conversationId:decoded.conversationId,status:'active',evidence:[]};}
  if(decoded.supersedes&&!issue.evidence.some(e=>e.eventId===decoded.supersedes&&e.cursor<event.cursor)){issue.status='review';issue.humanAction='Correction references missing or foreign evidence';this.trace(event,'Route','review',issue.humanAction,issue);this.complete(event,issue,issue.humanAction);return;}
  if(!issue.evidence.some(e=>e.eventId===event.id))issue.evidence.push({eventId:event.id,cursor:event.cursor,actor:event.actor,body:decoded.body,occurredAt:event.occurred_at,...(decoded.supersedes?{supersedes:decoded.supersedes}:{})});
  s.putIssue(issue);this.trace(event,'Route','Assess','Material observation linked',issue);
  const blocked=s.intents().some(i=>i.issueId===issue!.id&&['uncertain','deferred','queued','inflight'].includes(i.state));
  if(issue.status==='review'||blocked){for(const prior of s.intents().filter(i=>i.issueId===issue!.id&&['queued','deferred'].includes(i.state))){prior.state='failed';prior.result={error:'New evidence arrived while write deferred; action cancelled for review'};s.transaction(()=>{s.putIntent(prior);s.finish(prior.eventId);});}issue.status='review';this.complete(event,issue,'Issue held for human review or unresolved prior action');return;}
  let decision:Decision;
  try{const candidate=await assess(issue,issue.evidence,precedents);this.trace(event,'Assess','Validate',candidate.reason??'Assess completed',issue);decision=validateDecision(issue,candidate);this.trace(event,'Validate','Act',decision.reason,issue,decision);}catch(error){issue.status='review';issue.humanAction='Assessment/validation failed: '+safeError(error);this.trace(event,'Validate','review',issue.humanAction,issue);this.complete(event,issue,'No write on invalid decision');return;}
  if(decision.humanAction)issue.humanAction=decision.humanAction;
  if(decision.kind==='wait'||decision.kind==='review'||decision.kind==='outOfScope'){issue.status=decision.kind==='wait'?'waiting':decision.kind;if(decision.urgency)issue.urgency=decision.urgency;this.complete(event,issue,decision.reason);return;}
  const intent:Intent={id:'action-'+randomUUID(),eventId:event.id,issueId:issue.id,decision,state:'queued',attempts:0};s.transaction(()=>{s.putIssue(issue!);s.putIntent(intent);});await this.dispatch(event,issue,intent);
 }
 private async dispatch(event:WorldEvent,issue:Issue,intent:Intent){
  const {store:s,world}=this.dependencies;const stop=s.meta('mutationsStopped');if(stop)throw new Error(stop);
  intent.state='inflight';intent.attempts++;s.putIntent(intent);this.trace(event,'Act','dispatch',intent.decision.reason,issue,{actionId:intent.id});const d=intent.decision;
  try {
   let result:unknown;
   switch(d.kind){case 'open':result=await world.createCase({title:d.title,urgency:d.urgency,...(d.description?{description:d.description}:{}),...(issue.propertyId?{property_id:issue.propertyId}:{})});issue.remoteCase=result as RemoteCase;issue.urgency=d.urgency;issue.status='active';delete issue.outstandingQuestion;break;
    case 'update':result=await world.patchCase(d.caseId,d.patch);issue.remoteCase=result as RemoteCase;issue.urgency=issue.remoteCase.urgency??issue.urgency;issue.status='active';delete issue.outstandingQuestion;break;
    case 'ask':result=await world.sendMessage(d.actorId,{body:d.question});issue.outstandingQuestion=d.question;issue.status='awaitingReply';break;
    default:throw new Error('Invalid action intent');}
   intent.state='confirmed';intent.result=result;s.transaction(()=>{s.putIntent(intent);s.putIssue(issue);this.trace(event,'Checkpoint','confirmed',d.reason,issue,result);s.finish(event.id);});
  }catch(error){
   const status=error instanceof WorldError?error.status:undefined;
   if(status===429&&intent.attempts<4){intent.state='deferred';intent.retryAt=Date.now()+Math.min(60000,Math.max(1000,(error as WorldError).retryAfterMs??1000*2**intent.attempts));intent.result={error:safeError(error)};s.putIntent(intent);this.trace(event,'Act','deferred','Confirmed rate limit: persisted bounded retry',issue);return;}
   intent.state=error instanceof WorldError&&!error.uncertain?'failed':'uncertain';intent.result={error:safeError(error),status,...(error instanceof WorldError?{details:error.details,hint:error.hint}:{})};issue.status='review';issue.humanAction=intent.state==='uncertain'?'Remote outcome uncertain; reconcile before retry':safeError(error);
   s.transaction(()=>{s.putIntent(intent);s.putIssue(issue);this.trace(event,'Checkpoint',intent.state,issue.humanAction!,issue,intent.result);s.finish(event.id);if(status===401||status===403)s.setMeta('mutationsStopped',status===401?'Authentication failed':'Session ended; mutations stopped');});if(status===401||status===403)throw error;
  }
 }
}
function safeError(error:unknown){return error instanceof Error?error.message:'Unknown failure';}
export async function processEvent(event:WorldEvent,dependencies:GraphDependencies){await new Graph(dependencies).processEvent(event);}
