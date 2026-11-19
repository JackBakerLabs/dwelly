import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createModelAssessor, type AssessmentDiagnostic } from '../triage/index.js';
import { runConversations } from './conversations.js';
import type { HistoryCase } from '../types.js';
export async function measureConversations(apiKey:string,models:string[],repeats=2){
 const history=JSON.parse(readFileSync(resolve('snapshots/2026-11-19/history.json'),'utf8')).cases as HistoryCase[];
 const directory=resolve('docs/diagnostics/conversations-v4-'+new Date().toISOString().replaceAll(':','-'));mkdirSync(directory,{recursive:true});
 for(const model of models){
  const diagnostics:AssessmentDiagnostic[]=[];
  const report=await runConversations(history,createModelAssessor({apiKey,provider:'openrouter',model,onDiagnostic:d=>diagnostics.push(d)}),repeats);
  writeFileSync(resolve(directory,model.replaceAll('/','_')+'.json'),JSON.stringify({model,...report,diagnostics},null,2)+'\n');
  console.log(JSON.stringify({directory,model,...report.summary}));
 }
 return directory;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error('OPENROUTER_API_KEY is required');
 const model=process.argv[2];if(!model)throw new Error('Provide an explicit OpenRouter model ID');
 await measureConversations(key,[model],Number(process.argv[3]??2));
}
