import { readFile } from "node:fs/promises";
import { Key, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildExecutionInstructions,
	persistExecutionSettings,
	seedExecutionSettings,
	selectSavedPlan,
	showExecutionPreflight,
	applyExecutionSettings,
} from "./execution-preflight.ts";
import {
	detectRepoName,
	extractPlanTitle,
	formatModelRef,
	listSavedPlans,
	planWriteDir,
	readPlanFrontmatter,
	stepModeLabel,
	syncPlanTodosFromBody,
	toDisplayPath,
	writePlanTodos,
} from "./utils.ts";
import type { StepMode } from "./utils.ts";
import type { PlanModeRuntime, ResolvedExecutionSettings } from "./plan-runtime.ts";

async function loadSavedPlan(runtime: PlanModeRuntime, ctx: ExtensionContext, args: string): Promise<void> {
	const dir = planWriteDir();
	let all = false;
	let parseOptions = true;
	const queryParts: string[] = [];
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		if (parseOptions && token === "--") parseOptions = false;
		else if (parseOptions && token === "--all") all = true;
		else queryParts.push(token);
	}
	const repo = all ? undefined : await detectRepoName(ctx.cwd);
	const scope = repo === undefined ? "all repos" : `repo: ${repo}`;
	let plans = await listSavedPlans(dir);
	if (repo !== undefined) plans = plans.filter((plan) => plan.repo === repo);
	if (plans.length === 0) {
		ctx.ui.notify(
			`No saved plans found in ${dir} (${scope}).${all ? "" : " Use /plan list --all to show plans from every repo, including plans without repo metadata."}`,
			"warning",
		);
		return;
	}

	const plan = await selectSavedPlan(ctx, plans, scope, queryParts.join(" "));
	if (!plan) return;

	let content: string;
	try {
		content = await readFile(plan.path, "utf8");
		const syncedTodos = await syncPlanTodosFromBody(plan.path);
		if (syncedTodos.length > 0) {
			plan.todos = syncedTodos;
			content = await readFile(plan.path, "utf8");
		}
	} catch (err) {
		ctx.ui.notify(`Failed to read plan: ${(err as Error).message}`, "error");
		return;
	}

	const unfinished = plan.todos?.filter((todo) => !todo.completed) ?? [];
	if (plan.todos && plan.todos.length > 0 && unfinished.length > 0) {
		const choice = await ctx.ui.select(
			`This plan has ${unfinished.length}/${plan.todos.length} steps remaining - resume execution?`,
			["Resume execution", "Load as reference only"],
		);
		if (choice === "Resume execution") {
			const seed = await seedExecutionSettings(runtime, ctx, plan.path);
			let settings: ResolvedExecutionSettings = seed;
			if (ctx.hasUI) {
				const chosen = await showExecutionPreflight(runtime, ctx, { ...seed, title: plan.title });
				if (!chosen) return;
				settings = chosen;
			}

			runtime.todoItems = plan.todos;
			runtime.activePlanPath = plan.path;
			runtime.executionMode = true;
			runtime.planModeEnabled = false;
			runtime.stepMode = settings.stepMode;
			runtime.executionContext = settings.executionContext.trim();
			runtime.stepsCompletedThisRun = 0;
			runtime.restoreNormalModeTools();
			await applyExecutionSettings(runtime, ctx, settings);
			await persistExecutionSettings(runtime, ctx, plan.path);
			runtime.updateStatus(ctx);
			runtime.persistState();

			const remaining = runtime.todoItems.filter((todo) => !todo.completed);
			const firstIncomplete = remaining[0];
			const remainingList = remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
			const todoListText = runtime.todoItems
				.map((todo, index) => `${index + 1}. ${todo.completed ? "\u2611" : "\u2610"} ${todo.text}`)
				.join("\n");
			runtime.pi.sendMessage(
				{ customType: "plan-todo-list", content: `**Plan Steps (${runtime.todoItems.length}):**\n\n${todoListText}`, display: true },
				{ deliverAs: "followUp" },
			);
			runtime.pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: `Resume executing the plan.

Remaining steps:
${remainingList}

Continue with: ${firstIncomplete?.text ?? "the next remaining step"}

${buildExecutionInstructions(runtime.stepMode)}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			ctx.ui.notify(`Resuming plan: ${toDisplayPath(plan.path)}`, "info");
			return;
		}
	}

	runtime.pi.sendMessage(
		{
			customType: "plan-mode-loaded-plan",
			content: `Loaded previous plan from ${plan.path}:\n\n${content}`,
			display: true,
			details: { name: plan.name, path: plan.path },
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify(`Loaded plan: ${toDisplayPath(plan.path)}`, "info");
}

async function handleStepCommand(runtime: PlanModeRuntime, ctx: ExtensionContext, arg: string): Promise<void> {
	const normalized = arg.trim().toLowerCase();
	if (normalized === "status") {
		ctx.ui.notify(`After each step: ${stepModeLabel(runtime.stepMode)}.`, "info");
		return;
	}

	let next: StepMode;
	if (normalized === "") next = runtime.stepMode === "stop" ? "continue" : "stop";
	else if (normalized === "on" || normalized === "stop") next = "stop";
	else if (normalized === "off" || normalized === "continue") next = "continue";
	else {
		ctx.ui.notify("Usage: /plan step [on|off|status]", "error");
		return;
	}

	runtime.stepMode = next;
	await persistExecutionSettings(runtime, ctx, runtime.activePlanPath);
	runtime.updateStatus(ctx);
	runtime.persistState();
	ctx.ui.notify(`After each step: ${stepModeLabel(runtime.stepMode)}.`, "info");
}

export function registerPlanCommands(runtime: PlanModeRuntime): void {
	const { pi } = runtime;
	pi.registerMessageRenderer("plan-mode-loaded-plan", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { name?: string; path?: string } | undefined;
		const label = details?.path ? toDisplayPath(details.path) : details?.name ?? "plan";
		if (!expanded) {
			return new Text(
				theme.fg("accent", `📋 Loaded plan: ${label} `) + theme.fg("dim", "(expand to view contents)"),
				outputPad,
				0,
			);
		}
		return new Text(theme.fg("accent", `📋 Loaded plan: ${label}\n\n`) + String(message.content), outputPad, 0);
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode; '/plan list [--all] [query]' fuzzy-searches saved plans (current repo by default); '/plan step [on|off|status]' toggles stopping after each step",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toLowerCase();
			const options = [
				{ value: "list", label: "list" },
				{ value: "list --all", label: "list --all (all repos)" },
				{ value: "step", label: "step" },
				{ value: "step on", label: "step on" },
				{ value: "step off", label: "step off" },
				{ value: "step status", label: "step status" },
			];
			const matches = options.filter((option) => option.value.startsWith(needle));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "list" || trimmed.startsWith("list ")) {
				await loadSavedPlan(runtime, ctx, trimmed.slice(4).trim());
				return;
			}
			if (trimmed === "step" || trimmed.startsWith("step ")) {
				await handleStepCommand(runtime, ctx, trimmed.slice(4).trim());
				return;
			}
			await runtime.togglePlanMode(ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the full plan todo list (the widget shows a compact view)",
		handler: async (_args, ctx) => {
			if (runtime.todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const completed = runtime.todoItems.filter((todo) => todo.completed).length;
			const list = runtime.todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			const active = ctx.model;
			const footer = [
				`After each step: ${stepModeLabel(runtime.stepMode)}`,
				active ? `Model: ${formatModelRef(active.provider, active.id)} (thinking: ${pi.getThinkingLevel()})` : undefined,
			].filter(Boolean).join("\n");
			ctx.ui.notify(`Plan Progress: ${completed}/${runtime.todoItems.length} complete\n${list}\n\n${footer}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => runtime.togglePlanMode(ctx),
	});
}
