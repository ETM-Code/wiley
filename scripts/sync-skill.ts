#!/usr/bin/env tsx
/**
 * Rewrites the board-protocol block inside the live-excalidraw skill file from
 * the canonical prose in src/main/board-protocol.ts.
 *
 * The agent prompt has to carry the protocol inline (the Pi SDK gives the model
 * a skill's name, description, and path, never its body), so the skill file is
 * the copy that drifts. Run `npm run sync:skill` after editing the protocol;
 * tests/board-protocol.test.ts fails when the two disagree.
 *
 * Idempotent: a second run writes nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CANONICAL_BOARD_PROTOCOL,
	SKILL_BLOCK_BEGIN,
	SKILL_BLOCK_END,
} from "../src/main/board-protocol";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = path.join(repoRoot, ".pi", "skills", "live-excalidraw", "SKILL.md");

const current = readFileSync(skillPath, "utf8");
const begin = current.indexOf(SKILL_BLOCK_BEGIN);
const end = current.indexOf(SKILL_BLOCK_END);

if (begin === -1 || end === -1 || end < begin) {
	console.error(
		`${skillPath} is missing the ${SKILL_BLOCK_BEGIN} / ${SKILL_BLOCK_END} markers.`,
	);
	process.exit(1);
}

const block = `${SKILL_BLOCK_BEGIN}\n\n${CANONICAL_BOARD_PROTOCOL}\n\n`;
const next = current.slice(0, begin) + block + current.slice(end);

if (next === current) {
	console.log("SKILL.md already in sync.");
	process.exit(0);
}

writeFileSync(skillPath, next);
console.log(`Synced board protocol into ${path.relative(repoRoot, skillPath)}.`);
