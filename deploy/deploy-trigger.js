#!/usr/bin/env node
// host-side deploy trigger :3107 (loopback+tailscale only) — spawns bgSwap-panel.sh
const http=require("http"),{spawn}=require("child_process"),fs=require("fs");
const LOG="/home/agentuser/9router/.webhook.log";let running=false;
const log=m=>fs.appendFileSync(LOG,`[${new Date().toISOString()}] ${m}\n`);
http.createServer((req,res)=>{
  if(req.method!=="POST"){res.writeHead(404);return res.end();}
  if(req.socket.remoteAddress&&!/^127\.|^100\.64\./.test(req.socket.remoteAddress)){res.writeHead(403);return res.end();}
  if(running){res.writeHead(202);return res.end("deploy already running");}
  running=true;res.writeHead(202);res.end("deploy triggered");
  log("host trigger fired");
  const c=spawn("/home/agentuser/9router/deploy/bgSwap-panel.sh",["1"],{detached:true,stdio:"ignore"});
  c.on("exit",code=>{log(`bgSwap-panel exit=${code}`);running=false;});
}).listen(3107,"0.0.0.0",()=>log("host trigger listening :3107"));
