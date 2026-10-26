// ---------------------------------------------------------------------------
// Execution settings (model / thinking level / step gating)
//
// These describe *how* a plan is executed rather than what it contains. They
// are chosen in the pre-flight panel before execution starts, mirrored into the
// plan file's frontmatter, and - like `todos` - are exclusively
// extension-managed: agents never author them.
// ---------------------------------------------------------------------------

/**
 * Whether the agent continues straight into the next plan step after finishing
 * one (`"continue"`, the default) or stops and waits for the user to confirm
 * (`"stop"`).
 */
export type StepMode = "continue" | "stop";

export const STEP_MODES: readonly StepMode[] = ["continue", "stop"];

/**
 * The thinking levels pi exposes, ordered cheapest-first. Mirrors pi's
 * `ThinkingLevel` union (`off` plus pi-ai's `ThinkingLevel`) but is declared
 * locally so this module stays free of pi imports and remains testable with
 * plain `node --experimental-strip-types`.
 *
 * This is the single source for what the thinking-level picker offers. Plan mode
 * deliberately does **not** derive a per-model subset from `reasoning` /
 * `thinkingLevelMap`: `pi.setThinkingLevel()` already clamps to what the model
 * supports (non-reasoning models resolve to `off`), so reimplementing that rule
 * here could only drift from it. The effective level is read back from
 * `pi.getThinkingLevel()` after applying.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/**
 * Execution settings as stored in a plan file's frontmatter. `model` is a
 * `"provider/modelId"` reference string rather than a resolved model object, so
 * a plan file stays readable and survives catalogue changes (an unknown
 * reference simply falls back to the active model on resume).
 */
export interface PlanExecutionSettings {
	model?: string;
	thinking?: ThinkingLevelName;
	stepMode?: StepMode;
}

/** Renders a provider + model id pair as the canonical `"provider/modelId"` reference. */
export function formatModelRef(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/**
 * Parses a `"provider/modelId"` reference. Splits on the **first** `/` only,
 * because model ids themselves may contain slashes (e.g. OpenRouter-style
 * `openrouter/anthropic/claude-3`). Returns undefined for anything that isn't a
 * non-empty provider plus a non-empty id.
 */
export function parseModelRef(ref: unknown): { provider: string; modelId: string } | undefined {
	if (typeof ref !== "string") return undefined;
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (provider.length === 0 || modelId.length === 0) return undefined;
	return { provider, modelId };
}

/**
 * Coerces an arbitrary value into a `StepMode`, defaulting to `"continue"`
 * (keep going after each step) for anything unrecognized or missing.
 */
export function normalizeStepMode(value: unknown): StepMode {
	if (typeof value !== "string") return "continue";
	const normalized = value.trim().toLowerCase();
	return STEP_MODES.find((mode) => mode === normalized) ?? "continue";
}

/**
 * Coerces an arbitrary value into a known thinking level name, returning
 * undefined (rather than a default) when it isn't one, so callers can decide
 * whether to fall back to the currently active level.
 */
export function normalizeThinkingLevel(value: unknown): ThinkingLevelName | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return THINKING_LEVELS.find((level) => level === normalized);
}

/** Human-readable label for a step mode, used in pickers, widgets and notices. */
export function stepModeLabel(mode: StepMode): string {
	return mode === "stop" ? "stop after each step" : "keep going";
}

/**
 * Minimal structural view of a model needed to build picker rows, so this
 * helper stays free of pi-ai types and unit-testable.
 */
export interface PickableModel {
	provider: string;
	id: string;
	name?: string;
}

export type ModelPickerScope = "scoped" | "all";

export interface ModelPickerRow<T extends PickableModel> {
	/** `"provider/modelId"`, used as the row key. */
	ref: string;
	provider: string;
	id: string;
	name?: string;
	/** True for the model that is currently active. */
	current: boolean;
	model: T;
}

/**
 * Builds the ordered rows for the execution model picker, mirroring pi's own
 * `/model` selector:
 *
 * - `scope: "scoped"` returns the session-scoped models (pi's `--models` flag /
 *   `enabledModels` setting) in their configured order, unfiltered. pi's
 *   selector does not auth-filter the scoped set either, and filtering here
 *   would risk hiding models whose provider authenticates by other means (e.g.
 *   Bedrock via an AWS profile rather than an API key). An unusable choice is
 *   reported later, when `setModel` returns false.
 * - `scope: "all"` returns the available catalogue (models from configured
 *   providers), current model first, then grouped by provider - the same
 *   ordering pi's `sortModels` applies.
 *
 * Kept pure so a test can pin that the scoped scope never drops or reorders a
 * scoped model.
 */
export function buildModelPickerItems<T extends PickableModel>(
	scopedModels: readonly T[],
	availableModels: readonly T[],
	currentModel: PickableModel | undefined,
	scope: ModelPickerScope,
): ModelPickerRow<T>[] {
	const isCurrent = (m: PickableModel): boolean =>
		currentModel !== undefined && m.provider === currentModel.provider && m.id === currentModel.id;
	const toRow = (model: T): ModelPickerRow<T> => ({
		ref: formatModelRef(model.provider, model.id),
		provider: model.provider,
		id: model.id,
		name: model.name,
		current: isCurrent(model),
		model,
	});

	if (scope === "scoped") {
		// Configured order preserved verbatim: this is exactly what `/model` lists.
		return scopedModels.map(toRow);
	}

	const rows = availableModels.map(toRow);
	return rows.sort((a, b) => {
		if (a.current && !b.current) return -1;
		if (!a.current && b.current) return 1;
		return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});
}

