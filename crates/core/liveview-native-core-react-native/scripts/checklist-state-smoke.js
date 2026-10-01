(async () => {
 const native = globalThis.expoV2?.modules?.LiveViewNative ?? globalThis.expo.modules.LiveViewNative;
 const url = globalThis.expoV2?.modules?.LiveViewNative ? 'http://10.0.2.2:4001/checklists' : 'http://127.0.0.1:4001/checklists';
 const id = 'state-smoke-'+Date.now(); const updates = []; let latest;
 const sub = native.addListener('onUpdate', update => { if(update.sessionId===id){updates.push(update);if(update.document)latest=update;} });
 async function wait(predicate) { const end=Date.now()+10000; while(!predicate()){ if(Date.now()>end)throw new Error('Timed out waiting for native document'); await new Promise(r=>setTimeout(r,50)); } }
 const task = () => { if(!latest)return;const node=JSON.parse(latest.document).nodes.find(n=>n.attributes?.['data-records']); return node && JSON.parse(node.attributes['data-records'])[0].tasks[0]; };
 try {
  await native.connect(id,url);await wait(()=>task());const before=task();const generation=latest.documentGeneration;
  await native.sendEvent(id,'toggle_task',JSON.stringify({id:before.id,version:String(before.version)}));
  await wait(()=>task()?.version===before.version+1);
  const after=task();if(after.completed===before.completed)throw new Error('Completion not toggled');
  if(latest.documentGeneration!==generation)throw new Error('Patch incorrectly replaced document generation');
  await native.disconnect(id);latest=null;await native.connect(id,url);await wait(()=>latest?.documentGeneration>=1&&task()?.version===after.version);
  return {ok:true,beforeVersion:before.version,afterVersion:after.version,persistedCompleted:task().completed,generation,callbacks:updates.map(u=>u.callbackCount),snapshotMs:updates.filter(u=>u.document).map(u=>u.snapshotMs)};
 }finally{await native.disconnect(id);sub.remove();}
})()
