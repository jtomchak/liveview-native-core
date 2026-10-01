(async () => {
 const wait=async predicate=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Auth document timeout');await new Promise(r=>setTimeout(r,50));}};
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 await wait(()=>attr('data-auth'));
 if(attr('data-auth')==='signed-in'){await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out');}
 await live().postForm('/session',{account:'workshop',password:'wrong'});
 await wait(()=>attr('data-auth')==='signed-out');
 if(attr('data-account'))throw new Error('Invalid credentials exposed account');
 await live().postForm('/session',{account:'studio',password:'studio-demo'});
 await wait(()=>attr('data-account')==='studio');
 return {ok:true,invalidRejected:true,account:attr('data-account'),generation:live().documentGeneration,status:live().status};
})()
