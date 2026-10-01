(async()=>{
 const live=globalThis.__lvnSession,repo=globalThis.__lvnOffline;
 const native=globalThis.expoV2?.modules?.LiveViewNative??globalThis.expo.modules.LiveViewNative;
 const task=repo.getSnapshot().records[0].tasks.find(item=>item.id==='workshop-3');
 const events=[];const subscription=native.addListener('onUpdate',update=>{if(update.sessionId===live.sessionId)events.push({revision:update.revision,documentGeneration:update.documentGeneration,kind:update.documentKind??(update.document?'full':'status'),bytes:update.patchBytes??update.snapshotBytes??0,fullSnapshotBytes:update.fullSnapshotBytes??update.snapshotBytes??0,callbackCount:update.callbackCount,coalescedCallbacks:update.coalescedCallbacks??1,snapshotMs:update.snapshotMs??0,hasDocument:Boolean(update.document||update.documentPatch)});});
 try{
  await live.pushEvent('toggle_task',{id:task.id,version:String(task.version)});
  const end=Date.now()+10000;while(repo.getSnapshot().records[0].tasks.find(item=>item.id===task.id).version!==task.version+1){if(Date.now()>end)throw new Error('Bridge benchmark timeout');await new Promise(r=>setTimeout(r,30));}
  await new Promise(r=>setTimeout(r,400));
  const documents=events.filter(event=>event.hasDocument);
  return{ok:true,documentEvents:documents.length,bridgeBytes:documents.reduce((sum,event)=>sum+event.bytes,0),events,debugSimulatorMeasurement:true};
 }finally{subscription.remove();}
})()
