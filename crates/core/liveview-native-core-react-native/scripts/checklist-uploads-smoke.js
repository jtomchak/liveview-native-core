(async () => {
 const live=()=>globalThis.__lvnSession;
 const attr=name=>[...(live()?.document?.nodes.values()??[])].find(n=>n.attributes?.[name])?.attributes[name];
 const input=()=>[...(live()?.document?.nodes.values()??[])].find(n=>n.tag==='UploadInput')?.attributes;
 const wait=async(predicate,label)=>{const end=Date.now()+12000;while(!predicate()){if(Date.now()>end)throw new Error('Uploads timeout: '+label+' '+JSON.stringify({route:globalThis.__lvnRoute?.(),status:live()?.status,upload:input()?.['data-upload-status'],phase:globalThis.__lvnUploads?.get('attachment')?.getSnapshot().phase}));await new Promise(r=>setTimeout(r,10));}};
 const root='/checklists/workshop-launch/tasks/workshop-1';
 await wait(()=>live()?.status==='connected','connected');
 if(attr('data-account') && attr('data-account')!=='workshop'){await live().logout('/session/delete');await wait(()=>attr('data-auth')==='signed-out','logout');}
 if(attr('data-auth')==='signed-out'){await live().postForm('/session',{account:'workshop',password:'workshop-demo'});await wait(()=>attr('data-route')==='/checklists'&&globalThis.__lvnRoute?.().pathname==='/checklists','signed-in root');}
 await new Promise(r=>setTimeout(r,300));
 await live().navigate(root);await wait(()=>attr('data-route')===root&&globalThis.__lvnRoute?.().pathname===root,'task');
 const fixture=globalThis.__lvnUploadFixture;if(!fixture)throw new Error('Native cached file fixture missing');
 const controller=()=>globalThis.__lvnUploads?.get('attachment');await wait(()=>controller(),'upload controller');
 const task=()=>JSON.parse(attr('data-records'))[0].tasks.find(t=>t.id==='workshop-1');const before=(task().attachments??[]).length;
 let oversizedRejected=false;try{await live().uploadFile('attachment',{uri:fixture.tooLarge,name:'too-large.txt',mimeType:'text/plain'});}catch{oversizedRejected=true;}
 if(!oversizedRejected||live().status!=='connected')throw new Error('Native oversized read broke session');
 controller().pick=async()=>({uri:fixture.cancel,name:'cancel.txt',mimeType:'text/plain',size:fixture.cancelSize});
 const cancelling=controller().select(true);
 await wait(()=>input()?.['data-upload-ref'],'active reference');
 const cancelProgress=Number(input()['data-upload-progress']);
 await live().cancelUpload('attachment',input()['data-upload-ref']);await cancelling;
 await wait(()=>controller()?.getSnapshot().phase==='cancelled','cancel confirmed');
 if((task().attachments??[]).length!==before)throw new Error('Cancel persisted attachment');
 controller().pick=async()=>({uri:fixture.small,name:'native-checklist.txt',mimeType:'text/plain',size:fixture.smallSize});
 const progress=new Set();const observe=setInterval(()=>{const value=Number(input()?.['data-upload-progress']);if(Number.isInteger(value))progress.add(value);},5);
 try{await controller().select(true);await wait(()=>controller()?.getSnapshot().phase==='ready','transfer confirmed');progress.add(controller().getSnapshot().progress);}finally{clearInterval(observe);}
 if(controller().getSnapshot().progress!==100)throw new Error('Server transfer not complete');
 await live().pushEvent('attach_upload',{id:task().id,version:String(task().version)});
 await wait(()=>(task().attachments??[]).length===before+1,'attachment persisted');
 await wait(()=>controller()?.getSnapshot().phase==='saved','saved metadata');
 const saved=task();const attachment=saved.attachments[saved.attachments.length-1];
 if(attachment.name!=='native-checklist.txt'||attachment.size!==fixture.smallSize)throw new Error('Wrong attachment metadata');
 await live().navigate('/checklists/workshop-launch');await live().navigate(root);await wait(()=>attr('data-route')===root,'reopened task');
 if((task().attachments??[]).length!==before+1)throw new Error('Attachment lost after route replacement');
 return {ok:true,nativeSizeLimitRejected:true,sessionRemainedConnected:true,cancelProgress,cancelConfirmed:true,cancelSavedNothing:true,retryTransferServerConfirmed:true,observedProgress:[...progress],attachmentPersisted:true,restoredAfterNavigation:true};
})()
