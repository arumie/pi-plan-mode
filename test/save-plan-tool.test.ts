/**
 * Behavior checks for the save_plan extension tool.
 *
 * Run with: node --experimental-strip-types test/save-plan-tool.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../extensions/plan-mode/index.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

const tools = new Map<string, RegisteredTool>();
let persistedEntries = 0;

const pi = {
	registerFlag() {},
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
	registerShortcut() {},
	registerMessageRenderer() {},
	on() {
		return () => {};
	},
	appendEntry() {
		persistedEntries++;
	},
} as unknown as ExtensionAPI;

planModeExtension(pi);

const dir = await mkdtemp(join(tmpdir(), "pi-save-plan-tool-"));
const previousPlanDir = process.env.PI_PLAN_DIR;
process.env.PI_PLAN_DIR = dir;

try {
	const savePlan = tools.get("save_plan");
	assert.ok(savePlan, "save_plan should be registered");

	const result = await savePlan.execute(
		"test-call",
		{
			name: "Save Outside Plan Mode",
			content: "# Save Outside Plan Mode\n\nPlan:\n\n1. Save a plan without enabling plan mode.\n",
		},
		undefined,
		undefined,
		{ cwd: dir },
	);

	assert.equal(result.details.todos, 1);
	assert.match(result.content[0]?.text ?? "", /Saved plan to/);
	assert.equal(persistedEntries, 0, "saving outside plan mode must not change active plan state");

	const [filename] = await readdir(dir);
	assert.ok(filename, "the plan file should be created");
	assert.match(filename, /^\d{4}-\d{2}-\d{2}-save-outside-plan-mode\.md$/);
	const content = await readFile(join(dir, filename), "utf8");
	assert.match(content, /todos: \[{"step":1,"text":"Save a plan without enabling plan mode","completed":false}\]/);
	console.log("✓ save_plan works outside plan mode without mutating active plan state");
} finally {
	if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
	else process.env.PI_PLAN_DIR = previousPlanDir;
	await rm(dir, { recursive: true, force: true });
}
