(async () => {
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 const wait=async predicate=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Restore/logout document timeout');await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>attr('data-account')==='studio');
 const restored=attr('data-account'); await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out');
 if(attr('data-account'))throw new Error('Protected document survived logout');
 await live().postForm('/session',{account:'workshop',password:'workshop-demo'});await wait(()=>attr('data-account')==='workshop');
 const switched=attr('data-account');await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out');
 return {ok:true,restoredAfterProcessRestart:restored,switchedAccount:switched,logoutState:attr('data-auth'),privateDocumentCleared:!attr('data-account')};
})()
