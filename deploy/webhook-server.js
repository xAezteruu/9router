#!/usr/bin/env node
// 9router deploy webhook — GitHub push -> verify secret -> trigger bgSwap.sh
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = 3102;
const SECRET = (fs.readFileSync("/home/agentuser/.hermes/.env","utf8").match(/^DEPLOY_WEBHOOK_SECRET=(.*)$/m) || [])[1];
const LOG = "/home/agentuser/9router/.webhook.log";
let running = false;

function log(m){ fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); }

http.createServer((req,res) => {
  if (req.method !== "POST") { res.writeHead(404); return res.end(); }
  let body = "";
  req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    // verify signature
    const sig = "sha256=" + crypto.createHmac("sha256", SECRET || "").update(body).digest("hex");
    if (!SECRET || req.headers["x-hub-signature-256"] !== sig) {
      log("REJECTED bad signature from " + req.socket.remoteAddress);
      res.writeHead(403); return res.end("forbidden");
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    if (req.headers["x-github-event"] !== "push") { res.writeHead(200); return res.end("ignored"); }
    if (payload.ref !== "refs/heads/master") { res.writeHead(200); return res.end("ignored ref"); }
    log(`push from ${payload.pusher?.login || "?"} — ${payload.head_commit?.id?.slice(0,8) || "?"} — ${payload.head_commit?.message?.slice(0,60) || ""}`);

    if (running) { res.writeHead(202); return res.end("deploy already running"); }
    running = true;
    res.writeHead(202); res.end("deploy triggered");

    const child = spawn("/home/agentuser/9router/deploy/bgSwap-panel.sh", ["1"], { detached: true, stdio: "ignore" });
    child.on("exit", c => { log(`bgSwap exit=${c}`); running = false; });
  });
}).listen(PORT, "127.0.0.1", () => log(`webhook listening :${PORT}`));
