import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { appMenuTemplate } from "../src/main/app-menu";
import type { ProjectView } from "../src/shared/contracts";

function entry(name: string, missing = false) {
  return { path: `/work/${name}`, name, lastOpenedAt: "2026-01-01T00:00:00.000Z", missing };
}

function submenuOf(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const item = template.find((option) => option.label === label);
  return (item?.submenu ?? []) as MenuItemConstructorOptions[];
}

function build(projects: Partial<ProjectView> = {}) {
  const actions = { openProject: vi.fn(), openRecent: vi.fn() };
  const template = appMenuTemplate({ recent: [], canOpen: true, ...projects }, actions);
  return { template, actions, file: submenuOf(template, "File") };
}

describe("appMenuTemplate", () => {
  // Without an application menu macOS gives the window the default one, which
  // has no Edit menu, so copy and paste stop working in every text field.
  it("keeps the standard menus a text field depends on", () => {
    const { template } = build();
    expect(template.map((item) => item.role)).toContain("editMenu");
    expect(template.map((item) => item.role)).toContain("windowMenu");
  });

  it("puts Open Project on the usual accelerator", () => {
    const { file, actions } = build();
    const open = file.find((item) => item.label === "Open Project…");
    expect(open?.accelerator).toBe("CmdOrCtrl+O");
    open?.click?.(undefined as never, undefined, undefined as never);
    expect(actions.openProject).toHaveBeenCalledTimes(1);
  });

  it("lists recent projects by folder name and opens the one clicked", () => {
    const { file, actions } = build({ recent: [entry("app"), entry("notes")] });
    const recent = submenuOf(file, "Open Recent");
    expect(recent.map((item) => item.label)).toEqual(["app", "notes"]);
    expect(recent[0].sublabel).toBe("/work/app");
    recent[1].click?.(undefined as never, undefined, undefined as never);
    expect(actions.openRecent).toHaveBeenCalledWith("/work/notes");
  });

  // A name quietly disappearing is how a user concludes the app lost their
  // work, so a folder that has moved stays listed and says why it is dead.
  it("keeps a project that is gone, disabled and labelled", () => {
    const { file } = build({ recent: [entry("gone", true)] });
    const recent = submenuOf(file, "Open Recent");
    expect(recent[0]).toMatchObject({ label: "gone (missing)", enabled: false });
  });

  it("says so rather than offering an empty submenu", () => {
    const recent = submenuOf(build().file, "Open Recent");
    expect(recent).toEqual([{ label: "No recent projects", enabled: false }]);
  });
});
