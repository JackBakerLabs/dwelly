import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelAssessor,PROMPT_VERSION,type AssessmentDiagnostic} from '../src/triage/index.js';
import {POLICY_METADATA} from '../src/triage/policy.js';
import type {Issue} from '../src/types.js';
test('active prompt and diagnostics attribute approved policy to user, never Dwelly',async()=>{
 const issue:Issue={id:'local',session:'s',actorId:'tenant',status:'active',evidence:[{eventId:'e',cursor:1,actor:{id:'tenant',role:'tenant',name:'Tenant'},body:'Tap drips',occurredAt:'2026-11-19T00:00:00Z'}]};
 const diagnostics:AssessmentDiagnostic[]=[];
 const assess=createModelAssessor({apiKey:'mock',onDiagnostic:d=>diagnostics.push(d),fetch:async(_url,init)=>{
 const prompt=JSON.parse(String(init?.body)).messages[0].content as string;
 assert.match(prompt,/user's approved experimental decision policy/);assert.match(prompt,/NOT an official Dwelly policy/);assert.match(prompt,/continuously dripping tap is medium/);assert.match(prompt,/Unreported danger is unknown/);
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decision:{kind:'open',title:'Dripping tap',description:null,urgency:'medium',humanAction:null,evidenceIds:['e'],reason:'Routine defect'}})}}]}));
 }});
 assert.equal((await assess(issue,issue.evidence,[])).kind,'open');assert.equal(diagnostics[0]?.promptVersion,PROMPT_VERSION);assert.deepEqual(diagnostics[0]?.policy,POLICY_METADATA);assert.equal(POLICY_METADATA.officialDwellyPolicy,false);
});
