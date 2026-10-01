(async () => {
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Navigation timeout: '+label+' '+JSON.stringify(globalThis.__lvnRoute?.()));await new Promise(r=>setTimeout(r,50));}};
 const coherent=async path=>wait(()=>attr('data-route')===path && globalThis.__lvnRoute?.().pathname===path,path);
 await wait(()=>attr('data-auth'),'auth');
 if(attr('data-account') && attr('data-account')!=='workshop'){await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out','logout');}
 if(attr('data-auth')==='signed-out')await live().postForm('/session',{account:'workshop',password:'workshop-demo'});
 if(attr('data-route')!=='/checklists')await live().navigate('/checklists');
 await coherent('/checklists');
 const checklist=JSON.parse(attr('data-records'))[0];
 const detail='/checklists/'+checklist.id;const task=detail+'/tasks/'+checklist.tasks[0].id;
 const generations=[live().documentGeneration];
 await live().navigate(detail);await coherent(detail);generations.push(live().documentGeneration);
 await live().navigate(task);await coherent(task);generations.push(live().documentGeneration);
 await live().back();await coherent(detail);const back=await live().getNavigation();
 await live().forward();await coherent(task);
 await live().pushEvent('server_navigation',{id:checklist.id,replace:'true'});await coherent(detail);
 const replaced=await live().getNavigation();if(replaced.action!=='replace')throw new Error('Server replace not reported');
 let rejected=false;try{await live().navigate('https://foreign.test/checklists');}catch{rejected=true;}
 if(!rejected)throw new Error('Foreign origin navigation accepted');
 return {ok:true,listDetailTaskBackForward:true,serverReplace:replaced.action,foreignOriginRejected:rejected,generations,backCanGoForward:back.canGoForward,finalRoute:globalThis.__lvnRoute(),deepLinkPath:task};
})()
