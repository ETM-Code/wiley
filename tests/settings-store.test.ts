import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FileSecretStore } from "../src/main/settings/secret-store";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, type WileySettings } from "../src/main/settings/settings-schema";
import { resolveConfigDir, SettingsStore } from "../src/main/settings/settings-store";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "wiley-settings-"));
}

function readFile(dir: string): WileySettings {
  return JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as WileySettings;
}

describe("SettingsStore.open", () => {
  it("starts from defaults and writes nothing until asked", () => {
    const dir = tempDir();
    const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(path.join(dir, "settings.json"))).toBe(false);
  });

  it("loads and normalizes an existing file", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ version: 1, agent: { fastMode: false, thinkingLevel: "nonsense" }, junk: 1 }),
    );
    const settings = SettingsStore.open(dir, new FileSecretStore({ dir })).get();
    expect(settings.agent.fastMode).toBe(false);
    expect(settings.agent.thinkingLevel).toBe("medium");
    expect((settings as unknown as Record<string, unknown>).junk).toBeUndefined();
  });

  it("migrates a versionless file on load", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ voice: { voice: "cedar" } }));
    const settings = SettingsStore.open(dir, new FileSecretStore({ dir })).get();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.voice.voice).toBe("cedar");
  });

  it("backs up a corrupt file and carries on with defaults", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "settings.json"), "{ half a file");
    const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(readFileSync(path.join(dir, "settings.json.bad"), "utf8")).toBe("{ half a file");
  });

  it("creates the directory when it does not exist yet", () => {
    const dir = path.join(tempDir(), "nested", "config");
    expect(SettingsStore.open(dir).get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("SettingsStore.update", () => {
  it("persists a merged, normalized snapshot", () => {
    const dir = tempDir();
    const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
    const next = store.update({ agent: { fastMode: false }, workers: { codex: { enabled: true } } });
    expect(next.agent.fastMode).toBe(false);
    expect(next.workers.codex.enabled).toBe(true);
    expect(store.get()).toEqual(next);
    expect(readFile(dir)).toEqual(next);
  });

  it("survives a reopen", () => {
    const dir = tempDir();
    SettingsStore.open(dir).update({ voice: { model: "gpt-realtime-mini-2.1" } });
    expect(SettingsStore.open(dir).get().voice.model).toBe("gpt-realtime-mini-2.1");
  });

  it("leaves no temp file behind", () => {
    const dir = tempDir();
    SettingsStore.open(dir).update({ agent: { fastMode: false } });
    expect(existsSync(path.join(dir, `settings.json.${process.pid}.tmp`))).toBe(false);
  });

  it("rejects an invalid patch value by normalizing it away", () => {
    const store = SettingsStore.open(tempDir());
    const next = store.update({ agent: { thinkingLevel: "telepathic" as never } });
    expect(next.agent.thinkingLevel).toBe(DEFAULT_SETTINGS.agent.thinkingLevel);
  });
});

describe("SettingsStore.onChange", () => {
  it("notifies subscribers with the new snapshot and stops on unsubscribe", () => {
    const store = SettingsStore.open(tempDir());
    const seen: boolean[] = [];
    const unsubscribe = store.onChange((settings) => seen.push(settings.agent.fastMode));
    store.update({ agent: { fastMode: false } });
    store.update({ agent: { fastMode: true } });
    unsubscribe();
    store.update({ agent: { fastMode: false } });
    expect(seen).toEqual([false, true]);
  });

  it("keeps notifying the remaining listeners when one throws", () => {
    const store = SettingsStore.open(tempDir());
    const seen: string[] = [];
    store.onChange(() => {
      throw new Error("bad listener");
    });
    store.onChange((settings) => seen.push(settings.voice.voice));
    store.update({ voice: { voice: "cedar" } });
    expect(seen).toEqual(["cedar"]);
  });
});

describe("resolveConfigDir", () => {
  it("prefers WILEY_CONFIG_DIR", () => {
    expect(resolveConfigDir({ env: { WILEY_CONFIG_DIR: "/tmp/wiley-config" }, home: "/home/x" }))
      .toBe("/tmp/wiley-config");
  });

  it("falls back to ~/.wiley", () => {
    expect(resolveConfigDir({ env: {}, home: "/home/x" })).toBe("/home/x/.wiley");
    expect(resolveConfigDir({ env: { WILEY_CONFIG_DIR: "   " }, home: "/home/x" })).toBe("/home/x/.wiley");
  });
});
