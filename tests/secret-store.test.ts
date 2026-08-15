import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSecretStore,
  FileSecretStore,
  isLoopbackHost,
  resolveOpenAiKey,
  SafeStorageSecretStore,
  type SafeStorageLike,
} from "../src/main/settings/secret-store";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wiley-secrets-"));
  created.push(dir);
  return dir;
}

/** Reversible stand-in for Electron's safeStorage: enough to prove round-trips. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not our ciphertext");
      return text.slice(4);
    },
  };
}

afterEach(() => {
  created.length = 0;
});

describe("FileSecretStore", () => {
  it("round-trips a secret and reports it in describe", () => {
    const store = new FileSecretStore({ dir: tempDir() });
    expect(store.get("openaiApiKey")).toBeUndefined();
    expect(store.describe().openaiApiKey).toEqual({ present: false, backend: "file" });
    store.set("openaiApiKey", "  sk-test-123  ");
    expect(store.get("openaiApiKey")).toBe("sk-test-123");
    expect(store.describe().openaiApiKey).toEqual({ present: true, backend: "file" });
    store.clear("openaiApiKey");
    expect(store.get("openaiApiKey")).toBeUndefined();
  });

  it("writes the secrets file owner-only", () => {
    const dir = tempDir();
    new FileSecretStore({ dir }).set("openaiApiKey", "sk-test-123");
    const mode = statSync(path.join(dir, "secrets.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps other secrets when one is cleared", () => {
    const store = new FileSecretStore({ dir: tempDir() });
    store.set("openaiApiKey", "sk-a");
    store.set("cloudSessionToken", "tok-b");
    store.clear("openaiApiKey");
    expect(store.get("cloudSessionToken")).toBe("tok-b");
  });

  it("refuses to store a secret behind a non-loopback listener", () => {
    const store = new FileSecretStore({ dir: tempDir(), host: "0.0.0.0" });
    expect(() => store.set("openaiApiKey", "sk-test")).toThrow(/0\.0\.0\.0/);
    expect(store.get("openaiApiKey")).toBeUndefined();
  });

  it("stores behind a non-loopback listener once the caller opts in", () => {
    const store = new FileSecretStore({ dir: tempDir(), host: "0.0.0.0", allowRemoteHost: true });
    store.set("openaiApiKey", "sk-test");
    expect(store.get("openaiApiKey")).toBe("sk-test");
  });

  it("allows loopback hosts without an opt-in", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      const store = new FileSecretStore({ dir: tempDir(), host });
      store.set("openaiApiKey", "sk-test");
      expect(store.get("openaiApiKey")).toBe("sk-test");
    }
  });

  it("rejects an empty value rather than storing a blank secret", () => {
    const store = new FileSecretStore({ dir: tempDir() });
    expect(() => store.set("openaiApiKey", "   ")).toThrow(/empty/);
  });

  it("treats a corrupt secrets file as empty", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "secrets.json"), "{not json", { mode: 0o600 });
    const store = new FileSecretStore({ dir });
    expect(store.get("openaiApiKey")).toBeUndefined();
    store.set("openaiApiKey", "sk-recovered");
    expect(store.get("openaiApiKey")).toBe("sk-recovered");
  });
});

describe("SafeStorageSecretStore", () => {
  it("never writes the plaintext to disk", () => {
    const dir = tempDir();
    const store = new SafeStorageSecretStore({ dir, safeStorage: fakeSafeStorage() });
    store.set("openaiApiKey", "sk-secret-value");
    const raw = readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(raw).not.toContain("sk-secret-value");
    expect(store.get("openaiApiKey")).toBe("sk-secret-value");
    expect(store.describe().openaiApiKey).toEqual({ present: true, backend: "safeStorage" });
  });

  it("returns undefined when the ciphertext cannot be decrypted here", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "secrets.json"),
      JSON.stringify({ openaiApiKey: { enc: "safeStorage", value: Buffer.from("garbage").toString("base64") } }),
      { mode: 0o600 },
    );
    const store = new SafeStorageSecretStore({ dir, safeStorage: fakeSafeStorage() });
    expect(store.get("openaiApiKey")).toBeUndefined();
  });

  it("refuses to construct when encryption is unavailable", () => {
    expect(() => new SafeStorageSecretStore({ dir: tempDir(), safeStorage: fakeSafeStorage(false) }))
      .toThrow(/unavailable/);
  });
});

describe("createSecretStore", () => {
  it("uses safeStorage when it is available", () => {
    expect(createSecretStore({ dir: tempDir(), safeStorage: fakeSafeStorage() }).backend).toBe("safeStorage");
  });

  it("falls back to the file store and says so", () => {
    expect(createSecretStore({ dir: tempDir(), safeStorage: fakeSafeStorage(false) }).backend).toBe("file");
    expect(createSecretStore({ dir: tempDir() }).backend).toBe("file");
  });
});

describe("resolveOpenAiKey", () => {
  it("prefers the environment over the store", () => {
    const store = new FileSecretStore({ dir: tempDir() });
    store.set("openaiApiKey", "sk-stored");
    expect(resolveOpenAiKey({ env: { OPENAI_API_KEY: "sk-env" }, store }))
      .toEqual({ key: "sk-env", source: "env", envOverride: true });
  });

  it("reads the store when the environment is empty", () => {
    const store = new FileSecretStore({ dir: tempDir() });
    store.set("openaiApiKey", "sk-stored");
    expect(resolveOpenAiKey({ env: { OPENAI_API_KEY: "  " }, store }))
      .toEqual({ key: "sk-stored", source: "store", envOverride: false });
  });

  it("reports no source when nothing is configured", () => {
    expect(resolveOpenAiKey({ env: {}, store: new FileSecretStore({ dir: tempDir() }) }))
      .toEqual({ source: "none", envOverride: false });
    expect(resolveOpenAiKey({})).toEqual({ source: "none", envOverride: false });
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback addresses and nothing else", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("LocalHost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.4")).toBe(false);
    expect(isLoopbackHost("wiley.example.com")).toBe(false);
  });
});
