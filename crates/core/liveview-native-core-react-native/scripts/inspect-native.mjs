import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../example/package.json', import.meta.url));
const WebSocket = require('ws');
const targets = await (await fetch('http://127.0.0.1:8081/json/list')).json();
const target = targets.find(t => !process.env.DEVICE || t.deviceName.includes(process.env.DEVICE));
if (!target) throw new Error('No live React Native inspector target');
const socket = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://127.0.0.1:8081' } });
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=event=>reject(event.error ?? event);});
let next=0; const pending=new Map();
socket.onmessage=event=>{const response=JSON.parse(event.data); if(response.id) pending.get(response.id)?.(response);};
async function request(method,params){const id=++next; const result=new Promise(resolve=>pending.set(id,resolve)); socket.send(JSON.stringify({id,method,params})); return result;}
try {
 await request('Runtime.enable',{});
 const expression = process.argv[2] === '--file' ? readFileSync(process.argv[3], 'utf8') : (process.argv[2] ?? 'JSON.stringify(globalThis.__lvnTelemetry?.())');
 const wrapped = `globalThis.__lvnResult=undefined; Promise.resolve(${expression}).then(value=>globalThis.__lvnResult={ok:true,value}, error=>globalThis.__lvnResult={ok:false,error:String(error)}); undefined`;
 const evaluated = await request('Runtime.evaluate',{expression:wrapped,returnByValue:true});
 if(evaluated.error || evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.error ?? evaluated.result.exceptionDetails));
 const end=Date.now()+20000; let value;
 while (Date.now()<end) {
   const result=await request('Runtime.evaluate',{expression:'JSON.stringify(globalThis.__lvnResult)',returnByValue:true});
   const encoded=result.result?.result?.value;
   if(encoded){value=JSON.parse(encoded); break;}
   await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!value)throw new Error('Native evaluation timed out');
 console.log(JSON.stringify(value,null,2));
 if(!value.ok)process.exitCode=1;
} finally {socket.close();}
