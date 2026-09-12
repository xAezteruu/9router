// Machine-keyed AES-256-GCM secret storage for tunnel credentials.
// Same trust model as mitm/manager.js: key derived from the machine ID (+ salt),
// so the ciphertext is only decryptable on the machine that stored it.
import crypto from "crypto";
import os from "os";

const ENCRYPT_ALGO = "aes-256-gcm";
const ENCRYPT_SALT = "9r-tunnel-token";

function deriveKey() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const raw = machineIdSync();
    return crypto.createHash("sha256").update(raw + ENCRYPT_SALT).digest();
  } catch {
    return crypto.createHash("sha256").update(ENCRYPT_SALT + os.hostname()).digest();
  }
}

export function encryptSecret(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored) {
  try {
    const [ivHex, tagHex, dataHex] = String(stored).split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}
