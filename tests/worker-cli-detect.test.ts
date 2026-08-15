import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  augmentPath,
  compareVersions,
  meetsMinimumVersion,
  parseCliVersion,
  probeCli,
  probeWorkerClis,
  resolveWorkerCommand,
  workerEnv,
  workerPathDirs,
  type CliExecResult,
  type CliProbeRunner,
} from "../src/main/workers/cli-detect";
import { DEFAULT_SETTINGS } from "../src/main/settings/settings-schema";

const HOME = "/Users/tester";

interface FakeRunnerOptions {
  versions?: Record<string, string>;
  missing?: string[];
  files?: string[];
  keychain?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function fakeRunner(options: FakeRunnerOptions = {}): CliProbeRunner & { calls: string[] } {
  const calls: string[] = [];
  const versions = options.versions ?? { claude: "2.1.233 (Claude Code)", codex: "codex-cli 0.147.0" };
  return {
    calls,
    async exec(command, args): Promise<CliExecResult> {
      calls.push([command, ...args].join(" "));
      if (command === "security") {
        return { code: options.keychain ? 0 : 44, stdout: "", stderr: "" };
      }
      const name = path.basename(command);
      if (options.missing?.includes(name)) {
        return { code: null, stdout: "", stderr: "", error: "ENOENT" };
      }
      const output = versions[name];
      if (!output) return { code: 127, stdout: "", stderr: "not found" };
      return { code: 0, stdout: `${output}\n`, stderr: "" };
    },
    async which(command) {
      return `/opt/homebrew/bin/${path.basename(command)}`;
    },
    fileExists: (file) => (options.files ?? []).includes(file),
    homedir: () => HOME,
    platform: () => options.platform ?? "darwin",
    env: () => options.env ?? {},
  };
}

const CLAUDE_CREDENTIALS = path.join(HOME, ".claude", ".credentials.json");
const CODEX_CREDENTIALS = path.join(HOME, ".codex", "auth.json");

describe("version parsing and gating", () => {
  it("reads the version triple out of either CLI's banner", () => {
    expect(parseCliVersion("2.1.233 (Claude Code)")).toBe("2.1.233");
    expect(parseCliVersion("codex-cli 0.147.0")).toBe("0.147.0");
    expect(parseCliVersion("no numbers here")).toBeUndefined();
  });

  it("orders versions numerically rather than lexically", () => {
    expect(compareVersions("2.10.0", "2.9.0")).toBe(1);
    expect(compareVersions("0.147.0", "0.147.0")).toBe(0);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(meetsMinimumVersion("2.0.0", "2.0.0")).toBe(true);
    expect(meetsMinimumVersion("1.99.99", "2.0.0")).toBe(false);
  });
});

describe("PATH augmentation", () => {
  it("adds the directories these CLIs install into, in order, without duplicates", () => {
    const augmented = augmentPath("/usr/bin:/opt/homebrew/bin", HOME);
    expect(augmented.split(path.delimiter)).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
      path.join(HOME, ".local", "bin"),
      "/usr/local/bin",
    ]);
  });

  it("still produces a usable PATH when the host had none", () => {
    expect(augmentPath(undefined, HOME).split(path.delimiter)).toEqual(workerPathDirs(HOME));
  });

  it("leaves the rest of the environment alone", () => {
    const env = workerEnv({ HOME: "/x", PATH: "/usr/bin" }, HOME);
    expect(env.HOME).toBe("/x");
    expect(env.PATH).toContain("/usr/local/bin");
  });
});

