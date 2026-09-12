import { describe, it, expect } from "vitest";
import { isSocksProxyUrl, createSocksDispatcher } from "../../src/lib/network/socksDispatcher.js";
import { createDispatcher } from "../../src/lib/network/proxyTest.js";

describe("socksDispatcher — Tor/SOCKS5 support in proxy pools", () => {
  it("detects socks URLs", () => {
    expect(isSocksProxyUrl("socks5://127.0.0.1:9050")).toBe(true);
    expect(isSocksProxyUrl("socks5h://user:pass@127.0.0.1:9050")).toBe(true);
    expect(isSocksProxyUrl("socks://127.0.0.1:9050")).toBe(true);
    expect(isSocksProxyUrl("http://127.0.0.1:7897")).toBe(false);
    expect(isSocksProxyUrl("")).toBe(false);
    expect(isSocksProxyUrl(null)).toBe(false);
  });

  it("builds an undici-compatible SOCKS dispatcher (credentials + default Tor port)", async () => {
    const d = await createSocksDispatcher("socks5://127.0.0.1:9050");
    expect(typeof d.dispatch).toBe("function");
    await d.close?.();

    const d2 = await createSocksDispatcher("socks5://user:secret@127.0.0.1:9150");
    expect(typeof d2.dispatch).toBe("function");
    await d2.close?.();
  });

  it("proxyTest createDispatcher routes socks5 to SOCKS dispatcher and http to ProxyAgent", async () => {
    const socks = await createDispatcher("socks5://127.0.0.1:9050");
    expect(typeof socks.dispatch).toBe("function");
    await socks.close?.();
    const http = await createDispatcher("http://127.0.0.1:7897");
    expect(http).toBeTruthy();
    await http.close?.();
  });
});
