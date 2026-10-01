(async()=>{
 const live=()=>globalThis.__lvnSession;const repository=globalThis.__lvnOffline;
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Queue timeout: '+label);await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>repository&&live()?.status!=='connected','offline');
 const isAndroid=repository.getSnapshot().origin.includes('10.0.2.2');const taskId=isAndroid?'workshop-3':'workshop-2';const key='workshop:'+taskId;
 await live().navigate('/checklists/workshop-launch/tasks/'+taskId+'/edit',true);
 await wait(()=>globalThis.__lvnOfflineEditors?.get(key)&&globalThis.__lvnOfflineQueueDrafts?.get(key),'installed offline editor');
 const controller=globalThis.__lvnOfflineEditors.get(key);controller.setField('task[notes]','Durable offline action from '+(isAndroid?'Android':'iOS'));
 await new Promise(r=>setTimeout(r,150));globalThis.__lvnOfflineQueueDrafts.get(key)();
 await wait(()=>repository.getCommands().some(item=>item.command.taskId===taskId),'persisted queue');
 const pending=repository.getCommands().find(item=>item.command.taskId===taskId);
 globalThis.__lvnScrollTo?.(600);
 return {ok:true,queuedThroughInstalledEditor:true,pending:repository.getCommands().length,operationId:pending.command.operationId,taskId,baselineVersion:pending.command.expectedVersion,draftRetained:Boolean(repository.get(key))};
})()
