import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineRepository, type SqlDriver } from '../example/offlineRepository';
const origin = 'http://localhost:4001';
const records = JSON.stringify([{id:'workshop-launch', title:'Opening', tasks:[{id:'workshop-1',title:'Tools',notes:'',completed:false,version:3,attachments:[]}]}]);
const draft = { fields: {'task[id]':'workshop-1','task[version]':'3','task[title]':'Local draft','task[notes]':'Unsent','task[completed]':'false'}, sequence:4 };
function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  const driver: SqlDriver = { exec: sql => db.exec(sql), run: (sql,...params) => {db.prepare(sql).run(...params);}, first: <T,>(sql:string,...params:(string|number|null)[]) => (db.prepare(sql).get(...params) as T | undefined) ?? null };
  return { db, driver, repo:new OfflineRepository(driver,origin) };
}
test('real SQLite reopen restores confirmed cache and the original draft version', () => {
  const dir=mkdtempSync(join(tmpdir(),'lvn-offline-')); const file=join(dir,'cache.db');
  try {
    const first=open(file); first.repo.capture('workshop',records); first.repo.set('workshop:workshop-1',draft); first.db.close();
    const second=open(file); assert.equal(second.repo.getSnapshot().account,'workshop'); assert.equal(second.repo.getSnapshot().records[0].tasks[0].version,3);
    assert.deepEqual(second.repo.get('workshop:workshop-1'),draft); second.db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('logout blocks late writes and clears persisted data before restart', () => {
  const {db,driver,repo}=open(); repo.capture('workshop',records); repo.set('workshop:workshop-1',draft); repo.clear(); repo.set('workshop:workshop-1',draft);
  const fresh=new OfflineRepository(driver,origin); assert.equal(fresh.getSnapshot().account,null); assert.equal(fresh.get('workshop:workshop-1'),undefined);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM offline_drafts').get() as any).count,0); db.close();
});
test('account switch and origin switch clear private drafts and reject foreign keys', () => {
  const {db,repo}=open(); repo.capture('workshop',records); repo.set('workshop:workshop-1',draft);
  repo.capture('studio',records); assert.equal(repo.get('workshop:workshop-1'),undefined); repo.set('workshop:workshop-1',draft);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM offline_drafts').get() as any).count,0);
  repo.bindOrigin('http://localhost:4002'); assert.equal(repo.getSnapshot().account,null); assert.equal(repo.getSnapshot().records.length,0); db.close();
});
test('corrupt persisted records fail closed and corrupt drafts are removed', () => {
  const {db,driver,repo}=open(); repo.capture('workshop',records); repo.set('workshop:workshop-1',draft);
  db.prepare('UPDATE offline_drafts SET draft=?').run('{'); assert.equal(repo.get('workshop:workshop-1'),undefined);
  db.prepare('UPDATE offline_cache SET records=?').run('{'); const fresh=new OfflineRepository(driver,origin); assert.equal(fresh.getSnapshot().account,null); db.close();
});
test('invalid/oversized input cannot replace a confirmed cache or draft', () => {
  const {db,repo}=open(); repo.capture('workshop',records); const before=repo.getSnapshot();
  assert.throws(()=>repo.capture('workshop','x'.repeat(524289))); assert.strictEqual(repo.getSnapshot(),before);
  assert.throws(()=>repo.capture('workshop',JSON.stringify([{id:'bad',title:'Bad',tasks:[{id:'bad',title:'Bad',notes:'',completed:false,version:1,attachments:[]}]}])));
  assert.throws(()=>repo.set('workshop:workshop-1',{fields:{password:'secret'},sequence:0}));
  assert.throws(()=>repo.set('workshop:workshop-1',{...draft,fields:{'task[notes]':'a'.repeat(4001)}})); db.close();
});
test('draft storage is bounded and telemetry contains only fixed numeric attributes', () => {
  const {db,driver}=open(); const events:any[]=[]; const repo=new OfflineRepository(driver,origin,(name,attrs)=>events.push({name,attrs})); repo.capture('workshop',records);
  for(let i=0;i<105;i++) repo.set(`workshop:task-${i}`,draft);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM offline_drafts').get() as any).count,100);
  assert.equal(repo.get('workshop:task-0'),undefined); assert.ok(repo.get('workshop:task-104'));
  assert.ok(events.every(event=>Object.values(event.attrs).every(value=>typeof value==='number'||typeof value==='boolean'))); db.close();
});
