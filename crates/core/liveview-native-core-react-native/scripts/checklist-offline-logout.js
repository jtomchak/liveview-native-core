(async()=>{
 const repository=globalThis.__lvnOffline;
 if(!repository?.getSnapshot().account)throw new Error('Expected cached account');
 await globalThis.__lvnSession.logout('/session/delete').catch(()=>{});
 if(repository.getSnapshot().account!==null||repository.getSnapshot().records.length||repository.get('workshop:workshop-1'))throw new Error('Logout retained private data');
 return {ok:true,offlineLogoutClearedCacheAndDraft:true,remoteRevocationConfirmed:false};
})()
