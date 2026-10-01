(async()=>{
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Offline prepare timeout: '+label);await new Promise(r=>setTimeout(r,50));}};
 await wait(()=>live()?.status==='connected'&&globalThis.__lvnOffline,'repository ready');
 if(attr('data-account')&&attr('data-account')!=='workshop'){await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out','signed out');}
 if(attr('data-auth')==='signed-out')await live().postForm('/session',{account:'workshop',password:'workshop-demo'});
 await wait(()=>globalThis.__lvnOffline.getSnapshot().account==='workshop','cached account');
 const edit='/checklists/workshop-launch/tasks/workshop-1/edit';
 await live().navigate(edit,true); await wait(()=>attr('data-route')===edit&&globalThis.__lvnRoute?.().pathname===edit,'edit coherent');
 await wait(()=>globalThis.__lvnForms?.get('workshop:workshop-1'),'mounted form');
 const controller=globalThis.__lvnForms.get('workshop:workshop-1');
 controller.setField('task[title]','Persisted offline checklist draft');
 controller.setField('task[notes]','Kept across a real native process restart.');
 const draft=globalThis.__lvnOffline.get('workshop:workshop-1');
 if(!draft||draft.fields['task[title]']!=='Persisted offline checklist draft')throw new Error('SQLite did not retain draft');
 return {ok:true,cacheRecords:globalThis.__lvnOffline.getSnapshot().records.length,baselineVersion:Number(draft.fields['task[version]']),sequence:draft.sequence};
})()
