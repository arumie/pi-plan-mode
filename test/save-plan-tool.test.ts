/**
 * Behavior checks for the save_plan extension tool.
 *
 * Run with: node --experimental-strip-types test/save-plan-tool.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planModeExtension from "../extensions/plan-mode/index.ts";
import { parseFrontmatter } from "../extensions/plan-mode/utils.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
	handler: (...args: any[]) => Promise<any>;
}

const tools = new Map<string, RegisteredTool>();
const commands = new Map<string, RegisteredCommand>();
const handlers = new Map<string, (...args: any[]) => Promise<any>>();
let activeTools = [
	"read", "bash", "write", "edit", "list_plans", "update_plan", "anchor_grep",
	"replace", "replace_within", "insert", "copy", "move", "undo_last_change",
];
let persistedEntries = 0;

const pi = {
	registerFlag() {},
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
	registerCommand(name: string, command: RegisteredCommand) {
		commands.set(name, command);
	},
	registerShortcut() {},
	registerMessageRenderer() {},
	on(name: string, handler: (...args: any[]) => Promise<any>) {
		handlers.set(name, handler);
		return () => {};
	},
	getFlag() {
		return false;
	},
	getActiveTools() {
		return activeTools;
	},
	setActiveTools(toolNames: string[]) {
		activeTools = toolNames;
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
	const listPlans = tools.get("list_plans");
	assert.ok(listPlans, "list_plans should be registered");
	const updatePlan = tools.get("update_plan");
	assert.ok(updatePlan, "update_plan should be registered");
	assert.ok(activeTools.includes("list_plans"), "list_plans should be available in normal mode");
	assert.ok(activeTools.includes("update_plan"), "update_plan should be available in normal mode");

	const secondSave = await savePlan.execute(
		"second-save-call",
		{ name: "Leave Other Plan Alone", content: "# Leave Other Plan Alone\n\nPlan:\n\n1. Keep this other saved plan unchanged.\n" },
		undefined,
		undefined,
		{ cwd: dir },
	);
	const listed = await listPlans.execute("list-call", {}, undefined, undefined, { cwd: dir });
	assert.equal(listed.details.plans.length, 2, "list_plans returns all saved plans");
	assert.ok(listed.details.plans.some((plan: any) => plan.name === filename && plan.path === join(dir, filename)));
	assert.match(listed.content[0]?.text ?? "", new RegExp(filename));
	assert.ok(listed.content[0]?.text.includes(secondSave.details.path));

	const outsideUpdate = await updatePlan.execute(
		"targeted-update-call",
		{ plan: filename, sectionAppends: [{ section: "notes", text: "Updated only the selected saved plan." }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(outsideUpdate.details.path, join(dir, filename));
	assert.match(await readFile(join(dir, filename), "utf8"), /## Notes\n\nUpdated only the selected saved plan\./);
	assert.doesNotMatch(await readFile(secondSave.details.path, "utf8"), /Updated only the selected saved plan/);
	assert.equal(persistedEntries, 0, "normal-mode plan edits must not change active plan state");
	await assert.rejects(
		() => updatePlan.execute("missing-target-call", { sectionAppends: [{ section: "notes", text: "No target" }] }, undefined, undefined, { cwd: dir }),
		/Specify plan.*list_plans/,
	);
	console.log("✓ list_plans and update_plan target a specific saved plan in normal mode");


	const updatePath = join(dir, "2026-09-25-active-plan.md");
	const firstStep = "Keep the existing setup step unchanged";
	const previousSecond = "Remove the obsolete follow-up";
	const revisedSecond = "Implement the revised persistence behavior and thoroughly verify that plan descriptions stay complete in the markdown body while frontmatter progress labels remain compact.";
	await writeFile(
		updatePath,
		`---\ntodos: [{"step":1,"text":"${firstStep}","completed":true},{"step":2,"text":"${previousSecond}","completed":false}]\n---\n\n# Active plan\n\nPlan:\n\n1. ${firstStep}\n2. ${previousSecond}\n\n## Context\nOld context.\n\n## Notes\nOld notes.\n\n## Results\nOld results.\n`,
		"utf8",
	);
	const executionContext = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode",
					data: {
						enabled: false,
						executing: true,
						todos: [
							{ step: 1, text: firstStep, completed: true },
							{ step: 2, text: previousSecond, completed: false },
						],
						activePlanPath: updatePath,
					},
				},
			],
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			setWidget() {},
			notify() {},
		},
	};
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart, "session_start handler should be registered");
	await sessionStart({}, executionContext);
	const updated = await updatePlan.execute(
		"update-call",
		{
			steps: [firstStep, revisedSecond],
			sectionEdits: [
				{ section: "context", oldText: "Old context.", newText: "Revised context." },
				{ section: "notes", oldText: "Old notes.", newText: "Revised notes." },
				{ section: "results", oldText: "Old results.", newText: "Verified results." },
			],
		},
		undefined,
		undefined,
		executionContext,
	);
	assert.equal(updated.details.todos[0].completed, true, "unchanged completed steps retain progress");
	assert.equal(updated.details.todos[1].text, revisedSecond.slice(0, -1), "execution state keeps the full revised description");
	assert.match(await readFile(updatePath, "utf8"), new RegExp(revisedSecond));
	const beforeStaleEdit = await readFile(updatePath, "utf8");
	await assert.rejects(
		() => updatePlan.execute(
			"stale-section-edit-call",
			{ sectionEdits: [{ section: "context", oldText: "Context from an outdated read.", newText: "Replacement." }] },
			undefined,
			undefined,
			executionContext,
		),
		/oldText was not found/,
	);
	assert.equal(await readFile(updatePath, "utf8"), beforeStaleEdit, "a stale targeted edit fails without writing any changes");
	const stepOnlyUpdate = await updatePlan.execute(
		"step-only-update-call",
		{ steps: [firstStep, revisedSecond] },
		undefined,
		undefined,
		executionContext,
	);
	assert.deepEqual(stepOnlyUpdate.details.updated, ["ordered steps"], "step-only updates do not touch saved sections");
	const updatedContent = await readFile(updatePath, "utf8");
	assert.match(updatedContent, /## Context\nRevised context\./, "step-only updates preserve existing Context");
	assert.match(updatedContent, /## Notes\nRevised notes\./, "step-only updates preserve existing Notes");
	assert.match(updatedContent, /## Results\nVerified results\./, "step-only updates preserve existing Results");
	const savedTodos = parseFrontmatter(updatedContent).frontmatter.todos!;
	assert.deepEqual(savedTodos.map((todo) => todo.completed), [true, false]);
	assert.equal(savedTodos[1]!.text, "Implement the revised persistence behavior and thoroughly verify that plan descriptions stay...");
	assert.match(savedTodos[1]!.textHash!, /^[a-f0-9]{64}$/);
	assert.match(updatedContent, /## Context\nRevised context\./);
	assert.match(updatedContent, /## Notes\nRevised notes\./);
	assert.match(updatedContent, /## Results\nVerified results\./);
	assert.ok(persistedEntries > 0, "updating the plan persists execution state");
	console.log("✓ update_plan revises the saved Plan body and preserves concise frontmatter/progress");

	const activeContextBefore = await handlers.get("before_agent_start")?.({}, executionContext);
	const persistedBeforeOtherUpdate = persistedEntries;
	const otherPlanStep = "Implement the revised unrelated plan task";
	const otherPlanUpdate = await updatePlan.execute(
		"unrelated-plan-update",
		{ plan: secondSave.details.path, steps: [otherPlanStep] },
		undefined,
		undefined,
		executionContext,
	);
	assert.doesNotMatch(otherPlanUpdate.content[0]?.text ?? "", /All plan steps are complete|Continue with step/);
	assert.deepEqual(otherPlanUpdate.details.todos.map((todo: any) => todo.completed), [false]);
	assert.match(await readFile(secondSave.details.path, "utf8"), new RegExp(otherPlanStep));
	assert.equal(await readFile(updatePath, "utf8"), updatedContent, "editing another plan leaves the active file unchanged");
	assert.equal(persistedEntries, persistedBeforeOtherUpdate, "editing another plan does not persist active execution state");
	const activeContextAfter = await handlers.get("before_agent_start")?.({}, executionContext);
	assert.equal(activeContextAfter.message.content, activeContextBefore.message.content, "editing another plan leaves active execution progress unchanged");
	console.log("✓ updating an unrelated plan during execution does not report completion or change active progress");

	const sharedPrefix = "Implement the shared persistence and validation workflow across the service and verify all acceptance tests for ";
	await updatePlan.execute("collision-update", {
		steps: [sharedPrefix + "customer records", sharedPrefix + "business records"],
		sectionAppends: [{ section: "notes", text: "1. Check deployment logs\n2. Check operational metrics" }],
	}, undefined, undefined, executionContext);
	const completeStep = tools.get("complete_plan_step")!;
	await completeStep.execute("complete-first", { step: 1 }, undefined, undefined, executionContext);
	await sessionStart({}, executionContext);
	const resumedContext = await handlers.get("before_agent_start")?.({}, executionContext);
	assert.match(resumedContext.message.content, /2\. .*business records/);
	assert.ok(!resumedContext.message.content.includes(sharedPrefix + "customer records"), "only unfinished steps are injected");
	assert.ok(!resumedContext.message.content.includes("Check deployment logs"), "Notes checklists are not injected as steps");
	await completeStep.execute("complete-second", { step: 2 }, undefined, undefined, executionContext);
	await assert.rejects(() => completeStep.execute("phantom-step", { step: 3 }, undefined, undefined, executionContext), /does not exist/);
	assert.deepEqual(parseFrontmatter(await readFile(updatePath, "utf8")).frontmatter.todos?.map((todo) => todo.completed), [true, true]);
	console.log("✓ updated plans resume with distinct completion flags and exclude saved Notes checklists");

	const planCommand = commands.get("plan");
	assert.ok(planCommand, "/plan command should be registered");
	await planCommand.handler("", executionContext);
	const hashlineMutationTools = ["replace", "replace_within", "insert", "copy", "move", "undo_last_change"];
	for (const name of hashlineMutationTools) {
		assert.ok(!activeTools.includes(name), `${name} should not be active in plan mode`);
		const response = await handlers.get("tool_call")?.({ toolName: name, input: {} }, executionContext);
		assert.equal(response?.block, true, `${name} tool calls should be blocked even if reactivated`);
	}
	assert.ok(activeTools.includes("update_plan"), "update_plan should be available in plan mode");
	assert.ok(activeTools.includes("list_plans"), "list_plans should be available in plan mode");
	assert.equal(await handlers.get("tool_call")?.({ toolName: "list_plans", input: {} }, executionContext), undefined);
	assert.equal(await handlers.get("tool_call")?.({ toolName: "update_plan", input: {} }, executionContext), undefined);
	assert.ok(activeTools.includes("anchor_grep"), "read-only hashline search remains available in plan mode");
	assert.equal(await handlers.get("tool_call")?.({ toolName: "anchor_grep", input: {} }, executionContext), undefined);
	const planningSave = await savePlan.execute(
		"planning-save-call",
		{ name: "Plan Mode Draft", content: "# Plan Mode Draft\n\n## Context\nInitial context.\n\nPlan:\n\n1. Prepare and validate a saved plan draft before editing its sections.\n\n## Notes\nInitial notes.\n\n## Results\nPending." },
		undefined,
		undefined,
		executionContext,
	);
	const planningPath = planningSave.details.path as string;
	await updatePlan.execute(
		"planning-update-call",
		{
			sectionEdits: [
				{ section: "context", oldText: "Initial context.", newText: "Context revised during planning." },
				{ section: "notes", oldText: "Initial notes.", newText: "Notes revised during planning." },
			],
		},
		undefined,
		undefined,
		executionContext,
	);
	const planningContent = await readFile(planningPath, "utf8");
	assert.match(planningContent, /## Context\nContext revised during planning\./);
	assert.match(planningContent, /## Notes\nNotes revised during planning\./);
	assert.match(planningContent, /## Results\nPending\./, "omitted sections remain unchanged");
	assert.match(planningContent, /1\. Prepare and validate a saved plan draft/, "section-only updates leave the plan steps unchanged");
	console.log("✓ update_plan edits saved plan sections during planning; hashline mutators remain blocked");

	// A fresh extension instance models execution after disk saving failed.
	const sessionOnlyTools = new Map<string, RegisteredTool>();
	const sessionOnlyHandlers = new Map<string, (...args: any[]) => Promise<any>>();
	planModeExtension({
		...pi,
		registerTool(tool: RegisteredTool) { sessionOnlyTools.set(tool.name, tool); },
		on(name: string, handler: (...args: any[]) => Promise<any>) {
			sessionOnlyHandlers.set(name, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI);
	const sessionOnlyContext = {
		...executionContext,
		sessionManager: {
			getEntries: () => [{
				type: "custom", customType: "plan-mode",
				data: {
					enabled: false, executing: true,
					todos: [
						{ step: 1, text: firstStep, completed: true },
						{ step: 2, text: previousSecond, completed: false },
					],
				},
			}],
		},
	};
	const filesBefore = await readdir(dir);
	await sessionOnlyHandlers.get("session_start")!({}, sessionOnlyContext);
	const sessionOnlyUpdate = sessionOnlyTools.get("update_plan")!;
	const sessionOnlyResult = await sessionOnlyUpdate.execute("session-only-update", { steps: [firstStep, revisedSecond] }, undefined, undefined, sessionOnlyContext);
	assert.equal(sessionOnlyResult.details.path, undefined, "no backing file is required for a step update");
	assert.deepEqual(sessionOnlyResult.details.todos.map((todo: any) => todo.completed), [true, false]);
	assert.match(sessionOnlyResult.content[0].text, /Continue with step 2:/);
	const sessionOnlyComplete = sessionOnlyTools.get("complete_plan_step")!;
	await assert.rejects(() => sessionOnlyComplete.execute("repeat-first", { step: 1 }, undefined, undefined, sessionOnlyContext), /already complete/);
	await sessionOnlyComplete.execute("finish-second", { step: 2 }, undefined, undefined, sessionOnlyContext);
	const reorderedSessionOnly = await sessionOnlyUpdate.execute("session-only-reorder", { steps: [revisedSecond, firstStep] }, undefined, undefined, sessionOnlyContext);
	assert.deepEqual(reorderedSessionOnly.details.todos.map((todo: any) => todo.completed), [true, true], "subsequent updates and reordering preserve completion");
	const revisedSessionOnly = await sessionOnlyUpdate.execute("session-only-revision", { steps: [revisedSecond, "Implement the revised setup step"] }, undefined, undefined, sessionOnlyContext);
	assert.deepEqual(revisedSessionOnly.details.todos.map((todo: any) => todo.completed), [true, false], "changed steps reset completion while unchanged steps retain it");
	assert.deepEqual(await readdir(dir), filesBefore, "session-only updates do not create plan files");
	console.log("✓ session-only plan updates preserve completed steps and ordered completion without a backing file");
} finally {
	if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
	else process.env.PI_PLAN_DIR = previousPlanDir;
	await rm(dir, { recursive: true, force: true });
}
