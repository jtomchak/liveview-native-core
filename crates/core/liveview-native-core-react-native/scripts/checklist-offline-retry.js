(async()=>{
 const repository=globalThis.__lvnOffline;
 const before=repository.get('workshop:workshop-1');
 if(!before)throw new Error('Expected durable draft');
 globalThis.__lvnSetEndpoint(repository.getSnapshot().origin+'/checklists');
 await new Promise(resolve=>setTimeout(resolve,500));
 const after=repository.get('workshop:workshop-1');
 if(repository.getSnapshot().account!=='workshop'||JSON.stringify(after)!==JSON.stringify(before))throw new Error('Same endpoint reconnect erased private data');
 globalThis.__lvnScrollTo?.(200);
 return {ok:true,sameEndpointRetryPreservedCacheAndDraft:true};
})()
