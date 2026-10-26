/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis. Tool registration,
 * execution UI, commands, and lifecycle hooks live in focused modules; this
 * entry point owns shared state and wires those pieces together.
 */

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { normalizeThinkingLevel, formatModelRef, stepModeLabel, type StepMode } from "./plan/settings.ts";
import { detectRepoName, planFilename, planWriteDir, slugify } from "./plan/paths.ts";
import { extractPlanTitle } from "./plan/content.ts";
import { stringifyFrontmatter } from "./plan/frontmatter.ts";
import type { PlanFrontmatter, TodoItem } from "./plan/types.ts";
import { buildTodoWidgetRows, formatTodoWidgetText, type TodoWidgetRow } from "./plan/widget.ts";
import {
	NORMAL_MODE_TOOLS,
	PLAN_MANAGED_TOOLS,
	PLAN_MODE_DISABLED_TOOLS,
	PLAN_MODE_TOOLS,
} from "./security/tool-policy.ts";
import { registerPlanCommands } from "./runtime/commands.ts";
import { registerPlanLifecycleHooks } from "./runtime/lifecycle-hooks.ts";
import { registerPlanTools } from "./runtime/tools.ts";
import type { ModelSnapshot, PlanModeRuntime } from "./runtime/runtime.ts";

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let executionContext = "";
	let toolsBeforePlanMode: string[] | undefined;
	let activePlanPath: string | undefined;
	let lastSavedPlanPath: string | undefined;
	let stepMode: StepMode = "continue";
	let modelSnapshot: ModelSnapshot | undefined;
	let stepsCompletedThisRun = 0;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((todo) => todo.completed).length;
			const gate = stepMode === "stop" ? " ⏯" : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}${gate}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const renderTodoWidgetLines = (width: number, theme: ExtensionContext["ui"]["theme"]): string[] => {
				const lines = buildTodoWidgetRows(todoItems).map((row: TodoWidgetRow) => {
					switch (row.kind) {
						case "summary":
							return theme.fg("success", "☑ ") + theme.fg(
								"muted",
								row.remaining === 0
									? `${row.completed} done · all steps complete`
									: `${row.completed} done · ${row.remaining} left`,
							);
						case "current": {
							const prefix = `▶ ${row.step}. `;
							return theme.fg("accent", prefix) + theme.fg("accent", formatTodoWidgetText(row.text, prefix, width));
						}
						case "pending": {
							const prefix = `☐ ${row.step}. `;
							return theme.fg("muted", "☐ ") + `${row.step}. ${formatTodoWidgetText(row.text, prefix, width)}`;
						}
						case "more":
							return theme.fg("dim", `  +${row.count} more`);
					}
				});
				lines.push(theme.fg("dim", `after each step: ${stepModeLabel(stepMode)}`));
				return lines.map((line) => truncateToWidth(line, width));
			};

			if (ctx.mode === "tui") {
				ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
					render: (width: number) => renderTodoWidgetLines(width, theme),
					invalidate: () => {},
				}));
			} else {
				ctx.ui.setWidget("plan-todos", renderTodoWidgetLines(80, ctx.ui.theme));
			}
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executionContext,
			executing: executionMode,
			toolsBeforePlanMode,
			activePlanPath,
			stepMode,
			modelSnapshot,
		});
	}

	async function endExecution(ctx: ExtensionContext): Promise<void> {
		executionMode = false;
		todoItems = [];
		executionContext = "";
		activePlanPath = undefined;
		stepsCompletedThisRun = 0;

		const snapshot = modelSnapshot;
		modelSnapshot = undefined;
		if (!snapshot) return;
		try {
			pi.setThinkingLevel(snapshot.thinkingLevel);
			const level = normalizeThinkingLevel(pi.getThinkingLevel()) ?? "off";
			const activeModel = ctx.model;
			const modelRef = activeModel ? formatModelRef(activeModel.provider, activeModel.id) : "the current model";
			ctx.ui.notify(`Keeping ${modelRef} active (thinking: ${level}).`, "info");
		} catch (err) {
			ctx.ui.notify(`Plan mode: thinking-level restore failed (${(err as Error).message}).`, "warning");
		}
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		planModeEnabled = !planModeEnabled;
		await endExecution(ctx);
		if (planModeEnabled) {
			lastSavedPlanPath = undefined;
			enablePlanModeTools();
			ctx.ui.notify(`Plan mode enabled. Writes restricted to ${planWriteDir()}.`);
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	async function planFileExists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async function ensurePlanFileForExecution(planText: string | undefined): Promise<string> {
		if (lastSavedPlanPath) return lastSavedPlanPath;
		const dir = planWriteDir();
		const today = new Date().toISOString().slice(0, 10);
		const title = planText ? extractPlanTitle(planText) : undefined;
		const slug = slugify(title ?? todoItems[0]?.text ?? "plan");
		let filename = `${today}-${slug}.md`;
		let counter = 2;
		while (await planFileExists(join(dir, filename))) {
			filename = `${today}-${slug}-${counter}.md`;
			counter++;
		}

		const path = join(dir, filename);
		const frontmatter: PlanFrontmatter = {
			repo: await detectRepoName(process.cwd()),
			title,
			date: today,
		};
		const body = planText ? `\n${planText}\n` : "";
		await writeFile(path, stringifyFrontmatter(frontmatter) + body, "utf8");
		return path;
	}

	const runtime: PlanModeRuntime = {
		pi,
		get planModeEnabled() { return planModeEnabled; },
		set planModeEnabled(value: boolean) { planModeEnabled = value; },
		get executionMode() { return executionMode; },
		set executionMode(value: boolean) { executionMode = value; },
		get todoItems() { return todoItems; },
		set todoItems(value: TodoItem[]) { todoItems = value; },
		get executionContext() { return executionContext; },
		set executionContext(value: string) { executionContext = value; },
		get toolsBeforePlanMode() { return toolsBeforePlanMode; },
		set toolsBeforePlanMode(value: string[] | undefined) { toolsBeforePlanMode = value; },
		get activePlanPath() { return activePlanPath; },
		set activePlanPath(value: string | undefined) { activePlanPath = value; },
		get lastSavedPlanPath() { return lastSavedPlanPath; },
		set lastSavedPlanPath(value: string | undefined) { lastSavedPlanPath = value; },
		get stepMode() { return stepMode; },
		set stepMode(value: StepMode) { stepMode = value; },
		get modelSnapshot() { return modelSnapshot; },
		set modelSnapshot(value: ModelSnapshot | undefined) { modelSnapshot = value; },
		get stepsCompletedThisRun() { return stepsCompletedThisRun; },
		set stepsCompletedThisRun(value: number) { stepsCompletedThisRun = value; },
		updateStatus,
		persistState,
		enablePlanModeTools,
		restoreNormalModeTools,
		endExecution,
		togglePlanMode,
		ensurePlanFileForExecution,
	};

	registerPlanTools(runtime);
	registerPlanCommands(runtime);
	registerPlanLifecycleHooks(runtime);
}
