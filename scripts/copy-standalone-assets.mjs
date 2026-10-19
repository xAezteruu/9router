import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // Native helper binaries used at runtime by tunnel/network features (fork):
  //  - cloudflared package binary (tunnel)
  //  - kmp-tor bundled Tor resources (socks proxy, extracted on demand)
  const pkgSource = resolve(projectRoot, "node_modules", "cloudflared", "bin");
  const pkgDest = resolve(standaloneDir, "node_modules", "cloudflared", "bin");
  if (existsSync(pkgSource)) {
    cpSync(pkgSource, pkgDest, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied cloudflared binary to ${pkgDest}`);
  }
  const torSource = resolve(projectRoot, "node_modules", "kmp-tor.resource-exec-tor.linux-libc");
  const torDest = resolve(standaloneDir, "node_modules", "kmp-tor.resource-exec-tor.linux-libc");
  if (existsSync(torSource)) {
    cpSync(torSource, torDest, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied kmp-tor resources to ${torDest}`);
  }

  // custom-server.js imports server modules by absolute path under its own
  // __dirname; next build only traces part of src/, so stage src/ and scripts/
  // into standalone or getGuardModule() answers 503 "guard unavailable".
  for (const dir of ["src", "scripts"]) {
    const dirSource = resolve(projectRoot, dir);
    const dirDestination = resolve(standaloneDir, dir);
    if (!existsSync(dirSource)) continue;
    rmSync(dirDestination, { recursive: true, force: true });
    cpSync(dirSource, dirDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied ${dir}/ to ${dirDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
