(async()=>{
 const repository=globalThis.__lvnOffline;const conflict=globalThis.__lvnLastConflict;
 const callback=globalThis.__lvnReapplyCommands?.get(conflict.operationId);if(!callback)throw new Error('No installed reapply action');callback();
 const end=Date.now()+15000;
 while(repository.getCommands().length){if(Date.now()>end)throw new Error('Explicit reapply not acknowledged');await new Promise(r=>setTimeout(r,50));}
 const task=()=>repository.getSnapshot().records[0].tasks.find(item=>item.id==='workshop-1');
 while(task().version!==conflict.serverVersion+1){if(Date.now()>end)throw new Error('Reapplied record not visible');await new Promise(r=>setTimeout(r,50));}
 if(task().notes!=='My retained conflict intention'||repository.get('workshop:workshop-1'))throw new Error('Explicit reapply did not save and clear matching draft');
 return {ok:true,explicitInstalledReapplyConfirmed:true,desiredStateSaved:true,matchingDraftCleared:true,newVersion:task().version};
})()