describe("probeCli", () => {
  it("reports an installed, signed-in claude as available", async () => {
    const probe = await probeCli("claude", undefined, fakeRunner({ files: [CLAUDE_CREDENTIALS] }));
    expect(probe).toEqual({ available: true, version: "2.1.233", path: "/opt/homebrew/bin/claude" });
  });

  it("accepts a keychain login when no credentials file exists", async () => {
    const runner = fakeRunner({ keychain: true });
    const probe = await probeCli("claude", undefined, runner);

    expect(probe.available).toBe(true);
    // Metadata only: never the -g flag, which would read the secret itself.
    const lookup = runner.calls.find((call) => call.startsWith("security "));
    expect(lookup).toBe('security find-generic-password -s Claude Code-credentials');
  });

  it("calls a missing binary unavailable with a fixable reason", async () => {
    const probe = await probeCli("codex", undefined, fakeRunner({ missing: ["codex"] }));

    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("could not be run");
    expect(probe.version).toBeUndefined();
  });

  it("gates an old CLI and says which version is needed", async () => {
    const probe = await probeCli("codex", undefined, fakeRunner({
      versions: { codex: "codex-cli 0.139.9" },
      files: [CODEX_CREDENTIALS],
    }));

    expect(probe).toMatchObject({ available: false, version: "0.139.9" });
    expect(probe.reason).toContain("0.140.0");
  });

  it("separates installed-but-signed-out from missing", async () => {
    const probe = await probeCli("codex", undefined, fakeRunner({ files: [] }));

    expect(probe).toMatchObject({ available: false, version: "0.147.0" });
    expect(probe.reason).toContain("not signed in");
  });

  it("accepts an API key in the environment as a login", async () => {
    const codex = await probeCli("codex", undefined, fakeRunner({ env: { OPENAI_API_KEY: "x" } }));
    const claude = await probeCli("claude", undefined, fakeRunner({ env: { ANTHROPIC_API_KEY: "x" } }));

    expect(codex.available).toBe(true);
    expect(claude.available).toBe(true);
  });

  it("never consults the macOS keychain on another platform", async () => {
    const runner = fakeRunner({ platform: "linux" });
    const probe = await probeCli("claude", undefined, runner);

    expect(probe.available).toBe(false);
    expect(runner.calls.some((call) => call.startsWith("security"))).toBe(false);
  });

  it("probes the explicit command from settings instead of the default name", async () => {
    const runner = fakeRunner({
      versions: { "claude-dev": "2.4.0 (Claude Code)" },
      files: [CLAUDE_CREDENTIALS],
    });
    const probe = await probeCli("claude", { ...DEFAULT_SETTINGS.workers.claude, command: "/opt/bin/claude-dev" }, runner);

    expect(probe).toMatchObject({ available: true, version: "2.4.0" });
    expect(runner.calls[0]).toBe("/opt/bin/claude-dev --version");
  });

  it("falls back to the default command name when settings name none", () => {
    expect(resolveWorkerCommand("claude", undefined)).toBe("claude");
    expect(resolveWorkerCommand("codex", { ...DEFAULT_SETTINGS.workers.codex, command: "  " })).toBe("codex");
  });

  it("runs the probe with the augmented PATH, not the bare host one", async () => {
    let seen: string | undefined;
    const base = fakeRunner({ files: [CLAUDE_CREDENTIALS], env: { PATH: "/usr/bin" } });
    const runner: CliProbeRunner = {
      ...base,
      exec: (command, args, options) => {
        seen ??= options.env.PATH;
        return base.exec(command, args, options);
      },
    };
    await probeCli("claude", undefined, runner);

    expect(seen).toContain(path.join(HOME, ".local", "bin"));
  });
});

describe("probeWorkerClis", () => {
  it("answers for every configured worker kind at once", async () => {
    const probes = await probeWorkerClis(DEFAULT_SETTINGS, fakeRunner({
      files: [CLAUDE_CREDENTIALS, CODEX_CREDENTIALS],
    }));

    expect(Object.keys(probes).sort()).toEqual(["claude", "codex"]);
    expect(probes.claude.available).toBe(true);
    expect(probes.codex.available).toBe(true);
  });

  it("reports one kind unavailable without hiding the other", async () => {
    const probes = await probeWorkerClis(DEFAULT_SETTINGS, fakeRunner({
      missing: ["claude"],
      files: [CODEX_CREDENTIALS],
    }));

    expect(probes.claude.available).toBe(false);
    expect(probes.codex.available).toBe(true);
  });
});
