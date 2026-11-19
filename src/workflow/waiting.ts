import type {Issue,ResumeTrigger,WorldEvent} from '../types.js';
import type {Store} from '../store/index.js';
export const WAIT_REVIEW_PREFIX='Waiting review:';
export function startWaiting(issue:Issue,event:WorldEvent,trigger:ResumeTrigger,now:number,interval?:number){
 issue.waiting={priorHumanAction:issue.humanAction,trigger,originEventId:event.id,startedAt:now,state:interval===undefined?'needsSchedule':'pending',...(interval!==undefined?{reviewAt:now+interval}:{}),...(trigger.kind==='tenantReply'?{actorId:issue.actorId}:{})};
 if(interval===undefined)issue.humanAction=WAIT_REVIEW_PREFIX+' configure a review interval or review this item; no automatic deadline is assumed';
}
export function expireWaiting(store:Store,now:number){
 for(const issue of store.issues()){
  const wait=issue.waiting;
  if(!wait||wait.state!=='pending'||wait.reviewAt===undefined||wait.reviewAt>now||!['waiting','awaitingReply'].includes(issue.status))continue;
  store.transaction(()=>{wait.state='expired';issue.status='review';issue.humanAction=WAIT_REVIEW_PREFIX+' deadline reached; no remote action taken';store.putIssue(issue);const event=store.event(wait.originEventId);store.trace({session:store.session,eventId:wait.originEventId,cursor:event?.cursor??store.cursor(),issueId:issue.id,node:'Checkpoint',edge:'waiting-review-due',evidenceIds:issue.evidence.map(e=>e.eventId),reason:issue.humanAction!});});
 }
}
export function clearWaiting(issue:Issue){const previous=issue.waiting?.priorHumanAction;delete issue.waiting;if(issue.humanAction?.startsWith(WAIT_REVIEW_PREFIX)){if(previous)issue.humanAction=previous;else delete issue.humanAction;}}
export function acknowledgeWaitingReview(store:Store,id:string){
 const issue=store.issue(id);if(!issue?.waiting||!issue.humanAction?.startsWith(WAIT_REVIEW_PREFIX))throw new Error('Only a waiting-specific review can be acknowledged');
 if(store.intents().some(i=>i.issueId===id&&['uncertain','queued','inflight','deferred'].includes(i.state)))throw new Error('Unresolved effects block review acknowledgement');
 store.transaction(()=>{const origin=issue.waiting!.originEventId;clearWaiting(issue);issue.status='active';store.putIssue(issue);store.trace({session:store.session,eventId:origin,cursor:store.event(origin)?.cursor??store.cursor(),issueId:id,node:'Checkpoint',edge:'waiting-review-acknowledged',evidenceIds:issue.evidence.map(e=>e.eventId),reason:'Operator acknowledged wait; no remote write or model reassessment. Next linked material evidence resumes assessment.'});});
 return store.inspect(id);
}
