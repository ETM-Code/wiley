import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOARD_AGENT_SYSTEM_PROMPT } from "../src/main/agent-prompt";
import {
	CANONICAL_BOARD_PROTOCOL,
	SKILL_BLOCK_BEGIN,
	SKILL_BLOCK_END,
} from "../src/main/board-protocol";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(repoRoot, ".pi", "skills", "live-excalidraw", "SKILL.md");

/**
 * The prompt is the only place the board protocol reaches the model, so every
 * paragraph added here is paid for on every single turn. The cap is roughly
 * 12% above the prompt's size when this budget was set (~8,900 characters):
 * enough room for a rule or two, loud enough to stop a pasted essay.
 */
const BOARD_AGENT_PROMPT_BUDGET = 10_000;

describe("board protocol single-sourcing", () => {
	it("keeps the skill file's generated block identical to the canonical protocol", () => {
		const skill = readFileSync(skillPath, "utf8");
		const begin = skill.indexOf(SKILL_BLOCK_BEGIN);
		const end = skill.indexOf(SKILL_BLOCK_END);

		expect(begin, "SKILL.md is missing the BEGIN marker").toBeGreaterThan(-1);
		expect(end, "SKILL.md is missing the END marker").toBeGreaterThan(begin);

		const block = skill.slice(begin + SKILL_BLOCK_BEGIN.length, end).trim();
		// Drift means someone edited one copy; run `npm run sync:skill`.
		expect(block).toBe(CANONICAL_BOARD_PROTOCOL);
	});

	it("keeps the skill's own frontmatter and unique guidance intact", () => {
		const skill = readFileSync(skillPath, "utf8");
		expect(skill.startsWith("---\nname: live-excalidraw\n")).toBe(true);
		expect(skill).toContain("description: Inspect, understand, and safely edit the live Excalidraw board");
		expect(skill).toContain("## Hand-drawn wireframes");
		expect(skill).toContain("place_image");
	});

	it("states the canonical protocol verbatim in the root prompt", () => {
		expect(BOARD_AGENT_SYSTEM_PROMPT).toContain(CANONICAL_BOARD_PROTOCOL.split("\n\n")[0]);
	});
});

describe("diagram decision rules", () => {
	it.each([
		["create versus evolve", "draw_diagram creates, update_diagram evolves"],
		["never redraw an owned diagram", "Never redraw a diagram you"],
		["merge is the default update mode", "merge is the default update mode"],
		["layout must be re-passed", "layout is not reconstructed from the board"],
		["containers group real subsystems", "Group real subsystems with containers"],
		["two levels of nesting at most", "Two levels at most, frames top level only"],
		["one layout per graph", "Pick one layout and let it work"],
		["layered for pipelines and decisions", "layered RIGHT for pipelines, layered DOWN"],
		["tree and radial shapes", "tree for org charts and mind maps, radial for"],
		["containers force layered", "Containers force layered"],
		["one theme per board", "One theme per board"],
		["roles over invented colours", "Give nodes roles instead of invented hex colours"],
		["a tight palette", "About one fill per two nodes and eight at the"],
		["colour as a category", "a fill is a category, so one kind takes one role"],
	])("tells the root agent about %s", (_name, rule) => {
		expect(BOARD_AGENT_SYSTEM_PROMPT).toContain(rule);
	});
});

describe("prompt budget", () => {
	it("keeps the root prompt inside its character budget", () => {
		expect(BOARD_AGENT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(BOARD_AGENT_PROMPT_BUDGET);
	});

	it("points at the available_skills list rather than a development-only path", () => {
		expect(BOARD_AGENT_SYSTEM_PROMPT).toContain("listed in <available_skills>");
		expect(BOARD_AGENT_SYSTEM_PROMPT).not.toContain(".pi/skills");
	});
});
