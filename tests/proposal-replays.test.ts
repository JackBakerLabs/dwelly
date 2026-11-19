import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {bindProposal} from '../src/triage/proposal-v2.js';
import {replayDecision} from '../src/evaluation/graph-replay.js';
import type {HistoryCase,Issue} from '../src/types.js';
import type {EvaluationFixture} from '../src/triage/index.js';
const archive=JSON.parse(readFileSync('snapshots/2026-11-19/history.json','utf8')).cases as HistoryCase[];
const fresh=JSON.parse(readFileSync('fixtures/assessment-v2-fresh.json','utf8')) as EvaluationFixture[];
const synthetic:HistoryCase[]=fresh.map(f=>({...archive[0]!,id:f.id,messages:[{from:'tenant',name:f.tenantName,body:f.body,sent_at:f.occurredAt}]}));
for(const directory of ['docs/diagnostics/triage-v2-2026-11-19T16-17-30.003Z','docs/diagnostics/fresh-v2-2026-11-19T16-19-42.715Z']){
 for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')&&!f.startsWith('saved'))){
  const report=JSON.parse(readFileSync(directory+'/'+file,'utf8'));
  for(const row of report.evaluation.results){
   test(`v2 captured ${report.model} ${row.caseId}: schema/binding and graph remain compatible`,async()=>{
    const history=row.caseId.startsWith('fresh')?synthetic:archive;
    const m=history.find(c=>c.id===row.caseId)!.messages.find(m=>m.from==='tenant')!;
    const issue:Issue={id:'eval-'+row.caseId,session:'test',actorId:'eval-tenant',status:'active',evidence:[{eventId:row.eventIds[0],cursor:1,actor:{id:'eval-tenant',role:'tenant',name:m.name},body:m.body,occurredAt:m.sent_at}]};
    const diagnostic=report.diagnostics.find((d:any)=>d.stage==='accepted'&&d.eventIds.includes(row.eventIds[0]));
    assert.ok(diagnostic,'Captured response must have passed binding');const raw=JSON.parse(diagnostic.responseText);
    assert.deepEqual(bindProposal(issue,raw),row.decision);
    const replay=await replayDecision(history,row.caseId,raw,true,true,true);assert.equal(replay.passed,true,JSON.stringify(replay));
   });
  }
 }
}
