(async()=>{
 const live=()=>globalThis.__lvnSession;const repository=globalThis.__lvnOffline;const pending=repository.getCommands()[0];
 if(!pending)throw new Error('Expected restored pending action');live().retry();
 const end=Date.now()+15000;
 while(repository.getCommands().some(item=>item.command.operationId===pending.command.operationId)){if(Date.now()>end)throw new Error('Replay not acknowledged');await new Promise(r=>setTimeout(r,50));}
 const getTask=()=>repository.getSnapshot().records.flatMap(record=>record.tasks).find(task=>task.id===pending.command.taskId);
 while(getTask()?.version!==pending.command.expectedVersion+1){if(Date.now()>end)throw new Error('Visible confirmed record did not arrive');await new Promise(r=>setTimeout(r,50));}
 const task=getTask();
 if(task?.version!==pending.command.expectedVersion+1||task.notes!==pending.command.payload.notes)throw new Error('Confirmed server record did not match queued intent');
 if(repository.get('workshop:'+task.id))throw new Error('Matching acknowledged draft was not cleared');
 return {ok:true,restoredActionAcknowledged:true,serverRecordConfirmed:true,recordAdvancedOnce:true,matchingDraftCleared:true,version:task.version};
})()
