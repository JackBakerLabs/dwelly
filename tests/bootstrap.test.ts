import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
test('pinned Node runtime supports transactional SQLite',()=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE checks(id TEXT PRIMARY KEY); BEGIN; INSERT INTO checks VALUES (\'a\'); ROLLBACK;');assert.equal((db.prepare('SELECT count(*) AS n FROM checks').get() as {n:number}).n,0);db.close();});
test('pinned API and archive have the expected version and 15 cases',()=>{const api=JSON.parse(readFileSync('snapshots/2026-11-19/openapi.json','utf8'));const archive=JSON.parse(readFileSync('snapshots/2026-11-19/history.json','utf8'));assert.equal(api.info.version,'1.0.0');assert.equal(archive.cases.length,15);});
