import test from 'node:test';
import assert from 'node:assert/strict';
import { runConversations } from '../src/evaluation/conversations.js';
test('fixed conversations exercise correction, escalation, restart and duplicate delivery',async()=>{
 const result=await runConversations([],async issue=>{
  const ids=issue.evidence.map(e=>e.eventId);const base={evidenceIds:ids,reason:'Scripted harness verification'};
  if(issue.conversationId==='cosmetic')return {...base,scope:'maintenance',kind:'open',title:'Scuff',urgency:'low'};
  if(issue.conversationId==='demo-undertriage-2026-11-20')return {...base,scope:'maintenance',kind:'open',title:'Sink leak',urgency:'medium'};
  if(issue.conversationId==='scope-correction'&&ids.length===1)return {...base,scope:'nonMaintenance',kind:'outOfScope',urgency:'low'};
  if(issue.conversationId==='leak-escalation'&&ids.length===1)return {...base,scope:'unknown',kind:'ask',actorId:issue.actorId,question:'Describe the problem?'};
  if(issue.remoteCase)return {...base,scope:'maintenance',kind:'update',caseId:issue.remoteCase.id,patch:{urgency:'high'}};
  return {...base,scope:'maintenance',kind:'open',title:'Leak',urgency:'medium'};
 },1);
 assert.equal(result.summary.turns,14);
 assert.equal(result.summary.scopePassed,14);assert.equal(result.summary.actionPassed,14);
 assert.equal(result.summary.urgencyPassed,12);assert.equal(result.summary.executionPassed,14);assert.equal(result.summary.restartDuplicatePassed,14);
});
