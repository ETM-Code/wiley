import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolves the directory holding Wiley's own Pi skills.
 *
 * Packaged builds ship them as an extra resource next to the app bundle; in
 * development they live in the repo at .pi/skills, which the Pi SDK already
 * discovers on its own. Passing the path explicitly is additive either way,
 * because the resource loader de-dupes skills by name.
 *
 * Deliberately free of any Electron import: the browser backend has no
 * Electron, so the caller states whether it is packaged instead.
 */
export function resolveSkillsDir(options: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appRoot?: string;
} = {}): string {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (options.isPackaged && resourcesPath) {
    const packaged = path.join(resourcesPath, "skills");
    if (existsSync(packaged)) return packaged;
  }
  return path.join(options.appRoot ?? process.cwd(), ".pi", "skills");
}
