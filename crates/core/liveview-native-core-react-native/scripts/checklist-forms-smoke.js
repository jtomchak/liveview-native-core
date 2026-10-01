(async () => {
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Forms timeout: '+label);await new Promise(r=>setTimeout(r,50));}};
 const coherent=async path=>wait(()=>attr('data-route')===path && globalThis.__lvnRoute?.().pathname===path,path);
 await wait(()=>live()?.status==='connected','connected');
 if(attr('data-account') && attr('data-account')!=='workshop'){await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out','logout');}
 if(attr('data-auth')==='signed-out')await live().postForm('/session',{account:'workshop',password:'workshop-demo'});
 const root='/checklists/workshop-launch/tasks/workshop-1',edit=root+'/edit';
 await live().navigate(root);await coherent(root);await live().navigate(edit);await coherent(edit);
 const controller=()=>globalThis.__lvnForms?.get('workshop:workshop-1');
 await wait(()=>controller(),'controller');
 controller().setField('task[title]','');
 await wait(()=>controller().getSnapshot().errors.title,'invalid validation');
 const task=JSON.parse(attr('data-records'))[0].tasks.find(t=>t.id==='workshop-1');
 if(task.title==='')throw new Error('Validation wrote record');
 controller().setField('task[title]','Prepare the workbench');
 controller().setField('task[notes]','Saved through React Native form transport');
 await controller().submit(true);await coherent(root);
 const saved=JSON.parse(attr('data-records'))[0].tasks.find(t=>t.id===task.id);
 if(saved.notes!=='Saved through React Native form transport'||saved.version!==task.version+1)throw new Error('Save was not persisted');
 await live().navigate(edit);await coherent(edit);await wait(()=>controller(),'reopened controller');
 if(controller().getSnapshot().dirty)throw new Error('Saved draft was not cleared');
 controller().setField('task[title]','My retained conflict draft');
 await live().pushEvent('toggle_task',{id:task.id,version:String(saved.version)});
 await wait(()=>JSON.parse(attr('data-records'))[0].tasks.find(t=>t.id===task.id).version>saved.version,'concurrent update');
 await controller().submit(true);
 await wait(()=>attr('data-form-status')==='conflict','conflict metadata');
 if(controller().getSnapshot().fields['task[version]']!==String(saved.version)||controller().getSnapshot().fields['task[title]']!=='My retained conflict draft')throw new Error('Conflict destroyed draft');
 await live().navigate(root,true);await coherent(root);await live().navigate(edit);await coherent(edit);await wait(()=>controller(),'draft reopened');
 if(controller().getSnapshot().fields['task[title]']!=='My retained conflict draft')throw new Error('Route change lost draft');
 controller().cancel();await live().navigate(root,true);await coherent(root);await live().navigate(edit);await coherent(edit);await wait(()=>controller(),'cancel reopened');
 if(controller().getSnapshot().dirty)throw new Error('Cancel retained draft');
 return {ok:true,invalidWithoutWrite:true,savedAndNavigated:true,versionAdvanced:true,savedDraftCleared:true,conflictDraftAndBaselineRetained:true,draftRestoredAfterRouteChange:true,cancelClearsDraft:true,route:attr('data-route')};
})()
