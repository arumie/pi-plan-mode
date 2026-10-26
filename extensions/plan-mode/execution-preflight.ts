import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	buildModelPickerItems,
	formatModelRef,
	parseModelRef,
	readPlanExecutionSettings,
	stepModeLabel,
	THINKING_LEVELS,
	normalizeThinkingLevel,
	type ModelPickerScope,
	type SavedPlan,
	type StepMode,
	type ThinkingLevelName,
	writePlanExecutionSettings,
} from "./utils.ts";
import type { PlanModeRuntime, ResolvedExecutionSettings } from "./plan-runtime.ts";

/** Shared execution discipline sent both at execution start and when resuming. */
export function buildExecutionInstructions(mode: StepMode): string {
	const completion =
		"Work on ONE step at a time, in order. The moment you finish a step, call complete_plan_step with that step number before starting anything else. Do not wait until the whole plan is done, do not batch calls, and do not claim a step is complete without successfully calling the tool. If the scope or ordered steps need to change, call update_plan with the complete revised list of detailed steps first. Section updates must be targeted: use sectionEdits with exact existing oldText and the intended newText, or sectionAppends to add content. Never replace a whole Context, Notes, or Results section as a routine update. Exact edits must match once; on mismatch, re-read the section and retry.";

	if (mode === "stop") {
		return `${completion}

After complete_plan_step succeeds, STOP: end your turn there. Do not start the next step, do not call further tools, and do not describe the next step's work - the user will confirm before you continue.`;
	}

	return `${completion}

After complete_plan_step succeeds, continue straight into the next remaining step without waiting for confirmation, until the plan is finished.`;
}

export function formatExecutionContext(context: string): string {
	const trimmed = context.trim();
	return trimmed ? `Execution context for this run:\n${trimmed}\n\n` : "";
}

/** Generic bordered list dialog shared by saved-plan and execution pickers. */
export async function selectFromList<T>(
	ctx: ExtensionContext,
	title: string,
	rows: { key: string; label: string; description?: string; value: T }[],
	opts?: { hint?: string; initialKey?: string; ctrlNKey?: string; search?: string },
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

		const listTheme = {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		};
		const createList = (query: string) => {
			const filtered = fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`);
			const list = new SelectList(filtered, Math.min(items.length, 10), listTheme);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			return { list, count: filtered.length };
		};
		let { list: selectList, count } = createList(opts?.search ?? "");
		const input = opts?.search !== undefined ? new Input() : undefined;
		if (input) {
			input.handleInput(opts?.search ?? "");
			container.addChild(input);
		}
		container.addChild({
			render: (width) => count > 0
				? selectList.render(width)
				: new Text(theme.fg("warning", "No matching plans"), 1, 0).render(width),
			invalidate: () => selectList.invalidate(),
		});

		container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			get focused() { return input?.focused ?? false; },
			set focused(value: boolean) { if (input) input.focused = value; },
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				if (opts?.ctrlNKey && matchesKey(data, Key.ctrl("n"))) {
					done(opts.ctrlNKey);
					return;
				}
				if (!input || (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some(
					(action) => _kb.matches(data, action),
				)) {
					selectList.handleInput(data);
				} else {
					const previous = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previous) {
						({ list: selectList, count } = createList(input.getValue()));
					}
				}
				tui.requestRender();
			},
		};
	});

	if (result === null || result === undefined) return null;
	const row = rows.find((candidate) => candidate.key === result);
	return row ? row.value : null;
}

export async function selectSavedPlan(
	ctx: ExtensionContext,
	plans: SavedPlan[],
	scope: string,
	query: string,
): Promise<SavedPlan | null> {
	return selectFromList<SavedPlan>(
		ctx,
		`Select a plan to load (${scope})`,
		plans.map((plan) => ({
			key: plan.path,
			label: plan.name,
			description: [plan.title ?? "(no title found)", plan.repo, plan.date].filter(Boolean).join(" · "),
			value: plan,
		})),
		{ search: query, hint: "type to fuzzy search • ↑↓ navigate • enter select • esc cancel" },
	);
}

function scopedExecutionModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.scopedModels.map(
		(scoped) => ctx.modelRegistry.find(scoped.model.provider, scoped.model.id) ?? scoped.model,
	);
}

function scopedThinkingPin(ctx: ExtensionContext, model: Model<Api> | undefined): ThinkingLevelName | undefined {
	if (!model) return undefined;
	const scoped = ctx.scopedModels.find((candidate) => candidate.model.provider === model.provider && candidate.model.id === model.id);
	return normalizeThinkingLevel(scoped?.thinkingLevel);
}

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

	const scopeToggle = "__scope_toggle__";
	const otherScope: ModelPickerScope = effectiveScope === "scoped" ? "all" : "scoped";
	const listRows: { key: string; label: string; description?: string; value: string }[] = [];
	if (scoped.length > 0) {
		listRows.push({
			key: scopeToggle,
			label: `Scope: ${effectiveScope === "scoped" ? "scoped" : "all"} → switch to ${otherScope}`,
			description: effectiveScope === "scoped"
				? `showing the ${scoped.length} session-scoped models (same as /model)`
				: `showing all ${available.length} available models`,
			value: scopeToggle,
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
	if (chosen === scopeToggle) return pickExecutionModel(ctx, current, otherScope);
	const ref = parseModelRef(chosen);
	if (!ref) return null;
	return rows.find((row) => row.ref === chosen)?.model ?? ctx.modelRegistry.find(ref.provider, ref.modelId) ?? null;
}

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

export async function seedExecutionSettings(
	runtime: PlanModeRuntime,
	ctx: ExtensionContext,
	path: string | undefined,
): Promise<ResolvedExecutionSettings> {
	const stored = path ? await readPlanExecutionSettings(path) : {};
	const ref = parseModelRef(stored.model);
	const storedModel = ref ? ctx.modelRegistry.find(ref.provider, ref.modelId) : undefined;
	if (stored.model && !storedModel) {
		ctx.ui.notify(`Plan mode: plan's stored model ${stored.model} is not available; defaulting to the current model.`, "warning");
	}
	return {
		model: storedModel ?? ctx.model,
		thinking: stored.thinking ?? normalizeThinkingLevel(runtime.pi.getThinkingLevel()) ?? "off",
		stepMode: stored.stepMode ?? runtime.stepMode,
		executionContext: "",
	};
}

