// Development-only loopback fixture. Adds latency without inspecting payloads.
import http from 'node:http';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../example/package.json',import.meta.url));
const WebSocket=require('ws');
const WebSocketServer=WebSocket.Server;
const delay=Math.min(500,Math.max(0,Number(process.env.FRAME_DELAY_MS??30)));
const server=http.createServer((request,response)=>{
 const forwarded=http.request({host:'127.0.0.1',port:4001,path:request.url,method:request.method,headers:{...request.headers,host:'127.0.0.1:4001'}},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);});
 forwarded.on('error',()=>{response.writeHead(502);response.end();});request.pipe(forwarded);
});
const sockets=new WebSocketServer({noServer:true});
server.on('upgrade',(request,socket,head)=>{
 const upstream=new WebSocket('ws://127.0.0.1:4001'+request.url,{headers:{cookie:request.headers.cookie??'',origin:'http://127.0.0.1:4001'}});
 upstream.once('open',()=>sockets.handleUpgrade(request,socket,head,client=>{
  client.on('message',(data,binary)=>setTimeout(()=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(data,{binary:typeof binary === "boolean" ? binary : typeof data !== "string"});},delay));
  upstream.on('message',(data,binary)=>{if(client.readyState===WebSocket.OPEN)client.send(data,{binary:typeof binary === "boolean" ? binary : typeof data !== "string"});});
  client.on('close',()=>upstream.close());upstream.on('close',()=>client.close());
  client.on('error',()=>upstream.close());upstream.on('error',()=>client.close());
 }));
 upstream.on('error',()=>socket.destroy());
});
server.listen(4002,'127.0.0.1',()=>console.log(JSON.stringify({fixture:'latency-proxy',port:4002,frameDelayMs:delay})));
