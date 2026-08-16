import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { readAgentSettings, updateAgentSettings } from "../src/main/pi/settings-tools";
import { createPiTools, type PiToolHost } from "../src/main/pi/tools";
import { FileSecretStore } from "../src/main/settings/secret-store";
import { SettingsService } from "../src/main/settings/settings-service";
import { SettingsStore } from "../src/main/settings/settings-store";

/** A real store on a real temp directory: the round trip is the point. */
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "wiley-settings-tools-"));
  const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
  const service = new SettingsService({ store, env: {}, terminalApps: () => ["Terminal"] });
  const announced: string[] = [];
  return { dir, store, service, announced, deps: { service, announce: (m: string) => announced.push(m) } };
}

function persisted(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
}

/** The extra execute arguments a tool of this shape never looks at. */
async function runTool(tool: ToolDefinition, params: unknown): Promise<string> {
  const result = await tool.execute("call-1", params as never, undefined, undefined, {} as never);
  const first = result.content[0];
  return first.type === "text" ? first.text : "";
}

describe("readAgentSettings", () => {
  it("reports that a key exists without ever carrying its value", async () => {
    const { service, store } = harness();
    store.secrets.set("openaiApiKey", "sk-do-not-leak");
    const view = await readAgentSettings(service);
    expect(JSON.stringify(view)).not.toContain("sk-do-not-leak");
    expect(view.secrets.openaiApiKey).toEqual({
      present: true,
      source: "store",
      stored: true,
      backend: "file",
    });
  });

  it("is the same view the panel gets, probes and terminals included", async () => {
    const { service } = harness();
    const view = await readAgentSettings(service);
    expect(view.agent.model).toBe(service.settings.agent.model);
    expect(view.terminalApps).toEqual(["Terminal"]);
    expect(view.probes.claude.available).toBe(false);
  });
});

describe("updateAgentSettings", () => {
  it("persists the change and names the paths that moved", async () => {
    const { deps, dir, announced } = harness();
    const changed = await updateAgentSettings(deps, { agent: { fastMode: false } }, "Switched fast mode off.");
    expect(changed).toEqual(["agent.fastMode"]);
    expect(deps.service.settings.agent.fastMode).toBe(false);
    expect((persisted(dir).agent as Record<string, unknown>).fastMode).toBe(false);
    expect(announced).toEqual(["Switched fast mode off."]);
  });

  it("reaches nested worker settings and reports each leaf", async () => {
    const { deps } = harness();
    const changed = await updateAgentSettings(deps, { workers: { claude: { enabled: true, model: "haiku" } } });
    expect(changed.sort()).toEqual(["workers.claude.enabled", "workers.claude.model"]);
    expect(deps.service.settings.workers.claude.model).toBe("haiku");
  });

  it("clears an optional field back to the device default with null", async () => {
    const { deps } = harness();
    await updateAgentSettings(deps, { workers: { claude: { model: "haiku" } } });
    const changed = await updateAgentSettings(deps, { workers: { claude: { model: null } } });
    expect(changed).toEqual(["workers.claude.model"]);
    expect(deps.service.settings.workers.claude.model).toBeUndefined();
  });

  it("says nothing changed rather than announcing a no-op", async () => {
    const { deps, announced } = harness();
    expect(await updateAgentSettings(deps, { agent: { fastMode: true } })).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("reports only what normalization actually kept", async () => {
    const { deps, announced } = harness();
    // 99 is clamped to the maximum, and the bogus level is dropped entirely.
    const changed = await updateAgentSettings(deps, {
      agent: { thinkingLevel: "telepathic" as never },
      workers: { codex: { maxConcurrent: 99 } },
    });
    expect(changed).toEqual(["workers.codex.maxConcurrent"]);
    expect(deps.service.settings.workers.codex.maxConcurrent).toBe(8);
    expect(announced).toEqual(["Updated workers.codex.maxConcurrent."]);
  });

  it("falls back to naming the change when the agent wrote no summary", async () => {
    const { deps, announced } = harness();
    await updateAgentSettings(deps, { terminalApp: "Ghostty" });
    expect(announced).toEqual(["Updated terminalApp."]);
  });

  it("refuses any patch that names a secret, at any depth", async () => {
    const { deps, dir } = harness();
    await updateAgentSettings(deps, { agent: { fastMode: false } });
    const before = persisted(dir);
    for (const patch of [
      { secrets: { openaiApiKey: "sk-nope" } },
      { auth: { token: "sk-nope" } },
      { agent: { nested: { apiKey: "sk-nope" } } },
    ]) {
      await expect(updateAgentSettings(deps, patch)).rejects.toThrow(/cannot be changed this way/);
    }
    expect(persisted(dir)).toEqual(before);
  });

  it("refuses a patch that is not an object at all", async () => {
    const { deps } = harness();
    await expect(updateAgentSettings(deps, "fast mode off")).rejects.toThrow(/must be an object/);
    await expect(updateAgentSettings(deps, [{ agent: {} }])).rejects.toThrow(/must be an object/);
  });
});

describe("the settings tools on the agent surface", () => {
  const host = {} as PiToolHost;

  it("are offered to the root and withheld from subagents", () => {
    const rootNames = createPiTools(host, "root").map((tool) => tool.name);
    const subNames = createPiTools(host, "sub-1").map((tool) => tool.name);
    expect(rootNames).toContain("get_settings");
    expect(rootNames).toContain("update_settings");
    expect(subNames).not.toContain("get_settings");
    expect(subNames).not.toContain("update_settings");
  });

  it("hand the patch and the spoken summary straight to the host", async () => {
    const calls: Array<{ patch: unknown; summary?: string }> = [];
    const tools = createPiTools({
      ...host,
      readSettings: async () => ({ agent: { fastMode: true } }),
      writeSettings: async (patch, summary) => {
        calls.push({ patch, summary });
        return ["agent.fastMode"];
      },
    } as PiToolHost, "root");
    const get = tools.find((tool) => tool.name === "get_settings")!;
    const update = tools.find((tool) => tool.name === "update_settings")!;

    expect(JSON.parse(await runTool(get, {}))).toEqual({ agent: { fastMode: true } });

    const result = await runTool(update, {
      patch: { agent: { fastMode: false } },
      summary: "Switched fast mode off.",
    });
    expect(calls).toEqual([{ patch: { agent: { fastMode: false } }, summary: "Switched fast mode off." }]);
    expect(result).toContain("agent.fastMode");
  });

  it("says so plainly when a patch moved nothing", async () => {
    const tools = createPiTools({ ...host, writeSettings: async () => [] } as PiToolHost, "root");
    const update = tools.find((tool) => tool.name === "update_settings")!;
    expect(await runTool(update, { patch: {} })).toMatch(/Nothing changed/);
  });
});
