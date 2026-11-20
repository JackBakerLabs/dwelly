import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDemoServer } from '../src/demo/server.js';

test('interview HTTP adapter uses real graph, updates one case, deduplicates and resets only its demo', async () => {
    const server = createDemoServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const post = async (path: string) => {
        const response = await fetch(base + path, { method: 'POST', headers: { Origin: base } });
        assert.equal(response.status, 200);
        return response.json();
    };
    try {
        const page = await fetch(base);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /Scripted assessment/);
        assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
        const initial = await (await fetch(base + '/api/state')).json();
        assert.equal(initial.writes.length, 0);
        assert.equal((await fetch(base + '/api/reset', { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
        assert.equal((await fetch(base + '/api/reset', { method: 'POST' })).status, 403);
        assert.equal((await fetch(base + '/api/duplicate', { method: 'POST', headers: { Origin: base } })).status, 409);
        const first = await post('/api/step');
        assert.equal(first.issues[0].urgency, 'medium');
        assert.equal(first.writes[0].operation, 'createCase');
        const duplicate = await post('/api/duplicate');
        assert.deepEqual(duplicate.writes, first.writes);
        assert.deepEqual(duplicate.traces, first.traces);
        assert.match(duplicate.notice, /0 additional API writes/);
        let final = first;
        while (final.position < final.total) final = await post('/api/step');
        assert.equal(final.issues.length, 1);
        assert.equal(final.issues[0].remoteCase.id, first.issues[0].remoteCase.id);
        assert.equal(final.issues[0].urgency, 'high');
        assert.deepEqual(final.writes.map((w: {operation:string}) => w.operation), ['createCase', 'patchCase']);
        assert.ok(final.traces.some((t: {node:string}) => t.node === 'Validate'));
        assert.equal((await fetch(base + '/api/step', { method: 'POST', headers: { Origin: base } })).status, 409);
        const reset = await post('/api/reset');
        assert.equal(reset.position, 0); assert.equal(reset.issues.length, 0); assert.equal(reset.traces.length, 0); assert.equal(reset.writes.length, 0);
    } finally { server.close(); await once(server, 'close'); }
});

test('LLM demo uses structured model assessment, blocks concurrent mutations and does not call again for duplicates', async () => {
    let calls=0;
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const modelFetch:typeof fetch=async(_url,init)=>{
        calls++;
        const request=JSON.parse(String(init?.body));
        assert.equal(request.response_format.type,'json_schema');
        const context=JSON.parse(request.messages[1].content);
        await gate;
        return new Response(JSON.stringify({model:'test-model',usage:{total_tokens:123},choices:[{message:{content:JSON.stringify({decision:{kind:'open',scope:'maintenance',title:'Model-selected pipe repair',description:null,urgency:'medium',evidenceIds:[context.currentObservations[0].eventId],reason:'Model proposal validated by the application',humanAction:null}})}}]}));
    };
    const server=createDemoServer({model:{apiKey:'private-test-key',provider:'openrouter',model:'test-model',fetch:modelFetch}});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
    try {
        const config=await(await fetch(base+'/api/config')).json();assert.equal(config.assessment,'llm');assert.equal(JSON.stringify(config).includes('private-test-key'),false);
        const processing=fetch(base+'/api/step',{method:'POST',headers:{Origin:base}});
        for(let i=0;i<100&&calls===0;i++)await new Promise(resolve=>setTimeout(resolve,5));
        assert.equal(calls,1);
        assert.equal((await(await fetch(base+'/api/state')).json()).busy,true);
        assert.equal((await fetch(base+'/api/reset',{method:'POST',headers:{Origin:base}})).status,409);
        release();const response=await processing;assert.equal(response.status,200);const result=await response.json();
        assert.equal(result.issues[0].remoteCase.title,'Model-selected pipe repair');assert.equal(result.diagnostics[0].stage,'accepted');assert.equal(result.diagnostics[0].usage.total_tokens,123);
        assert.equal(JSON.stringify(result).includes('private-test-key'),false);
        const duplicate=await(await fetch(base+'/api/duplicate',{method:'POST',headers:{Origin:base}})).json();assert.equal(calls,1);assert.equal(duplicate.writes.length,1);
    } finally {release();server.close();await once(server,'close');}
});

test('LLM demo provider failure goes to review without scripted fallback or API writes',async()=>{
    const server=createDemoServer({model:{apiKey:'private-test-key',provider:'openrouter',model:'test-model',fetch:async()=>new Response('',{status:401})}});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
    try {
        const response=await fetch(base+'/api/step',{method:'POST',headers:{Origin:base}});const result=await response.json();
        assert.equal(result.issues[0].status,'review');assert.equal(result.writes.length,0);assert.equal(result.diagnostics[0].status,401);
    } finally {server.close();await once(server,'close');}
});
