// Re-export hub: existing consumers import the tunnel service from "@/lib/tunnel";
// updater functions live in cloudflaredUpdater.js, everything else in cloudflared.js.
export {
  killCloudflared,
  isCloudflaredRunning,
  ensureCloudflared,
  getDownloadStatus,
  getInstalledCloudflaredVersion,
} from "./cloudflared.js";
export { checkCloudflaredUpdate, updateCloudflared } from "./cloudflaredUpdater.js";
