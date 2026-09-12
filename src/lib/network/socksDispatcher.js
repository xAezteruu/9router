// SOCKS5 dispatcher for undici fetch (Tor etc.) — undici ProxyAgent is HTTP CONNECT only.
// Built from the already-installed `socks` + `undici` packages using undici's
// custom-connector contract: dial TCP through SOCKS, then hand the raw socket to
// buildConnector as `httpSocket` so it performs the TLS upgrade itself.
import { SocksClient } from "socks";

let _undici = null;
async function undiciModules() {
  if (!_undici) {
    const [agentMod, connectorMod] = await Promise.all([
      import("undici").then((m) => ({ Agent: m.Agent })),
      import("undici").then((m) => ({ buildConnector: m.buildConnector })),
    ]);
    _undici = { Agent: agentMod.Agent, buildConnector: connectorMod.buildConnector };
  }
  return _undici;
}

export function isSocksProxyUrl(proxyUrl) {
  return /^socks(4a?|5h?)?:\/\//i.test(String(proxyUrl || "").trim());
}

// Returns an undici Agent whose connections are dialed through the SOCKS5 proxy.
export async function createSocksDispatcher(proxyUrl) {
  const url = new URL(String(proxyUrl).trim());
  const proxy = {
    host: url.hostname,
    port: Number(url.port) || 9050,
    type: 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
  const { Agent, buildConnector } = await undiciModules();
  const connect = buildConnector({ timeout: 30_000 });

  return new Agent({
    connect: async (opts, callback) => {
      try {
        const port = Number(opts.port) || (opts.protocol === "https:" ? 443 : 80);
        const { socket } = await SocksClient.createConnection({
          proxy,
          command: "connect",
          destination: { host: opts.hostname, port },
          timeout: 30_000,
        });
        connect({ ...opts, httpSocket: socket }, callback);
      } catch (err) {
        callback(err, null);
      }
    },
  });
}
