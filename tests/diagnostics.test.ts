import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createModelAssessor,type AssessmentDiagnostic} from '../src/triage/index.js';
import {replayDecision} from '../src/evaluation/graph-replay.js';
import type {HistoryCase,Issue} from '../src/types.js';
const issue:Issue={id:'test',session:'test',actorId:'tenant',status:'active',evidence:[{eventId:'e1',cursor:1,body:'Leaking pipe',actor:{id:'tenant',role:'tenant',name:'Tenant'},occurredAt:'2026-11-19T00:00:00Z'}]};
test('diagnostics preserve exact schema issues and both attempts without leaking credential or changing correction',async()=>{
 const entries:AssessmentDiagnostic[]=[];let calls=0;
 const assess=createModelAssessor({apiKey:'test-secret',onDiagnostic:d=>entries.push(d),fetch:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:{kind:'open',title:'Leak',urgency:'medium',reason:'test-secret',evidenceIds:['e1'],humanAction:null,description:null,extra:true}})}}]}));}});
 const decision=await assess(issue,issue.evidence,[]);
 assert.equal(decision.kind,'review');assert.equal(calls,2);assert.deepEqual(entries.map(e=>e.stage),['validation','validation']);
 assert.match(JSON.stringify(entries[0]!.issues),/unrecognized_keys/);assert.match(entries[0]!.error!,/extra/);
 assert.equal(JSON.stringify(entries).includes('test-secret'),false);assert.match(entries[0]!.responseText!,/REDACTED/);
});
test('transport diagnostics identify failure separately; a broken observer cannot affect assessment',async()=>{
 const entries:AssessmentDiagnostic[]=[];
 const assess=createModelAssessor({apiKey:'secret',onDiagnostic:d=>{entries.push(d);throw new Error('sink unavailable');},fetch:async()=>{throw new Error('timeout secret');}});
 assert.equal((await assess(issue,issue.evidence,[])).kind,'review');assert.equal(entries.length,1);assert.equal(entries[0]!.stage,'transport');assert.equal(entries[0]!.error,'timeout [REDACTED]');
});
const history=JSON.parse(readFileSync('snapshots/2026-11-19/history.json','utf8')).cases as HistoryCase[];
for(const file of readdirSync('docs').filter(f=>/^eval-.*\.json$/.test(f)||f==='deepseek-evaluation.json')){
 const report=JSON.parse(readFileSync('docs/'+file,'utf8'));
 for(const row of report.results){if(!row.decision||row.failure)continue;
  test(`captured ${report.model} ${row.caseId}: exact graph effects survive restart and duplicate delivery`,async()=>{const replay=await replayDecision(history,row.caseId,row.decision);assert.equal(replay.passed,true,JSON.stringify(replay));});
 }
}
test('malformed decision through graph results in review with zero writes',async()=>{
 const replay=await replayDecision(history,'case-02',{kind:'open',title:'Leak',urgency:'medium',reason:'Bad reference',evidenceIds:['invented']},false);assert.equal(replay.passed,true,JSON.stringify(replay));
});
