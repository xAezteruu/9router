// Boot bootstrap from the proxy layer as well as layout.js.
// layout.js only runs when a PAGE is rendered — pure API usage (CLI tools,
// /v1 traffic, health checks) never mounts it, so initializeApp (tunnel
// auto-resume, watchdog) would never start on a server that only serves API
// traffic. Proxy middleware runs on every request, so the first request of
// any kind kicks off init exactly once (guarded by global.__appBootstrapped).
import "@/shared/services/bootstrap";
import { proxy as dashboardProxy } from "./dashboardGuard";

export default async function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
