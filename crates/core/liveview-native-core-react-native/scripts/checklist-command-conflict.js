(async()=>{
 const live=()=>globalThis.__lvnSession;const repository=globalThis.__lvnOffline;const key='workshop:workshop-1';
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Conflict timeout: '+label);await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>live()?.status==='connected'&&repository.getCommands().length===0,'ready');
 const task=repository.getSnapshot().records[0].tasks.find(item=>item.id==='workshop-1');
 repository.set(key,{fields:{'task[id]':task.id,'task[version]':String(task.version),'task[title]':task.title,'task[notes]':'My retained conflict intention','task[completed]':String(task.completed)},sequence:7});
 await live().pushEvent('toggle_task',{id:task.id,version:String(task.version)});
 await wait(()=>repository.getSnapshot().records[0].tasks.find(item=>item.id===task.id).version===task.version+1,'concurrent server update');
 const queued=repository.enqueue({taskId:task.id,expectedVersion:task.version,type:'update_task',payload:{title:task.title,notes:'My retained conflict intention',completed:task.completed}},key,7);
 await wait(()=>repository.getCommands().find(item=>item.command.operationId===queued.command.operationId)?.state==='conflict','durable conflict');
 if(repository.get(key)?.fields['task[version]']!==String(task.version)||repository.get(key)?.fields['task[notes]']!=='My retained conflict intention')throw new Error('Conflict lost original draft');
 await wait(()=>globalThis.__lvnReapplyCommands?.get(queued.command.operationId),'installed guarded reapply action');
 globalThis.__lvnScrollTo?.(800);await new Promise(r=>setTimeout(r,200));
 globalThis.__lvnLastConflict={operationId:queued.command.operationId,originalVersion:task.version,serverVersion:task.version+1};
 return {ok:true,versionConflictRetained:true,draftAndBaselinePreserved:true,reapplyButtonEnabledForVerifiedAccount:true,originalVersion:task.version,serverVersion:task.version+1};
})()
