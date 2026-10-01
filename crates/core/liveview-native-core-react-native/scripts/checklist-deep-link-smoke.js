(async () => {
 const expected='/checklists/workshop-launch/tasks/workshop-1';
 const wait=async()=>{for(let n=0;n<100;n++){const route=globalThis.__lvnRoute?.();if(route?.pathname===expected&&route.committedRoute===expected&&!route.pending)return;await new Promise(r=>setTimeout(r,100));}throw new Error('OS deep link did not commit: '+JSON.stringify(globalThis.__lvnRoute?.()));};
 await wait();const sessionId=globalThis.__lvnSession.sessionId;
 await new Promise(r=>setTimeout(r,5000));await wait();
 if(globalThis.__lvnSession.sessionId!==sessionId)throw new Error('Deep link replaced the client session');
 return {ok:true,route:globalThis.__lvnRoute(),sameSessionAfterFiveSeconds:true};
})()