export async function persistExecutionSettings(
	runtime: PlanModeRuntime,
	ctx: ExtensionContext,
	path: string | undefined,
): Promise<void> {
	if (!path) return;
	try {
		const active = ctx.model;
		await writePlanExecutionSettings(path, {
			model: active ? formatModelRef(active.provider, active.id) : undefined,
			thinking: normalizeThinkingLevel(runtime.pi.getThinkingLevel()),
			stepMode: runtime.stepMode,
		});
	} catch {
		// Frontmatter mirroring is best-effort; execution proceeds regardless.
	}
}

export async function showExecutionPreflight(
	runtime: PlanModeRuntime,
	ctx: ExtensionContext,
	seed: ResolvedExecutionSettings & { title?: string },
): Promise<ResolvedExecutionSettings | null> {
	let model = seed.model;
	let thinking = seed.thinking;
	let mode = seed.stepMode;
	let context = seed.executionContext;
	const title = seed.title ? `Execute plan: ${seed.title}` : "Execute plan";

	while (true) {
		const modelLabel = model ? formatModelRef(model.provider, model.id) : "(no model resolved)";
		const pinned = scopedThinkingPin(ctx, model);
		const action = await selectFromList<"model" | "thinking" | "step" | "context" | "start" | "cancel">(
			ctx,
			title,
			[
				{ key: "start", label: "▶ Start execution", value: "start" },
				{ key: "model", label: `Model             ${modelLabel}`, description: model?.name, value: "model" },
				{
					key: "thinking",
					label: `Thinking          ${thinking}${pinned === thinking ? " (pinned by scope)" : ""}`,
					description: "applied on start; pi clamps to what the model supports",
					value: "thinking",
				},
				{
					key: "step",
					label: `After each step   ${stepModeLabel(mode)}`,
					description: mode === "stop"
						? "pause for confirmation after every completed step"
						: "work through the remaining steps without stopping",
					value: "step",
				},
				{
					key: "context",
					label: `Context           ${context.trim() ? "added" : "none"}`,
					description: "add a run-only note for the agent; not saved in plan frontmatter",
					value: "context",
				},
				{ key: "cancel", label: "Cancel", description: "stay in plan mode", value: "cancel" },
			],
			{ hint: "↑↓ navigate • enter change/start • ctrl+n add context • esc cancel", ctrlNKey: "context" },
		);

		if (action === null || action === "cancel") return null;
		if (action === "model") {
			const picked = await pickExecutionModel(ctx, model);
			if (picked) {
				model = picked;
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
		if (action === "context") {
			const edited = await ctx.ui.editor("Execution context for this run:", context);
			if (edited !== undefined) context = edited;
			continue;
		}
		return { model, thinking, stepMode: mode, executionContext: context };
	}
}

export async function applyExecutionSettings(
	runtime: PlanModeRuntime,
	ctx: ExtensionContext,
	settings: ResolvedExecutionSettings,
): Promise<void> {
	const currentModel = ctx.model;
	const currentThinking = normalizeThinkingLevel(runtime.pi.getThinkingLevel()) ?? "off";
	const target = settings.model;
	const modelChanged = target !== undefined &&
		(currentModel === undefined || target.provider !== currentModel.provider || target.id !== currentModel.id);
	const thinkingChanged = settings.thinking !== currentThinking;
	if (!modelChanged && !thinkingChanged) return;

	if (currentModel) runtime.modelSnapshot = { thinkingLevel: currentThinking };
	if (modelChanged && target) {
		let ok = false;
		try {
			ok = await runtime.pi.setModel(target);
		} catch (err) {
			ctx.ui.notify(`Plan mode: could not switch model (${(err as Error).message}).`, "warning");
		}
		if (!ok) {
			ctx.ui.notify(
				`Plan mode: no credentials for ${formatModelRef(target.provider, target.id)}; executing with ${
					currentModel ? formatModelRef(currentModel.provider, currentModel.id) : "the current model"
				}.`,
				"warning",
			);
			if (!thinkingChanged) runtime.modelSnapshot = undefined;
		}
	}

	runtime.pi.setThinkingLevel(settings.thinking);
	const effective = normalizeThinkingLevel(runtime.pi.getThinkingLevel()) ?? "off";
	const thinkingText = effective === settings.thinking
		? `thinking: ${effective}`
		: `thinking: ${effective} (requested ${settings.thinking}, clamped by the model)`;
	const activeModel = ctx.model ?? target;
	ctx.ui.notify(
		`Executing with ${activeModel ? formatModelRef(activeModel.provider, activeModel.id) : "the current model"} (${thinkingText}, after each step: ${stepModeLabel(settings.stepMode)}).`,
		"info",
	);
}
