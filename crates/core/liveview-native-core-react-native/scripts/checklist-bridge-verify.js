(async()=>{
 const live=()=>globalThis.__lvnSession,repo=globalThis.__lvnOffline;
 const native=globalThis.expoV2?.modules?.LiveViewNative??globalThis.expo.modules.LiveViewNative;
 const wait=async(predicate,label)=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error('Bridge verification timeout: '+label);await new Promise(r=>setTimeout(r,40));}};
 await wait(()=>live()?.status==='connected'&&repo?.getSnapshot().account==='workshop','connected');
 const attr=name=>[...live().document.nodes.values()].find(node=>node.attributes?.[name])?.attributes[name];
 if(attr('data-route')!=='/checklists/workshop-launch'){
  await live().navigate('/checklists/workshop-launch');await wait(()=>attr('data-route')==='/checklists/workshop-launch','detail');
 }
 await new Promise(r=>setTimeout(r,300));
 const generation=live().documentGeneration;
 const before=new Map(globalThis.__lvnNodeRenderCounts);
 const events=[];const listener=native.addListener('onUpdate',update=>{if(update.sessionId===live().sessionId)events.push({kind:update.documentKind,generation:update.documentGeneration,revision:update.documentRevision,base:update.baseDocumentRevision,bytes:update.patchBytes??update.snapshotBytes??0,callbacks:update.coalescedCallbacks??1});});
 try{
  const task=repo.getSnapshot().records[0].tasks.find(item=>item.id==='workshop-3');
  await live().pushEvent('toggle_task',{id:task.id,version:String(task.version)});
  await wait(()=>repo.getSnapshot().records[0].tasks.find(item=>item.id===task.id).version===task.version+1,'version');
  await new Promise(r=>setTimeout(r,300));
  const after=new Map(globalThis.__lvnNodeRenderCounts);
  const unchanged=[...before].filter(([id,count])=>after.get(id)===count).length;
  const changed=[...before].filter(([id,count])=>(after.get(id)??0)>count).length;
  if(!events.some(event=>event.kind==='patch'))throw new Error('No incremental patch delivered');
  if(!unchanged||!changed)throw new Error('Subtree memoization not observed');
  const fullBefore=events.filter(event=>event.kind==='full').length;
  await native.requestSnapshot(live().sessionId);
  await wait(()=>events.filter(event=>event.kind==='full').length>fullBefore,'forced full snapshot');
  await wait(()=>live().status==='connected','resync store');
  if(live().documentGeneration!==generation)throw new Error('Snapshot unexpectedly replaced generation');
  await live().navigate('/checklists');await wait(()=>attr('data-route')==='/checklists','new generation');
  if(!events.some(event=>event.kind==='full'&&event.generation>generation))throw new Error('Replacement did not deliver full snapshot');
  return {ok:true,patchDelivered:true,unchangedRenderedNodes:unchanged,changedRenderedNodes:changed,forcedFullResync:true,replacementStartsFull:true,events,debugSimulatorMeasurement:true};
 }finally{listener.remove();}
})()
