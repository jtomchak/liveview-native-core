(async()=>{
 const live=()=>globalThis.__lvnSession;const repo=()=>globalThis.__lvnOffline;
 const wait=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error('Command protocol timeout');await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>live()?.status==='connected'&&repo()?.getSnapshot().account==='workshop');
 const task=repo().getSnapshot().records[0].tasks.find(task=>task.id==='workshop-2');
 const command={operationId:Date.now()+'-'+('a'.repeat(32)),accountId:'workshop',taskId:task.id,expectedVersion:task.version,type:'set_completed',payload:{completed:!task.completed}};
 const first=await live().callEvent('execute_command',{command});const replay=await live().callEvent('execute_command',{command});
 if(first.status!=='committed'||Object.keys(first).length!==Object.keys(replay).length||Object.keys(first).some(key=>first[key]!==replay[key]))throw new Error('Replay did not return original committed receipt');
 await wait(()=>repo().getSnapshot().records[0].tasks.find(item=>item.id===task.id).version===task.version+1);
 return {ok:true,nativeIntegerCommandAccepted:true,identicalReplayReturnedOriginalReceipt:true,recordAdvancedOnce:true,version:Number(first.version)};
})()
