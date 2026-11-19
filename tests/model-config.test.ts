import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConfiguration} from '../src/triage/config.js';
test('provider selection keeps credentials isolated and requires an explicit OpenRouter model',()=>{
 assert.equal(modelConfiguration({OPENAI_API_KEY:'mock-openai'}).provider,'openai');
 assert.equal(modelConfiguration({OPENROUTER_API_KEY:'mock-router',OPENROUTER_MODEL:'org/model'}).provider,'openrouter');
 const both={OPENAI_API_KEY:'mock-openai',OPENROUTER_API_KEY:'mock-router',OPENROUTER_MODEL:'org/model'};
 assert.equal(modelConfiguration({...both,MODEL_PROVIDER:'openrouter'}).apiKey,'mock-router');
 assert.equal(modelConfiguration(both).apiKey,'mock-openai');
 assert.throws(()=>modelConfiguration({MODEL_PROVIDER:'openrouter',OPENAI_API_KEY:'mock-openai'}),/OPENROUTER_API_KEY/);
 assert.throws(()=>modelConfiguration({OPENROUTER_API_KEY:'mock-router'}),/OPENROUTER_MODEL/);
 assert.throws(()=>modelConfiguration({MODEL_PROVIDER:'unknown'}),/must be/);
});
