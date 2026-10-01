(async()=>{
 const live=()=>globalThis.__lvnSession,route=()=>globalThis.__lvnRoute();
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Reconnect timeout: '+label);await new Promise(r=>setTimeout(r,40));}};
 await wait(()=>live()?.status==='connected','connected');
 const paths=['/checklists/workshop-launch','/checklists/workshop-launch/tasks/workshop-1/edit'];const proofs=[];
 for(const path of paths){
  if(route().committedRoute!==path)await live().navigate(path);
  await wait(()=>route().committedRoute===path&&route().pathname===path,'navigate');
  const old=live().sessionId;live().retry();
  await wait(()=>live().sessionId!==old&&live().status==='connected'&&route().committedRoute===path&&route().pathname===path,'active route');
  await new Promise(r=>setTimeout(r,300));
  if(route().committedRoute!==path||route().pathname!==path)throw new Error('Reconnect route changed after settle');
  proofs.push({path,newSession:true,activeRouteRestored:true});
 }
 return {ok:true,proofs};
})()
