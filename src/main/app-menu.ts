import type { MenuItemConstructorOptions } from "electron";

import type { ProjectView } from "../shared/contracts";

export interface AppMenuActions {
  /** Ask for a folder with the native picker, then open it. */
  openProject: () => void;
  openRecent: (path: string) => void;
}

/**
 * The Open Recent submenu, or a single dead entry saying there is nothing in
 * it. A folder that has since been moved or deleted stays listed and says so:
 * a name quietly disappearing is how a user concludes the app lost their work.
 */
function recentSubmenu(projects: ProjectView, actions: AppMenuActions): MenuItemConstructorOptions[] {
  if (projects.recent.length === 0) return [{ label: "No recent projects", enabled: false }];
  return projects.recent.map((entry) => ({
    label: entry.missing ? `${entry.name} (missing)` : entry.name,
    // macOS shows this under the label; elsewhere it is ignored, which costs
    // nothing and is worth it for telling two folders of the same name apart.
    sublabel: entry.path,
    toolTip: entry.path,
    enabled: !entry.missing,
    click: () => actions.openRecent(entry.path),
  }));
}

/**
 * Wiley had no application menu at all, which on macOS means the window gets
 * the default one: no Open Project, and no Edit menu either, so copy, paste
 * and select-all did nothing in any text field in the settings panel. The
 * roles below are what restores those; the File menu is the new part.
 */
export function appMenuTemplate(projects: ProjectView, actions: AppMenuActions): MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  return [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: () => actions.openProject() },
        { label: "Open Recent", submenu: recentSubmenu(projects, actions) },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
