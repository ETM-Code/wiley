import { mkdtempSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSkillsDir } from "../src/main/skills";

function tempResources(withSkills: boolean): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "wiley-skills-"));
  if (withSkills) mkdirSync(path.join(root, "skills"));
  return root;
}

describe("resolveSkillsDir", () => {
  it("uses the repo's .pi/skills in development", () => {
    expect(resolveSkillsDir({ isPackaged: false, appRoot: "/repo" })).toBe(path.join("/repo", ".pi", "skills"));
  });

  it("uses the packaged resources directory when it exists", () => {
    const resourcesPath = tempResources(true);
    expect(resolveSkillsDir({ isPackaged: true, resourcesPath, appRoot: "/repo" }))
      .toBe(path.join(resourcesPath, "skills"));
  });

  it("falls back to the dev path when the packaged directory is missing", () => {
    const resourcesPath = tempResources(false);
    expect(resolveSkillsDir({ isPackaged: true, resourcesPath, appRoot: "/repo" }))
      .toBe(path.join("/repo", ".pi", "skills"));
  });

  it("falls back to the dev path when there is no resources path at all", () => {
    expect(resolveSkillsDir({ isPackaged: true, resourcesPath: undefined, appRoot: "/repo" }))
      .toBe(path.join("/repo", ".pi", "skills"));
  });

  it("defaults the app root to the working directory", () => {
    expect(resolveSkillsDir()).toBe(path.join(process.cwd(), ".pi", "skills"));
  });
});
