(async()=>{
 const live=()=>globalThis.__lvnSession;
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Offline restore timeout: '+label);await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>globalThis.__lvnOffline&&live()?.status!=='connected','offline cache');
 const repository=globalThis.__lvnOffline; const cached=repository.getSnapshot();
 if(cached.account!=='workshop'||!cached.records.length)throw new Error('Cache lost on restart');
 const draft=repository.get('workshop:workshop-1'); if(draft?.fields['task[title]']!=='Persisted offline checklist draft')throw new Error('Draft lost on restart');
 const edit='/checklists/workshop-launch/tasks/workshop-1/edit'; await live().navigate(edit,true);
 await wait(()=>globalThis.__lvnOfflineEditors?.get('workshop:workshop-1'),'offline native editor');
 const controller=globalThis.__lvnOfflineEditors.get('workshop:workshop-1');
 if(controller.getSnapshot().fields['task[version]']!==draft.fields['task[version]'])throw new Error('Offline editor silently rebased draft');
 controller.setField('task[notes]','Edited locally while Phoenix is unavailable.');
 if(repository.get('workshop:workshop-1')?.fields['task[notes]']!=='Edited locally while Phoenix is unavailable.')throw new Error('Offline edit was not persisted');
 globalThis.__lvnScrollTo?.(0);
 return {ok:true,processRestartCacheRestored:true,processRestartDraftRestored:true,offlineEditorMounted:true,offlineEditPersisted:true,baselineVersion:Number(draft.fields['task[version]']),route:globalThis.__lvnRoute?.().pathname,status:live().status};
})()
