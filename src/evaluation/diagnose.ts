import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createModelAssessor,runEvaluation,PROMPT_VERSION,type AssessmentDiagnostic} from '../triage/index.js';
import {replayDecision} from './graph-replay.js';
import type {HistoryCase} from '../types.js';
export async function diagnose(models:string[],apiKey?:string) {
 const history=JSON.parse(readFileSync('snapshots/2026-11-19/history.json','utf8')).cases as HistoryCase[];
 const outputDir='docs/diagnostics/'+PROMPT_VERSION+'-'+new Date().toISOString().replaceAll(':','-');
 mkdirSync(outputDir,{recursive:true});
 const saved=[];
 for(const file of readdirSync('docs').filter(f=>/^eval-.*\.json$/.test(f)||f==='deepseek-evaluation.json')){
  const report=JSON.parse(readFileSync('docs/'+file,'utf8'));
  for(const row of report.results){if(!row.decision||row.failure)continue;saved.push({source:file,judgmentPassed:row.passed,...await replayDecision(history,row.caseId,row.decision)});}
 }
 writeFileSync(outputDir+'/saved-decision-replays.json',JSON.stringify(saved,null,2)+'\n');
 console.log(JSON.stringify({savedReplays:saved.length,passed:saved.filter(r=>r.passed).length}));
 if(models.length&&!apiKey)throw new Error('OPENROUTER_API_KEY required');
 await Promise.all(models.map(async model=>{
  const diagnostics:AssessmentDiagnostic[]=[];
  const evaluation=await runEvaluation(history,createModelAssessor({apiKey:apiKey!,provider:'openrouter',model,onDiagnostic:d=>diagnostics.push(d)}));
  const rows=[];
  for(const row of evaluation.results){
   const attempts=diagnostics.filter(d=>d.eventIds.includes(row.eventIds[0]!));const last=attempts.at(-1);
   const category=row.failureCategory??(row.passed?'pass':'judgment');
   const graph=await replayDecision(history,row.caseId,row.decision);
   const rejected=[];
   for(const d of attempts.filter(d=>d.stage==='validation'&&d.responseText)){rejected.push(await replayDecision(history,row.caseId,JSON.parse(d.responseText!),false,true));}
   rows.push({...row,category,graph,rejected});
  }
  const report={model,promptVersion:PROMPT_VERSION,evaluation,diagnostics,rows};
  writeFileSync(outputDir+'/'+model.replaceAll('/','-')+'.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({model,outputDir,providerFailures:evaluation.providerFailures,contractFailures:evaluation.contractFailures,underTriage:evaluation.underTriage,passed:evaluation.passed,rows:rows.map(r=>({caseId:r.caseId,category:r.category,graph:r.graph.passed,rejected:r.rejected.map(x=>x.passed)})),errors:diagnostics.filter(d=>d.stage!=='accepted').map(d=>({eventIds:d.eventIds,stage:d.stage,error:d.error}))}));
 }));
}
