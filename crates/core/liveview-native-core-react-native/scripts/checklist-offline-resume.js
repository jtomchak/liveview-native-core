(async()=>{
 const live=()=>globalThis.__lvnSession;
 const path='/checklists/workshop-launch/tasks/workshop-1/edit';
 live().retry();
 const end=Date.now()+15000;
 while(live().status!=='connected'||globalThis.__lvnRoute?.().committedRoute!==path||!globalThis.__lvnForms?.get('workshop:workshop-1')){
   if(Date.now()>end)throw new Error('Reconnect did not restore active editor');
   await new Promise(resolve=>setTimeout(resolve,50));
 }
 const fields=globalThis.__lvnForms.get('workshop:workshop-1').getSnapshot().fields;
 if(fields['task[title]']!=='Persisted offline checklist draft'||fields['task[notes]']!=='Edited locally while Phoenix is unavailable.')throw new Error('Online editor lost offline edits');
 return {ok:true,connectedActiveRouteRestored:true,offlineDraftHydratedIntoOnlineForm:true,baselineVersion:Number(fields['task[version]'])};
})()
