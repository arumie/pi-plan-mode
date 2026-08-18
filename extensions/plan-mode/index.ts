/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import { DynamicBorder, isToolCallEventType, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildModelPickerItems,
	buildTodoWidgetRows,
	detectRepoName,
	deriveTitleFromFilename,
	extractDateFromFilename,
	extractPlanTitle,
	extractTodoItems,
	formatModelRef,
	formatTodoWidgetText,
	isPlanFilePath,
	checkCommandSafety,
	listSavedPlans,
	markCompletedSteps,
	normalizePlanContent,
	type ModelPickerScope,
	normalizeStepMode,
	normalizeThinkingLevel,
	parseModelRef,
	planFilename,
	planWriteDir,
	type PlanFrontmatter,
	readPlanExecutionSettings,
	readPlanFrontmatter,
	resolvePlanPath,
	type SavedPlan,
	slugify,
	type StepMode,
	stepModeLabel,
	stringifyFrontmatter,
	syncPlanTodosFromBody,
	THINKING_LEVELS,
	type ThinkingLevelName,
	toDisplayPath,
	type TodoItem,
	type TodoWidgetRow,
	writePlanExecutionSettings,
	writePlanTodos,
} from "./utils.ts";

// Tools
// write/edit stay active in plan mode but are gated to the plans directory.
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "write", "edit", "save_plan"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>();
const PLAN_GATED_TOOLS = new Set<string>(["write", "edit"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

/**
 * Model + thinking level active before execution applied a switch, so it can be
 * put back when the plan finishes. Stored as a plain `"provider"`/`"modelId"`
 * pair (not a `Model` object) so it survives session persistence.
 */
interface ModelSnapshot {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevelName;
}

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
	activePlanPath?: string;
	stepMode?: StepMode;
	modelSnapshot?: ModelSnapshot;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * The step-discipline instructions handed to the agent during execution. Shared
 * by the execution context injected before each run and by the messages that
 * kick off / resume a plan, so the two can never drift apart.
 *
 * The `stop` variant is how step gating is enforced: there is no forced abort,
 * the agent is simply told to end its turn after tagging a step, and the
 * extension then asks the user whether to continue.
 */
function buildExecutionInstructions(mode: StepMode): string {
	const tagging =
		"Work on ONE step at a time, in order. The moment you finish a step - in that same turn's response, before starting anything else - include its [DONE:n] tag. Do not wait until the whole plan is done to add all the tags at once, and do not batch them at the end.";

	if (mode === "stop") {
		return `${tagging}

After tagging a completed step, STOP: end your turn there. Do not start the next step, do not call further tools, and do not describe the next step's work - the user will confirm before you continue.`;
	}

	return `${tagging}

After tagging a completed step, continue straight into the next remaining step without waiting for confirmation, until the plan is finished.`;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	// The plan file backing the currently executing plan, if any - kept in
	// sync with the on-disk `todos` frontmatter as steps complete.
	let activePlanPath: string | undefined;
	// The path a `write` call most recently saved a plan file to during the
	// current planning round, so "Execute the plan" can reuse it instead of
	// auto-generating a new file. Reset whenever plan mode is (re)toggled on.
	let lastSavedPlanPath: string | undefined;
	// Whether the agent keeps going after finishing a step (default) or stops and
	// waits for the user to confirm before starting the next one. Chosen in the
	// pre-flight panel, changeable mid-run with `/plan step`.
	let stepMode: StepMode = "continue";
	// Model/thinking level active before execution switched them, so they can be
	// restored when the plan finishes. `undefined` means execution did not change
	// anything, so there is nothing to restore.
	let modelSnapshot: ModelSnapshot | undefined;
	// How many plan steps were completed during the current agent run. Used to
	// decide whether the post-step "continue?" prompt is warranted, so a run that
	// merely stopped to ask a question never triggers it.
	let stepsCompletedThisRun = 0;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			// The ⏯ marker means "stopping after each step", so the gating mode is
			// visible at a glance during execution.
			const gate = stepMode === "stop" ? " ⏯" : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}${gate}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// `buildTodoWidgetRows` intentionally keeps its fixed compact row budget;
		// only the label text responds to terminal width. A component factory gets
		// `render(width)` again after a resize, unlike a pre-rendered string array.
		if (executionMode && todoItems.length > 0) {
			const renderTodoWidgetLines = (width: number, theme: ExtensionContext["ui"]["theme"]): string[] => {
				const lines = buildTodoWidgetRows(todoItems).map((row: TodoWidgetRow) => {
					switch (row.kind) {
						case "summary":
							return (
								theme.fg("success", "☑ ") +
								theme.fg(
									"muted",
									row.remaining === 0
										? `${row.completed} done · all steps complete`
										: `${row.completed} done · ${row.remaining} left`,
								)
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
				// RPC has no TUI render callback/terminal width, so keep a bounded,
				// string-array representation for clients that expose widget lines.
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
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
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
			executing: executionMode,
			toolsBeforePlanMode,
			activePlanPath,
			stepMode,
			modelSnapshot,
		});
	}

	/**
	 * Ends an execution run: clears execution state and, when execution had
	 * switched the model/thinking level, puts the previous ones back.
	 *
	 * The restore matters because `pi.setModel`/`pi.setThinkingLevel` also write
	 * pi's *global defaults* - without it, executing one plan on a heavier model
	 * would silently become the user's default for every later session.
	 */
	async function endExecution(ctx: ExtensionContext): Promise<void> {
		executionMode = false;
		todoItems = [];
		activePlanPath = undefined;
		stepsCompletedThisRun = 0;

		const snapshot = modelSnapshot;
		modelSnapshot = undefined;
		if (!snapshot) return;

		const previous = ctx.modelRegistry.find(snapshot.provider, snapshot.modelId);
		if (!previous) {
			ctx.ui.notify(
				`Plan mode: could not restore ${formatModelRef(snapshot.provider, snapshot.modelId)} (no longer available); keeping the current model.`,
				"warning",
			);
			return;
		}

		try {
			const ok = await pi.setModel(previous);
			if (!ok) {
				ctx.ui.notify(
					`Plan mode: could not restore ${formatModelRef(snapshot.provider, snapshot.modelId)}; keeping the current model.`,
					"warning",
				);
				return;
			}
			pi.setThinkingLevel(snapshot.thinkingLevel);
			const level = normalizeThinkingLevel(pi.getThinkingLevel()) ?? "off";
			ctx.ui.notify(`Restored ${formatModelRef(snapshot.provider, snapshot.modelId)} (thinking: ${level}).`, "info");
		} catch (err) {
			ctx.ui.notify(`Plan mode: model restore failed (${(err as Error).message}).`, "warning");
		}
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		planModeEnabled = !planModeEnabled;
		// Re-entering plan mode (or leaving it) abandons any in-flight execution, so
		// hand back the model execution borrowed.
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

	/**
	 * Saves a newly authored plan under the configured plans directory. The
	 * custom tool owns the filename/date and normalizes extension-managed
	 * frontmatter, so agents only need to provide a useful name and plan body.
	 */
	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description:
			"Save a completed plan in the configured plans directory. Supply a short name and the full markdown plan content; the tool adds the current date to the filename and manages frontmatter and todo tracking.",
		promptSnippet: "Save a finished plan with a name and markdown content",
		promptGuidelines: [
			"Use save_plan, rather than write, to create a new plan after planning is complete. Supply the full plan body under a Plan: header; save_plan generates the dated filename and manages frontmatter."
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short descriptive plan name used for the generated filename" }),
			content: Type.String({ description: "Complete markdown plan content, including its numbered Plan: section" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!planModeEnabled) throw new Error("save_plan is only available while plan mode is enabled.");
			if (signal?.aborted) throw new Error("Plan save cancelled.");

			const dir = planWriteDir();
			const today = new Date().toISOString().slice(0, 10);
			const basePath = resolve(dir, planFilename(params.name, today));
			await mkdir(dir, { recursive: true });

			return withFileMutationQueue(basePath, async () => {
				let path = basePath;
				let counter = 2;
				while (await planFileExists(path)) {
					path = resolve(dir, planFilename(params.name, today, counter));
					counter++;
				}

				const normalized = normalizePlanContent(params.content, {
					repo: await detectRepoName(ctx.cwd),
					title: params.name,
					date: today,
					forceDate: true,
				});
				await writeFile(path, normalized.content, "utf8");
				lastSavedPlanPath = path;
				if (normalized.todos.length > 0) {
					todoItems = normalized.todos;
					activePlanPath = path;
					updateStatus(ctx);
				}
				persistState();

				return {
					content: [
						{
							type: "text",
							text: `Saved plan to ${toDisplayPath(path)}${normalized.todos.length > 0 ? ` with ${normalized.todos.length} tracked step(s).` : "."}`,
						},
					],
					details: { path, todos: normalized.todos.length },
				};
			});
		},
	});

	/**
	 * Ensures there's an on-disk plan file backing the plan about to be
	 * executed: reuses `lastSavedPlanPath` if the agent already wrote one this
	 * planning round, otherwise auto-generates a new plan file (with
	 * repo/title/date frontmatter, no `todos` yet) under `planWriteDir()` so
	 * execution progress always has a durable home on disk.
	 */
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

	/**
	 * Generic bordered `SelectList` dialog. Every picker in this extension (saved
	 * plans, execution model, thinking level, the pre-flight rows) is the same
	 * component with different rows, so it lives here once.
	 *
	 * Rows carry an opaque `key` used to correlate the selection back to the
	 * caller's own value, because `SelectItem.value` is a string. Returns `null`
	 * when the user cancels with Esc.
	 */
	async function selectFromList<T>(
		ctx: ExtensionContext,
		title: string,
		rows: { key: string; label: string; description?: string; value: T }[],
		opts?: { hint?: string; initialKey?: string },
	): Promise<T | null> {
		if (rows.length === 0) return null;

		const items: SelectItem[] = rows.map((row) => ({
			value: row.key,
			label: row.label,
			description: row.description,
		}));
		const hint = opts?.hint ?? "↑↓ navigate • enter select • esc cancel";

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			container.addChild(new Text(theme.fg("dim", hint), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (result === null || result === undefined) return null;
		const row = rows.find((r) => r.key === result);
		return row ? row.value : null;
	}

	async function selectSavedPlan(ctx: ExtensionContext, plans: SavedPlan[]): Promise<SavedPlan | null> {
		return selectFromList<SavedPlan>(
			ctx,
			"Select a plan to load",
			plans.map((p) => ({
				key: p.path,
				label: p.name,
				description: [p.title ?? "(no title found)", p.repo, p.date].filter(Boolean).join(" · "),
				value: p,
			})),
		);
	}

	/** The models `/model` would offer in its scoped scope, freshly re-resolved. */
	function scopedExecutionModels(ctx: ExtensionContext): Model<Api>[] {
		// pi's own selector re-resolves each scoped entry against the refreshed
		// catalogue before rendering, so a scoped model picks up catalogue updates.
		return ctx.scopedModels.map(
			(scoped) => ctx.modelRegistry.find(scoped.model.provider, scoped.model.id) ?? scoped.model,
		);
	}

	/** The thinking level a scoped-model pattern pinned for `model`, if any. */
	function scopedThinkingPin(ctx: ExtensionContext, model: Model<Api> | undefined): ThinkingLevelName | undefined {
		if (!model) return undefined;
		const scoped = ctx.scopedModels.find(
			(s) => s.model.provider === model.provider && s.model.id === model.id,
		);
		return normalizeThinkingLevel(scoped?.thinkingLevel);
	}

	/**
	 * Model picker for execution, deliberately mirroring `/model`: it opens on the
	 * scoped set (the `enabledModels`/`--models` selection) whenever one exists,
	 * and offers a scope row to reach the full catalogue - standing in for
	 * `/model`'s Tab toggle, which `SelectList` can't receive because it consumes
	 * Tab itself. Returns null when the user cancels, so the caller keeps its
	 * previous choice.
	 */
	async function pickExecutionModel(
		ctx: ExtensionContext,
		current: Model<Api> | undefined,
		scope: ModelPickerScope = ctx.scopedModels.length > 0 ? "scoped" : "all",
	): Promise<Model<Api> | null> {
		const scoped = scopedExecutionModels(ctx);
		const available = ctx.modelRegistry.getAvailable();
		const effectiveScope: ModelPickerScope = scoped.length > 0 ? scope : "all";
		const rows = buildModelPickerItems(scoped, available, current, effectiveScope);

		if (rows.length === 0) {
			ctx.ui.notify("No models available to choose from.", "warning");
			return null;
		}

		const SCOPE_TOGGLE = "__scope_toggle__";
		const otherScope: ModelPickerScope = effectiveScope === "scoped" ? "all" : "scoped";
		const listRows: { key: string; label: string; description?: string; value: string }[] = [];

		if (scoped.length > 0) {
			listRows.push({
				key: SCOPE_TOGGLE,
				label: `Scope: ${effectiveScope === "scoped" ? "scoped" : "all"} → switch to ${otherScope}`,
				description:
					effectiveScope === "scoped"
						? `showing the ${scoped.length} session-scoped models (same as /model)`
						: `showing all ${available.length} available models`,
				value: SCOPE_TOGGLE,
			});
		}

		for (const row of rows) {
			listRows.push({
				key: row.ref,
				label: row.current ? `${row.id} ✓` : row.id,
				description: [row.provider, row.name, row.current ? "current" : undefined].filter(Boolean).join(" · "),
				value: row.ref,
			});
		}

		const chosen = await selectFromList<string>(ctx, "Execute with model", listRows, {
			hint: "↑↓ navigate • type to filter • enter select • esc keep current",
		});
		if (chosen === null) return null;
		if (chosen === SCOPE_TOGGLE) return pickExecutionModel(ctx, current, otherScope);

		const ref = parseModelRef(chosen);
		if (!ref) return null;
		return rows.find((r) => r.ref === chosen)?.model ?? ctx.modelRegistry.find(ref.provider, ref.modelId) ?? null;
	}

	/**
	 * Thinking-level picker for the chosen execution model. Offers pi's canonical
	 * level list unconditionally - plan mode does no capability filtering of its
	 * own, because `pi.setThinkingLevel()` already clamps to what the model
	 * supports (see `THINKING_LEVELS`). `xhigh`/`max` are therefore flagged as
	 * clampable rather than hidden. Returns null on cancel so the caller keeps its
	 * previous value.
	 */
	async function pickThinkingLevel(
		ctx: ExtensionContext,
		model: Model<Api> | undefined,
		current: ThinkingLevelName,
	): Promise<ThinkingLevelName | null> {
		const pinned = scopedThinkingPin(ctx, model);
		const describe = (level: ThinkingLevelName): string | undefined => {
			if (level === pinned) return "pinned by scope";
			if (level === "xhigh" || level === "max") return "may be clamped down by the model";
			return undefined;
		};
		return selectFromList<ThinkingLevelName>(
			ctx,
			"Execute with thinking level",
			THINKING_LEVELS.map((level) => ({
				key: level,
				label: level === current ? `${level} (current)` : level,
				description: describe(level),
				value: level,
			})),
			{ hint: "↑↓ navigate • enter select • esc keep current" },
		);
	}

	/**
	 * Seeds the pre-flight panel: a plan file's stored execution settings win (so
	 * re-running or resuming a plan re-offers what it last ran with), falling back
	 * to the session's active model/thinking level and the current step mode.
	 */
	async function seedExecutionSettings(
		ctx: ExtensionContext,
		path: string | undefined,
	): Promise<ResolvedExecutionSettings> {
		const stored = path ? await readPlanExecutionSettings(path) : {};
		const ref = parseModelRef(stored.model);
		const storedModel = ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined;
		if (stored.model && !storedModel) {
			ctx.ui.notify(
				`Plan mode: plan's stored model ${stored.model} is not available; defaulting to the current model.`,
				"warning",
			);
		}
		const model = storedModel ?? ctx.model;
		return {
			model,
			// No clamping: the panel opens showing the level the session is genuinely
			// on (or the plan's stored one), and pi clamps it on start.
			thinking: stored.thinking ?? normalizeThinkingLevel(pi.getThinkingLevel()) ?? "off",
			stepMode: stored.stepMode ?? stepMode,
		};
	}

	/**
	 * Mirrors the settings execution is actually running with into the plan file's
	 * frontmatter. Uses the live `ctx.model`, not the requested one, so a failed
	 * model switch is not recorded as if it had happened. Best-effort.
	 */
	async function persistExecutionSettings(ctx: ExtensionContext, path: string | undefined): Promise<void> {
		if (!path) return;
		try {
			const active = ctx.model;
			await writePlanExecutionSettings(path, {
				model: active ? formatModelRef(active.provider, active.id) : undefined,
				thinking: normalizeThinkingLevel(pi.getThinkingLevel()),
				stepMode,
			});
		} catch {
			// Frontmatter mirroring is best-effort; execution proceeds regardless.
		}
	}

	/** Settings the pre-flight panel produces, resolved against the live catalogue. */
	interface ResolvedExecutionSettings {
		model: Model<Api> | undefined;
		thinking: ThinkingLevelName;
		stepMode: StepMode;
	}

	/**
	 * Pre-flight panel shown before execution starts: one screen listing the model,
	 * thinking level and step-gating mode, each row editable, plus start/cancel.
	 *
	 * Implemented as a loop over `selectFromList` rather than a bespoke component,
	 * so the row labels always re-render from the working copy after a change and
	 * the sub-pickers are the same dialog everything else uses. Returns null when
	 * the user cancels, meaning "don't execute".
	 */
	async function showExecutionPreflight(
		ctx: ExtensionContext,
		seed: ResolvedExecutionSettings & { title?: string },
	): Promise<ResolvedExecutionSettings | null> {
		let model = seed.model;
		let thinking = seed.thinking;
		let mode = seed.stepMode;

		const title = seed.title ? `Execute plan: ${seed.title}` : "Execute plan";

		while (true) {
			const modelLabel = model ? formatModelRef(model.provider, model.id) : "(no model resolved)";
			const pinned = scopedThinkingPin(ctx, model);
			const action = await selectFromList<"model" | "thinking" | "step" | "start" | "cancel">(
				ctx,
				title,
				[
					{
						key: "model",
						label: `Model             ${modelLabel}`,
						description: model?.name,
						value: "model",
					},
					{
						key: "thinking",
						label: `Thinking          ${thinking}${pinned === thinking ? " (pinned by scope)" : ""}`,
						description: "applied on start; pi clamps to what the model supports",
						value: "thinking",
					},
					{
						key: "step",
						label: `After each step   ${stepModeLabel(mode)}`,
						description:
							mode === "stop"
								? "pause for confirmation after every completed step"
								: "work through the remaining steps without stopping",
						value: "step",
					},
					{ key: "start", label: "▶ Start execution", value: "start" },
					{ key: "cancel", label: "Cancel", description: "stay in plan mode", value: "cancel" },
				],
				{ hint: "↑↓ navigate • enter change/start • esc cancel" },
			);

			if (action === null || action === "cancel") return null;

			if (action === "model") {
				const picked = await pickExecutionModel(ctx, model);
				if (picked) {
					model = picked;
					// A scope-pinned level wins for a freshly picked model (pi applies the
					// same precedence when a scoped model is selected); otherwise keep the
					// current choice as-is - pi clamps it to the new model on start.
					thinking = scopedThinkingPin(ctx, picked) ?? thinking;
				}
				continue;
			}

			if (action === "thinking") {
				const picked = await pickThinkingLevel(ctx, model, thinking);
				if (picked) thinking = picked;
				continue;
			}

			if (action === "step") {
				mode = mode === "stop" ? "continue" : "stop";
				continue;
			}

			return { model, thinking, stepMode: mode };
		}
	}

	/**
	 * Applies the pre-flight choices to the live session.
	 *
	 * Takes a snapshot of the current model/thinking level *before* changing
	 * anything (and only when something actually changes), because pi's
	 * `setModel`/`setThinkingLevel` also rewrite the user's global defaults - the
	 * snapshot is what `endExecution` uses to put things back afterwards.
	 *
	 * Never throws and never aborts execution: if the chosen model has no usable
	 * auth, the plan still runs on the current model.
	 */
	async function applyExecutionSettings(ctx: ExtensionContext, settings: ResolvedExecutionSettings): Promise<void> {
		const currentModel = ctx.model;
		const currentThinking = normalizeThinkingLevel(pi.getThinkingLevel()) ?? "off";
		const target = settings.model;
		const modelChanged =
			target !== undefined &&
			(currentModel === undefined || target.provider !== currentModel.provider || target.id !== currentModel.id);
		const thinkingChanged = settings.thinking !== currentThinking;

		if (!modelChanged && !thinkingChanged) return;

		if (currentModel) {
			modelSnapshot = {
				provider: currentModel.provider,
				modelId: currentModel.id,
				thinkingLevel: currentThinking,
			};
		}

		if (modelChanged && target) {
			let ok = false;
			try {
				ok = await pi.setModel(target);
			} catch (err) {
				ctx.ui.notify(`Plan mode: could not switch model (${(err as Error).message}).`, "warning");
			}
			if (!ok) {
				// No configured auth for that model - this is why the picker mirrors
				// /model instead of pre-filtering by auth. Nothing was changed, so drop
				// the snapshot to keep "restore" a no-op.
				ctx.ui.notify(
					`Plan mode: no credentials for ${formatModelRef(target.provider, target.id)}; executing with ${
						currentModel ? formatModelRef(currentModel.provider, currentModel.id) : "the current model"
					}.`,
					"warning",
				);
				if (!thinkingChanged) modelSnapshot = undefined;
			}
		}

		// Applied verbatim: pi clamps to what the model that is actually active now
		// supports (which may still be the previous one if the switch above failed),
		// so the effective level is read back rather than computed here.
		pi.setThinkingLevel(settings.thinking);
		const effective = normalizeThinkingLevel(pi.getThinkingLevel()) ?? "off";
		const thinkingText =
			effective === settings.thinking
				? `thinking: ${effective}`
				: `thinking: ${effective} (requested ${settings.thinking}, clamped by the model)`;

		const activeModel = ctx.model ?? target;
		ctx.ui.notify(
			`Executing with ${
				activeModel ? formatModelRef(activeModel.provider, activeModel.id) : "the current model"
			} (${thinkingText}, after each step: ${stepModeLabel(settings.stepMode)}).`,
			"info",
		);
	}

	async function loadSavedPlan(ctx: ExtensionContext, filter: string): Promise<void> {
		const dir = planWriteDir();
		let plans = await listSavedPlans(dir);

		const needle = filter.trim().toLowerCase();
		if (needle.length > 0) {
			plans = plans.filter(
				(p) =>
					p.name.toLowerCase().includes(needle) ||
					p.title?.toLowerCase().includes(needle) ||
					p.repo?.toLowerCase().includes(needle) ||
					p.date?.toLowerCase().includes(needle),
			);
		}

		if (plans.length === 0) {
			ctx.ui.notify(
				needle.length > 0
					? `No saved plans in ${dir} matching "${filter.trim()}".`
					: `No saved plans found in ${dir}.`,
				"warning",
			);
			return;
		}

		const plan = await selectSavedPlan(ctx, plans);
		if (!plan) return;

		let content: string;
		try {
			content = await readFile(plan.path, "utf8");
			// Re-stamp from the body when a saved plan is opened. Besides keeping a
			// refined plan current, this upgrades legacy 70-character todo labels to
			// full descriptions while preserving completion via mergeTodoCompletion.
			const syncedTodos = await syncPlanTodosFromBody(plan.path);
			if (syncedTodos.length > 0) {
				plan.todos = syncedTodos;
				content = await readFile(plan.path, "utf8");
			}
		} catch (err) {
			ctx.ui.notify(`Failed to read plan: ${(err as Error).message}`, "error");
			return;
		}

		const unfinished = plan.todos?.filter((t) => !t.completed) ?? [];
		if (plan.todos && plan.todos.length > 0 && unfinished.length > 0) {
			const choice = await ctx.ui.select(
				`This plan has ${unfinished.length}/${plan.todos.length} steps remaining - resume execution?`,
				["Resume execution", "Load as reference only"],
			);

			if (choice === "Resume execution") {
				// Same pre-flight as a fresh execution, seeded from what this plan last
				// ran with, so resuming can switch model/thinking/step mode too.
				const seed = await seedExecutionSettings(ctx, plan.path);
				let settings: ResolvedExecutionSettings = seed;
				if (ctx.hasUI) {
					const chosen = await showExecutionPreflight(ctx, { ...seed, title: plan.title });
					if (!chosen) return;
					settings = chosen;
				}

				todoItems = plan.todos;
				activePlanPath = plan.path;
				executionMode = true;
				planModeEnabled = false;
				stepMode = settings.stepMode;
				stepsCompletedThisRun = 0;
				restoreNormalModeTools();
				await applyExecutionSettings(ctx, settings);
				await persistExecutionSettings(ctx, plan.path);
				updateStatus(ctx);
				persistState();

				const remaining = todoItems.filter((t) => !t.completed);
				const firstIncomplete = remaining[0];
				const remainingList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
				const todoListText = todoItems
					.map((t, i) => `${i + 1}. ${t.completed ? "\u2611" : "\u2610"} ${t.text}`)
					.join("\n");

				pi.sendMessage(
					{
						customType: "plan-todo-list",
						content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
						display: true,
					},
					{ deliverAs: "followUp" },
				);
				pi.sendMessage(
					{
						customType: "plan-mode-execute",
						content: `Resume executing the plan.

Remaining steps:
${remainingList}

Continue with: ${firstIncomplete?.text ?? "the next remaining step"}

${buildExecutionInstructions(stepMode)}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				ctx.ui.notify(`Resuming plan: ${toDisplayPath(plan.path)}`, "info");
				return;
			}
		}

		pi.sendMessage(
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
		description:
			"Toggle plan mode; '/plan list [filter]' loads a saved plan; '/plan step [on|off|status]' toggles stopping after each step",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toLowerCase();
			const options = [
				{ value: "list", label: "list" },
				{ value: "step", label: "step" },
				{ value: "step on", label: "step on" },
				{ value: "step off", label: "step off" },
				{ value: "step status", label: "step status" },
			];
			const matches = options.filter((o) => o.value.startsWith(needle));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "list" || trimmed.startsWith("list ")) {
				await loadSavedPlan(ctx, trimmed.slice(4).trim());
				return;
			}
			if (trimmed === "step" || trimmed.startsWith("step ")) {
				await handleStepCommand(ctx, trimmed.slice(4).trim());
				return;
			}
			await togglePlanMode(ctx);
		},
	});

	/**
	 * `/plan step [on|off|status]` - flips step gating, including mid-execution.
	 * `on` means "stop after each step"; bare `/plan step` toggles.
	 */
	async function handleStepCommand(ctx: ExtensionContext, arg: string): Promise<void> {
		const normalized = arg.trim().toLowerCase();

		if (normalized === "status") {
			ctx.ui.notify(`After each step: ${stepModeLabel(stepMode)}.`, "info");
			return;
		}

		let next: StepMode;
		if (normalized === "") {
			next = stepMode === "stop" ? "continue" : "stop";
		} else if (normalized === "on" || normalized === "stop") {
			next = "stop";
		} else if (normalized === "off" || normalized === "continue") {
			next = "continue";
		} else {
			ctx.ui.notify("Usage: /plan step [on|off|status]", "error");
			return;
		}

		stepMode = next;
		await persistExecutionSettings(ctx, activePlanPath);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`After each step: ${stepModeLabel(stepMode)}.`, "info");
	}

	pi.registerCommand("todos", {
		description: "Show the full plan todo list (the widget shows a compact view)",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			// The authoritative full view: every step, never collapsed, using the
			// same numbering as the widget and the `📋 completed/total` footer.
			const completed = todoItems.filter((t) => t.completed).length;
			const list = todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			const active = ctx.model;
			const footer = [
				`After each step: ${stepModeLabel(stepMode)}`,
				active
					? `Model: ${formatModelRef(active.provider, active.id)} (thinking: ${pi.getThinkingLevel()})`
					: undefined,
			]
				.filter(Boolean)
				.join("\n");
			ctx.ui.notify(`Plan Progress: ${completed}/${todoItems.length} complete\n${list}\n\n${footer}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// Block destructive bash commands and out-of-scope writes in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const safety = checkCommandSafety(command);
			if (!safety.safe) {
				return {
					block: true,
					reason: `Plan mode: command blocked - ${safety.reason ?? "not allowlisted"}. Plan mode only allows read-only commands; use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
			return;
		}

		if (PLAN_GATED_TOOLS.has(event.toolName)) {
			const dir = planWriteDir();
			const targetPath = (event.input as { path?: unknown }).path;
			if (!isPlanFilePath(targetPath, process.cwd(), dir)) {
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is only allowed for plan markdown files under ${dir}. Use /plan to disable plan mode first.\nPath: ${String(targetPath)}`,
				};
			}

			// Backfill missing repo/title/date frontmatter on newly written plan
			// files (never clobbering anything the agent already supplied), stamp
			// the `todos` progress list derived from the plan body, carry over the
			// extension-managed execution settings, and remember the path so
			// "Execute the plan" can reuse it. Best-effort: never block the write
			// over a backfill/formatting issue.
			if (isToolCallEventType("write", event)) {
				try {
					const path = resolvePlanPath(String(event.input.path), process.cwd());
					const filename = basename(path);
					// Retain extension-managed settings/progress from an existing plan
					// while backfilling missing identity metadata and deriving todos from
					// the freshly written Plan: body.
					const previous = (await readPlanFrontmatter(path))?.frontmatter;
					const normalized = normalizePlanContent(String(event.input.content ?? ""), {
						repo: await detectRepoName(process.cwd()),
						title: deriveTitleFromFilename(filename),
						date: extractDateFromFilename(filename) ?? new Date().toISOString().slice(0, 10),
						previous,
					});
					event.input.content = normalized.content;
					lastSavedPlanPath = path;
				} catch {
					// Frontmatter backfill is best-effort; leave the write untouched.
				}
			}
		}
	});

	// Keep a plan file's `todos` frontmatter in sync with its body right after it
	// is written or edited, so progress tracking exists as soon as the plan is
	// made - not only once execution starts. Covers `edit` (whose resulting
	// content isn't known up front) and any normalization the write tool applied.
	pi.on("tool_result", async (event, ctx) => {
		if (!planModeEnabled || event.isError) return;
		if (!PLAN_GATED_TOOLS.has(event.toolName)) return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (!isPlanFilePath(inputPath, process.cwd(), planWriteDir())) return;

		try {
			const path = resolvePlanPath(String(inputPath), process.cwd());
			lastSavedPlanPath = path;
			const synced = await syncPlanTodosFromBody(path);
			if (synced.length > 0) {
				todoItems = synced;
				activePlanPath = path;
				updateStatus(ctx);
				persistState();
			}
		} catch {
			// Todo sync is best-effort; never turn a successful write into an error.
		}
	});

	// Filter out stale plan mode context when not in plan mode.
	//
	// NOTE: this hook must stay filter-only. It used to also append a fresh
	// [DONE:n] reminder here on every single turn, but that message was never
	// persisted — it only existed in the outgoing request for that one call.
	// Since it always sat at the very tail of the array, right where the *next*
	// turn's real content would go instead, the cache write for that request
	// could never be read back by any future request (the position after real
	// history never matches a reminder again — it matches real assistant/tool
	// content). That pinned cache reads to the fixed system+tools prefix for the
	// whole execution run and forced a full rewrite of the growing conversation
	// on every turn, regardless of whether the reminder's own text was stable.
	// The reminder now lives in turn_end below, sent as a real persisted message
	// so it becomes part of history the next call can actually cache-read.
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		const filtered = event.messages.filter((m) => {
			const msg = m as AgentMessage & { customType?: string };
			if (msg.customType === "plan-mode-context") return false;
			if (msg.role !== "user") return true;

			const content = msg.content;
			if (typeof content === "string") {
				return !content.includes("[PLAN MODE ACTIVE]");
			}
			if (Array.isArray(content)) {
				return !content.some(
					(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
				);
			}
			return true;
		});

		return { messages: filtered };
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- The only writes allowed are markdown plan files under ${planWriteDir()} (via the write/edit tools). Every other path is blocked.
- Other currently active tools remain available
- Bash is restricted to read-only commands. Read-only research is allowed, including \`gh\` lookups (\`gh pr view/list/diff\`, \`gh issue view\`, \`gh api\` GETs, \`gh search\`, \`gh run list\`) and read-only \`git\` subcommands. Anything that writes, installs, builds or mutates remote state is blocked with a reason explaining why.

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes to the project - just describe what you would do.
When the finished plan is ready to save, call the save_plan tool with a short descriptive name and the full markdown content. The tool creates ${planWriteDir()}/YYYY-MM-DD-task-summary.md automatically, supplies the current date, and backfills frontmatter. Do NOT use write to create a new plan file. You may use write/edit only to refine a plan that save_plan has already created. Keep a "Plan:" body (use that literal header text, e.g. "Plan:" or "## Plan" - either works - immediately followed by numbered steps). Do NOT include a "todos" field - progress tracking is managed automatically from that numbered list, so don't hand-maintain a separate checklist section.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

${buildExecutionInstructions(stepMode)}

This instruction is only shown once, at the start of this execution run — there is no repeated reminder, so tag each step as soon as you finish it rather than waiting for a nudge.`,
					display: false,
				},
			};
		}
	});

	// Each agent run starts with a clean per-run step counter, so the post-step
	// pause prompt only reacts to work done in the run that just finished.
	pi.on("agent_start", async () => {
		stepsCompletedThisRun = 0;
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		// Count only steps that were still open, so a repeated [DONE:n] tag for an
		// already-completed step cannot trigger the pause prompt.
		const openBefore = todoItems.filter((t) => !t.completed).length;
		if (markCompletedSteps(text, todoItems) > 0) {
			stepsCompletedThisRun += openBefore - todoItems.filter((t) => !t.completed).length;
			updateStatus(ctx);
			if (activePlanPath) {
				try {
					await writePlanTodos(activePlanPath, todoItems);
				} catch {
					// Best-effort disk sync; never let it interrupt the turn.
				}
			}
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				if (activePlanPath) {
					try {
						await writePlanTodos(activePlanPath, todoItems);
					} catch {
						// Best-effort final disk sync.
					}
				}
				// Clears execution state and hands back the model/thinking level that
				// execution borrowed.
				await endExecution(ctx);
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
				return;
			}

			// Step gating: the agent was told to stop after tagging a step, so ask
			// whether to continue. Only when a step actually completed during this run
			// - a run that merely stopped to ask a question must not be hijacked by a
			// "continue?" prompt.
			if (stepMode === "stop" && stepsCompletedThisRun > 0 && ctx.hasUI) {
				const completed = todoItems.filter((t) => t.completed).length;
				const remaining = todoItems.filter((t) => !t.completed);
				const next = remaining[0];
				stepsCompletedThisRun = 0;

				const CONTINUE = "Continue to next step";
				const CONTINUE_ALL = "Continue without stopping again";
				const PAUSE = "Stay paused";
				const choice = await ctx.ui.select(
					`Step ${completed}/${todoItems.length} complete - continue?`,
					[CONTINUE, CONTINUE_ALL, PAUSE],
				);

				if (choice === PAUSE || choice === undefined) {
					ctx.ui.notify(
						`Paused after step ${completed}/${todoItems.length}. Type your next instruction, or /plan step off to stop pausing.`,
						"info",
					);
					persistState();
					return;
				}

				if (choice === CONTINUE_ALL) {
					stepMode = "continue";
					await persistExecutionSettings(ctx, activePlanPath);
					ctx.ui.notify("Step gating off: continuing through the remaining steps.", "info");
				}

				updateStatus(ctx);
				persistState();

				const remainingList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-mode-execute",
						content: `Continue executing the plan.

Remaining steps:
${remainingList}

Continue with: ${next?.text ?? "the next remaining step"}

${buildExecutionInstructions(stepMode)}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Determine the plan's steps. A plan file saved during this round is
		// authoritative (its body is the plan of record and its frontmatter
		// already tracks completion); otherwise fall back to the chat message.
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let extracted: TodoItem[] = [];
		if (lastSavedPlanPath) {
			try {
				extracted = await syncPlanTodosFromBody(lastSavedPlanPath);
			} catch {
				extracted = [];
			}
		}
		if (extracted.length === 0 && lastAssistant) {
			extracted = extractTodoItems(getTextContent(lastAssistant));
		}
		if (extracted.length > 0) {
			todoItems = extracted;
		}

		if (todoItems.length === 0) return;

		// Persist the todo list into the plan file's frontmatter now, while the
		// plan is being made - independent of whether the user executes, keeps
		// refining, or stays in plan mode.
		if (lastSavedPlanPath) {
			try {
				await writePlanTodos(lastSavedPlanPath, todoItems);
				activePlanPath = lastSavedPlanPath;
			} catch {
				// Best-effort disk sync.
			}
		}
		persistState();

		// Show plan steps and prompt for next action
		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			// Pre-flight: choose the model, thinking level and step gating to execute
			// with. Headless runs (print/RPC) have no UI to ask, so they execute with
			// the session's current model and the default "keep going" mode.
			const planPath = lastSavedPlanPath ?? activePlanPath;
			const seed = await seedExecutionSettings(ctx, planPath);
			let settings: ResolvedExecutionSettings = { ...seed, stepMode: seed.stepMode };
			if (ctx.hasUI) {
				const chosen = await showExecutionPreflight(ctx, {
					...seed,
					title: lastAssistant ? extractPlanTitle(getTextContent(lastAssistant)) : undefined,
				});
				// Cancel/Esc means "don't execute": stay in plan mode with the plan file
				// already saved, so nothing is lost.
				if (!chosen) return;
				settings = chosen;
			}

			planModeEnabled = false;
			executionMode = true;
			stepMode = settings.stepMode;
			stepsCompletedThisRun = 0;
			restoreNormalModeTools();
			await applyExecutionSettings(ctx, settings);

			try {
				const planText = lastAssistant ? getTextContent(lastAssistant) : undefined;
				const path = await ensurePlanFileForExecution(planText);
				await writePlanTodos(path, todoItems);
				activePlanPath = path;
				await persistExecutionSettings(ctx, path);
			} catch (err) {
				ctx.ui.notify(
					`Plan mode: failed to save plan file (${(err as Error).message}); continuing without disk tracking.`,
					"warning",
				);
			}

			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}

${buildExecutionInstructions(stepMode)}`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
			activePlanPath = planModeEntry.data.activePlanPath ?? activePlanPath;
			stepMode = normalizeStepMode(planModeEntry.data.stepMode);
			modelSnapshot = planModeEntry.data.modelSnapshot ?? modelSnapshot;
		}

		// On resume: prefer on-disk todos (authoritative) over re-scanning chat
		// history, since the extension keeps `activePlanPath`'s frontmatter in
		// sync as steps complete. Only fall back to rescanning messages after
		// the last "plan-mode-execute" entry for [DONE:n] tags when there's no
		// active plan path or its file can't be read (e.g. deleted/moved, or a
		// session that predates this feature).
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let usedOnDiskTodos = false;
			if (activePlanPath) {
				const onDisk = await readPlanFrontmatter(activePlanPath);
				if (onDisk?.frontmatter.todos && onDisk.frontmatter.todos.length > 0) {
					todoItems = onDisk.frontmatter.todos;
					usedOnDiskTodos = true;
				}
			}

			if (!usedOnDiskTodos) {
				// Find the index of the last plan-mode-execute entry (marks when current execution started)
				let executeIndex = -1;
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i] as { type: string; customType?: string };
					if (entry.customType === "plan-mode-execute") {
						executeIndex = i;
						break;
					}
				}

				// Only scan messages after the execute marker
				const messages: AssistantMessage[] = [];
				for (let i = executeIndex + 1; i < entries.length; i++) {
					const entry = entries[i];
					if (
						entry.type === "message" &&
						"message" in entry &&
						isAssistantMessage(entry.message as AgentMessage)
					) {
						messages.push(entry.message as AssistantMessage);
					}
				}
				const allText = messages.map(getTextContent).join("\n");
				markCompletedSteps(allText, todoItems);
			}
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
