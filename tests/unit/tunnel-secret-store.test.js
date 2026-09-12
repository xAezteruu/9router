import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../src/lib/tunnel/secretStore.js";

describe("secretStore — tunnel token encryption", () => {
  it("round-trips a cloudflared token", () => {
    const token = "eyJhIjoiYWJjIiwi d Gong".replace(/\s/g, "") + "x".repeat(200);
    const enc = encryptSecret(token);
    expect(enc).not.toBe(token);
    expect(enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptSecret(enc)).toBe(token);
  });

  it("produces different ciphertexts per call (random IV)", () => {
    const a = encryptSecret("same-secret");
    const b = encryptSecret("same-secret");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-secret");
    expect(decryptSecret(b)).toBe("same-secret");
  });

  it("returns null on tampered/garbage input", () => {
    expect(decryptSecret("garbage")).toBeNull();
    expect(decryptSecret("aa:bb:cc")).toBeNull();
    const enc = encryptSecret("secret");
    const parts = enc.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${"ff".repeat(10)}`;
    expect(decryptSecret(tampered)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });
});
