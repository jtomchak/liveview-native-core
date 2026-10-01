import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineRepository, type SqlDriver, type DurableCommand } from '../example/offlineRepository';
import { OutboxRunner } from '../example/outbox';
import type { LiveViewSession } from '../src/types';
const records=(account='workshop',version=3)=>JSON.stringify([{id:account+'-launch',title:'Opening',tasks:[{id:account+'-1',title:'Tools',notes:'',completed:false,version,attachments:[]}]}]);
const draft={fields:{'task[id]':'workshop-1','task[version]':'3','task[title]':'Tools','task[notes]':'Draft','task[completed]':'false'},sequence:2};
const intent={taskId:'workshop-1',expectedVersion:3,type:'update_task' as const,payload:{title:'Tools',notes:'Draft',completed:false}};
function open(file=':memory:') { const db=new DatabaseSync(file); const driver:SqlDriver={exec:sql=>db.exec(sql),run:(sql,...args)=>{db.prepare(sql).run(...args);},first:<T,>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T??null,all:<T,>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[]};return{db,repo:new OfflineRepository(driver,'http://localhost:4001')}; }
const receipt=(command:DurableCommand)=>({operationId:command.operationId,taskId:command.taskId,status:'committed',version:command.expectedVersion+1,committedAt:Date.now(),retainedUntil:Date.now()+604800000});
const live=(callEvent:LiveViewSession['callEvent'],sessionId='one')=>({sessionId,status:'connected',callEvent}) as LiveViewSession;
async function until(predicate:()=>boolean) {const end=Date.now()+2500;while(!predicate()){if(Date.now()>end)throw new Error('Outbox timeout');await new Promise(resolve=>setTimeout(resolve,10));}}
test('outbox and draft provenance survive real SQLite close/reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lvn-outbox-'));try{const file=join(dir,'db');const first=open(file);first.repo.capture('workshop',records());first.repo.set('workshop:workshop-1',draft);const queued=first.repo.enqueue(intent,'workshop:workshop-1',2);first.db.close();const second=open(file);assert.deepEqual(second.repo.getCommands()[0],queued);assert.equal(second.repo.get('workshop:workshop-1')?.submissionId,queued.command.operationId);second.db.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('lost acknowledgement retries identical ID/body; one commit then atomic draft cleanup',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.set('workshop:workshop-1',draft);const queued=repo.enqueue(intent,'workshop:workshop-1',2);let commits=0;const bodies:string[]=[];let committed:any;
 const runner=new OutboxRunner(repo);runner.setConnection(live(async(_event,value)=>{bodies.push(JSON.stringify(value));if(!committed){commits++;committed=receipt(value.command as DurableCommand);throw new Error('lost ack');}return committed;}),'workshop');
 await until(()=>repo.getCommands().length===0);assert.equal(commits,1);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(committed.operationId,queued.command.operationId);assert.equal(repo.get('workshop:workshop-1'),undefined);runner.dispose();db.close();
});
test('unmatched acknowledgement retains durable action and local draft',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.set('workshop:workshop-1',draft);repo.enqueue(intent,'workshop:workshop-1',2);const runner=new OutboxRunner(repo);runner.setConnection(live(async(_event,value)=>({...receipt(value.command as DurableCommand),operationId:'wrong'})),'workshop');await until(()=>runner.getState().attempts===1);assert.equal(repo.getCommands().length,1);assert.ok(repo.get('workshop:workshop-1'));runner.dispose();db.close();
});
test('late old account receipt cannot delete new account work',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());const old=repo.enqueue(intent);let resolve!:(value:any)=>void;const runner=new OutboxRunner(repo);runner.setConnection(live(async()=>new Promise(r=>resolve=r)),'workshop');repo.capture('studio',records('studio'));const fresh=repo.enqueue({...intent,taskId:'studio-1'});runner.setConnection({...live(async()=>new Promise(()=>{}),'two'),status:'disconnected'},null);resolve(receipt(old.command));await until(()=>!runner.getState().sending);assert.equal(repo.getCommands()[0].command.operationId,fresh.command.operationId);runner.dispose();db.close();
});
test('conflict keeps original version; explicit reapply uses new ID and confirmed version',()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.set('workshop:workshop-1',draft);const old=repo.enqueue(intent,'workshop:workshop-1',2);repo.markCommand(old.command.operationId,'conflict',4);repo.capture('workshop',records('workshop',4));assert.equal(repo.get('workshop:workshop-1')?.fields['task[version]'],'3');assert.throws(()=>repo.reapplyCommand(old.command.operationId,3));const fresh=repo.reapplyCommand(old.command.operationId,4);assert.notEqual(fresh.command.operationId,old.command.operationId);assert.equal(fresh.command.expectedVersion,4);assert.equal(repo.get('workshop:workshop-1')?.fields['task[version]'],'4');repo.acknowledge(fresh.command.operationId);assert.equal(repo.get('workshop:workshop-1'),undefined);db.close();
});
test('confirmed receipt does not erase edits made after queueing',()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.set('workshop:workshop-1',draft);const old=repo.enqueue(intent,'workshop:workshop-1',2);repo.set('workshop:workshop-1',{...draft,fields:{...draft.fields,'task[notes]':'Newer edit'},sequence:3});repo.acknowledge(old.command.operationId);assert.equal(repo.get('workshop:workshop-1')?.fields['task[notes]'],'Newer edit');db.close();
});
test('reapply cannot adopt another draft with a coincidentally matching sequence',()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.set('workshop:workshop-1',draft);const old=repo.enqueue(intent,'workshop:workshop-1',2);repo.markCommand(old.command.operationId,'conflict',4);repo.capture('workshop',records('workshop',4));repo.delete('workshop:workshop-1');repo.set('workshop:workshop-1',{...draft,fields:{...draft.fields,'task[notes]':'Different edit'}});const fresh=repo.reapplyCommand(old.command.operationId,4);repo.acknowledge(fresh.command.operationId);assert.equal(repo.get('workshop:workshop-1')?.fields['task[notes]'],'Different edit');db.close();
});
test('foreign account verification, duplicate pending task and invalid payload cannot dispatch',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.enqueue(intent);assert.throws(()=>repo.enqueue(intent));assert.throws(()=>repo.enqueue({...intent,payload:{...intent.payload,title:''}}));let sends=0;const runner=new OutboxRunner(repo);runner.setConnection(live(async()=>{sends++;return {};}),'studio');await new Promise(r=>setTimeout(r,10));assert.equal(sends,0);repo.bindOrigin('http://localhost:4002');assert.equal(repo.getCommands().length,0);runner.dispose();db.close();
});
test('runner reactivates after effect cleanup without sending from its constructor',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());repo.enqueue(intent);let sends=0;const connection=live(async(_event,value)=>{sends++;return receipt(value.command as DurableCommand);});const runner=new OutboxRunner(repo);assert.equal(sends,0);runner.dispose();runner.setConnection(connection,'workshop');await until(()=>repo.getCommands().length===0);assert.equal(sends,1);runner.dispose();db.close();
});

test('a safe unavailable server reply keeps the same durable operation queued for retry',async()=>{
 const {db,repo}=open();repo.capture('workshop',records());const queued=repo.enqueue(intent);const runner=new OutboxRunner(repo);
 runner.setConnection(live(async(_event,value)=>({operationId:(value.command as DurableCommand).operationId,taskId:'workshop-1',status:'unavailable'})),'workshop');
 await until(()=>runner.getState().attempts===1);assert.equal(repo.getCommands()[0].state,'queued');assert.equal(repo.getCommands()[0].command.operationId,queued.command.operationId);runner.dispose();db.close();
});
