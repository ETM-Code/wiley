import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GuardDecision {
  allow: boolean;
  reason?: string;
  requiresExplicitConfirmation?: boolean;
}

const DESTRUCTIVE_VERBS = /\b(?:rm|rmdir|unlink|shred|truncate|mkfs(?:\.[a-z0-9]+)?|diskutil|dd|chmod|chown|find)\b/i;
const RECURSIVE_OR_FORCE = /(?:\s|^)-(?:[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r)(?:\s|$)|--recursive|--force|\s-delete\b|\beraseDisk\b|\bpartitionDisk\b/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

export class CatastrophicCommandGuard {
  readonly #hardProtected: string[];
  readonly #projectRoot: string;

  constructor(private readonly projectDir: string) {
    try {
      this.#projectRoot = realpathSync(projectDir);
    } catch {
      this.#projectRoot = path.resolve(projectDir);
    }
    this.#hardProtected = [
      path.parse(this.#projectRoot).root,
      os.homedir(),
      "/Users",
      "/System",
      "/Library",
      "/Applications",
      "/Volumes",
    ].map((entry) => path.resolve(entry));
  }

  inspect(command: string, cwd = this.projectDir): GuardDecision {
    const normalized = command.replace(/\s+/g, " ").trim();
    if (!normalized) return { allow: true };
    if (FORK_BOMB.test(normalized)) return this.#blocked("Fork bombs are never allowed");
    if (/\b(?:mkfs|diskutil\s+(?:erase|partition)|dd\s+.*\bof=\/dev\/|nvram\s+-c)\b/i.test(normalized)) {
      return this.#blocked("Disk, boot, and device destruction are never allowed");
    }
    if (/\b(?:security\s+delete-(?:keychain|generic-password)|rm\s+.*(?:Keychains|\.ssh|\.gnupg))\b/i.test(normalized)) {
      return this.#blocked("Credential-store destruction is never allowed");
    }
    if (!DESTRUCTIVE_VERBS.test(normalized)) return { allow: true };

    const candidates = this.#candidatePaths(normalized, cwd);
    for (const candidate of candidates) {
      const target = this.#resolveExistingPrefix(candidate);
      if (this.#isHardProtected(target)) {
        if (RECURSIVE_OR_FORCE.test(normalized) || /\b(?:truncate|shred|chmod|chown)\b/i.test(normalized)) {
          return this.#blocked(`Destructive operation targets protected path ${target}`);
        }
      }
      if (!this.#sameOrAncestor(target, this.#projectRoot) && RECURSIVE_OR_FORCE.test(normalized)) {
        return {
          allow: false,
          requiresExplicitConfirmation: true,
          reason: `Recursive destructive operation is outside the project: ${target}`,
        };
      }
    }
    return { allow: true };
  }

  #candidatePaths(command: string, cwd: string): string[] {
    const expanded = command
      .replace(/\$\{?HOME\}?|~/g, os.homedir())
      .replace(/\$\{?PWD\}?/g, cwd);
    return expanded
      .split(/[\s;&|]+/)
      .map((token) => token.replace(/^['"]|['"]$/g, ""))
      .filter((token) => token.startsWith("/") || token.startsWith(".") || token.includes("/"))
      .filter((token) => !token.startsWith("--"))
      .map((token) => token.replace(/[,*?\[\]{}]+.*$/, ""))
      .filter(Boolean)
      .map((token) => path.resolve(cwd, token));
  }

  #resolveExistingPrefix(candidate: string): string {
    let current = candidate;
    const suffix: string[] = [];
    while (!existsSync(current) && current !== path.dirname(current)) {
      suffix.unshift(path.basename(current));
      current = path.dirname(current);
    }
    try {
      return path.join(realpathSync(current), ...suffix);
    } catch {
      return candidate;
    }
  }

  #sameOrAncestor(target: string, ancestor: string): boolean {
    const relative = path.relative(ancestor, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  #isHardProtected(target: string): boolean {
    const [root, home, users, system, library, applications, volumes] = this.#hardProtected;
    if ([root, home, users, volumes].some((entry) => target === entry)) return true;
    return [system, library, applications].some((entry) => this.#sameOrAncestor(target, entry));
  }

  #blocked(reason: string): GuardDecision {
    return { allow: false, requiresExplicitConfirmation: false, reason };
  }
}

export const APPROVAL_PROMPT = `
You are a fast safety reviewer for a coding agent's tool calls. You see one
tool call plus the user's recent spoken requests. Approve almost everything:
normal edits, builds, tests, installs, and git commits are all fine. If the
user recently asked for exactly this action, approve it.

BLOCK only if the call could destroy data or systems (recursive deletes,
overwriting unrelated files, force pushes, touching paths outside the
project), leaks secrets or credentials, or clearly contradicts what the user
asked for.

Reply with exactly APPROVE, or BLOCK followed by one short sentence saying
what is wrong.
`.trim();

export interface ApprovalCall {
  tool: string;
  input: unknown;
  cwd: string;
  recentUserRequests: string[];
}

export type ApprovalCompletion = (request: {
  systemPrompt: string;
  userMessage: string;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * Claude Code-style permission prompt whose approver is a light critique
 * model instead of the user. It is a tripwire, not a gatekeeper: any judge
 * failure, timeout, or malformed verdict fails open so a broken judge can
 * never halt the agent.
 */
export class ApprovalJudge {
  constructor(private readonly complete: ApprovalCompletion) {}

  async review(call: ApprovalCall, signal?: AbortSignal): Promise<GuardDecision> {
    let verdict: string;
    try {
      verdict = (await this.complete({
        systemPrompt: APPROVAL_PROMPT,
        userMessage: JSON.stringify(call),
        signal,
      })).trim();
    } catch {
      return { allow: true };
    }
    if (!verdict.toUpperCase().startsWith("BLOCK")) return { allow: true };
    const reason = verdict.slice("BLOCK".length).replace(/^[\s:.-]+/, "").trim();
    return {
      allow: false,
      reason: reason || "The safety reviewer blocked this action.",
    };
  }
}

const READ_ONLY_COMMAND = /^(?:ls|pwd|cat|head|tail|wc|which|whoami|date|file|stat|du|df|grep|rg|find|fd|tree|env|printenv|echo|git\s+(?:status|log|diff|show|branch|remote|stash\s+list)|npm\s+(?:ls|view|outdated)|node\s+-[ve])(?:\s|$)/;

/** Cheap read-only commands never need a judge round-trip. */
export function isReadOnlyCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  // Redirection, substitution, and chaining can all write; only plain
  // pipelines of known read-only commands skip review.
  if (/[;&><`]|\$\(/.test(normalized)) return false;
  return normalized.split("|").every((segment) => READ_ONLY_COMMAND.test(segment.trim()));
}

/** Tracks successful reads so existing files cannot be overwritten blindly. */
export class ReadBeforeEditGuard {
  #read = new Set<string>();

  markRead(file: string): void {
    this.#read.add(path.resolve(file));
  }

  inspect(file: string): GuardDecision {
    const resolved = path.resolve(file);
    if (!existsSync(resolved) || this.#read.has(resolved)) return { allow: true };
    return { allow: false, reason: `You must read ${resolved} before modifying it.` };
  }
}
