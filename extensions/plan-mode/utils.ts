/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Directory where plan files may be written while in plan mode.
 * Override with PI_PLAN_DIR.
 */
export function planWriteDir(): string {
	const configured = process.env.PI_PLAN_DIR?.trim();
	if (configured) {
		return resolve(expandHome(configured));
	}
	return resolve(homedir(), ".pi", "plans");
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return p;
}

/**
 * Resolves a (possibly relative, possibly `~`-prefixed) path to an absolute
 * path, relative paths resolved against `cwd`. Shared by `isPlanFilePath`
 * and callers that need to know a plan file's real on-disk path (e.g. to
 * track it as the currently active plan).
 */
export function resolvePlanPath(path: string, cwd: string): string {
	const expanded = expandHome(path.trim());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Renders an absolute path with the user's home directory collapsed to
 * `~`, for display purposes only (e.g. notifications).
 */
export function toDisplayPath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + sep)) return `~${p.slice(home.length)}`;
	return p;
}

/**
 * True when `path` is a markdown file inside the plans directory.
 * Relative paths are resolved against `cwd`.
 */
export function isPlanFilePath(path: unknown, cwd: string, dir: string = planWriteDir()): boolean {
	if (typeof path !== "string" || path.trim() === "") return false;
	const abs = resolvePlanPath(path, cwd);
	if (abs !== dir && !abs.startsWith(dir + sep)) return false;
	return abs.toLowerCase().endsWith(".md");
}

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

export interface SavedPlan {
	/** Filename relative to the plans directory, e.g. "2026-07-30-foo.md" */
	name: string;
	/** Absolute path on disk. */
	path: string;
	mtimeMs: number;
	/** Title from frontmatter, falling back to the first markdown heading, if any. */
	title?: string;
	/** Repo name from frontmatter, if present. */
	repo?: string;
	/** Date from frontmatter, falling back to the filename's date prefix, if any. */
	date?: string;
	/** Todo/progress list from frontmatter, if present and non-empty. */
	todos?: TodoItem[];
}

/**
 * Structured plan metadata stored as YAML-ish frontmatter at the top of a
 * plan file, delimited by `---` fences. All fields are optional; a plan
 * file without a frontmatter block at all is fully supported (every field
 * comes back undefined) for backward compatibility with plans saved before
 * this feature existed.
 */
export interface PlanFrontmatter {
	repo?: string;
	title?: string;
	date?: string;
	/**
	 * Model the plan was last executed with, as a `"provider/modelId"` reference.
	 * Like `todos`, this field is exclusively written by the extension (from the
	 * pre-flight panel) and never authored by an agent.
	 */
	model?: string;
	/**
	 * Thinking level the plan was last executed with. Extension-managed, see
	 * `model` above.
	 */
	thinking?: ThinkingLevelName;
	/**
	 * Whether execution stops after each completed step or keeps going.
	 * Extension-managed, see `model` above.
	 */
	stepMode?: StepMode;
	/**
	 * Progress list, stored as a single-line JSON array value (not a nested
	 * YAML list) so it can be parsed/serialized with plain JSON.parse/
	 * JSON.stringify. This field is exclusively written by the plan-mode
	 * extension itself (via `writePlanTodos`) - agents should never hand-edit
	 * it; they keep using `[DONE:n]` chat tags as today.
	 */
	todos?: TodoItem[];
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function isValidTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.step === "number" && typeof v.text === "string" && typeof v.completed === "boolean";
}

function parseFrontmatterValue(key: string, rawValue: string): string | TodoItem[] | undefined {
	if (key === "todos") {
		try {
			const parsed = JSON.parse(rawValue);
			if (!Array.isArray(parsed)) return undefined;
			const items = parsed.filter(isValidTodoItem);
			return items.length > 0 ? items : undefined;
		} catch {
			return undefined;
		}
	}
	const trimmed = rawValue.trim();
	const unquoted = trimmed.match(/^(['"])(.*)\1$/);
	return unquoted ? unquoted[2] : trimmed;
}

/**
 * Parses a leading YAML-ish frontmatter block (`---` fenced) off the top of
 * a plan file's content, returning the recognized `repo`/`title`/`date`/
 * `todos` fields plus the remaining body (with the frontmatter block
 * stripped). Returns `{ frontmatter: {}, body: content }` unchanged when no
 * frontmatter block is present, so callers can treat every plan file
 * uniformly regardless of whether it predates this feature.
 */
export function parseFrontmatter(content: string): { frontmatter: PlanFrontmatter; body: string } {
	const match = content.match(FRONTMATTER_BLOCK);
	if (!match) return { frontmatter: {}, body: content };

	const frontmatter: PlanFrontmatter = {};
	const block = match[1] ?? "";
	for (const line of block.split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const key = kv[1]?.toLowerCase();
		const rawValue = kv[2] ?? "";
		if (key === "repo" || key === "title" || key === "date") {
			const value = parseFrontmatterValue(key, rawValue);
			if (typeof value === "string" && value.length > 0) frontmatter[key] = value;
		} else if (key === "model") {
			// Only accept well-formed "provider/modelId" references; anything else is
			// dropped silently, the same way an unparseable `todos` value is.
			const value = parseFrontmatterValue(key, rawValue);
			if (typeof value === "string" && parseModelRef(value)) frontmatter.model = value;
		} else if (key === "thinking") {
			const level = normalizeThinkingLevel(parseFrontmatterValue(key, rawValue));
			if (level) frontmatter.thinking = level;
		} else if (key === "stepmode") {
			// Unknown values are dropped rather than normalized, so callers can tell
			// "file explicitly says keep going" from "file says nothing".
			const value = parseFrontmatterValue(key, rawValue);
			if (typeof value === "string" && STEP_MODES.includes(value.trim().toLowerCase() as StepMode)) {
				frontmatter.stepMode = normalizeStepMode(value);
			}
		} else if (key === "todos") {
			const value = parseFrontmatterValue(key, rawValue);
			if (Array.isArray(value)) frontmatter.todos = value;
		}
	}

	return { frontmatter, body: content.slice(match[0].length) };
}

/**
 * Quotes a scalar frontmatter value when it contains characters that would
 * otherwise be ambiguous/unsafe in a simple `key: value` line.
 */
function yamlScalar(value: string): string {
	if (/[:#\-?[\]{}"',]/.test(value) || value.trim() !== value || value === "") {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return value;
}

/**
 * Serializes plan frontmatter fields back into a `---` fenced block
 * (including the trailing blank line before the body). Only fields that are
 * set are emitted; an entirely empty `fm` still produces a valid (empty)
 * frontmatter block, since callers always know they want one.
 */
export function stringifyFrontmatter(fm: PlanFrontmatter): string {
	const lines = ["---"];
	if (fm.repo) lines.push(`repo: ${yamlScalar(fm.repo)}`);
	if (fm.title) lines.push(`title: ${yamlScalar(fm.title)}`);
	if (fm.date) lines.push(`date: ${fm.date}`);
	if (fm.model) lines.push(`model: ${yamlScalar(fm.model)}`);
	if (fm.thinking) lines.push(`thinking: ${fm.thinking}`);
	if (fm.stepMode) lines.push(`stepMode: ${fm.stepMode}`);
	if (fm.todos && fm.todos.length > 0) lines.push(`todos: ${JSON.stringify(fm.todos)}`);
	lines.push("---", "");
	return lines.join("\n");
}

/**
 * Extracts the `YYYY-MM-DD` date prefix from a plan filename like
 * `2026-07-30-task-summary.md`, used as a fallback `date` for plans saved
 * before frontmatter existed.
 */
export function extractDateFromFilename(name: string): string | undefined {
	const match = name.match(/^(\d{4}-\d{2}-\d{2})-/);
	return match?.[1];
}

/**
 * Last-resort title derivation from a plan filename: strips the date prefix
 * and extension, replaces dashes with spaces, and capitalizes the first
 * letter. Used when neither frontmatter nor a markdown heading supplies a
 * title.
 */
export function deriveTitleFromFilename(name: string): string {
	const withoutExt = name.replace(/\.md$/i, "");
	const withoutDate = withoutExt.replace(/^\d{4}-\d{2}-\d{2}-/, "");
	const spaced = withoutDate.replace(/[-_]+/g, " ").trim();
	if (spaced.length === 0) return withoutExt;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Slugifies arbitrary text for use in a generated plan filename: lowercase,
 * non-alphanumeric runs collapsed to single dashes, leading/trailing dashes
 * trimmed, capped to a reasonable length.
 */
export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (slug.length > 0 ? slug : "plan").slice(0, 60).replace(/-+$/g, "");
}

/** Builds the date-prefixed filename used for a newly saved plan. */
export function planFilename(name: string, date: string, sequence = 1): string {
	const suffix = sequence > 1 ? `-${sequence}` : "";
	return `${date}-${slugify(name)}${suffix}.md`;
}

export interface PlanContentDefaults {
	repo: string;
	title: string;
	date: string;
	/** Existing extension-managed metadata to retain during a body rewrite. */
	previous?: PlanFrontmatter;
	/** Use the supplied date even when content already has a date field. */
	forceDate?: boolean;
}

/**
 * Normalizes plan content into the extension's frontmatter convention. Agent
 * authored identity metadata is retained when present, while extension-managed
 * settings survive rewrites and todos are derived from the Plan section.
 */
export function normalizePlanContent(
	content: string,
	defaults: PlanContentDefaults,
): { content: string; frontmatter: PlanFrontmatter; todos: TodoItem[] } {
	const { frontmatter, body } = parseFrontmatter(content);
	const previous = defaults.previous;
	frontmatter.repo ??= defaults.repo;
	frontmatter.title ??= extractPlanTitle(body) ?? defaults.title;
	if (defaults.forceDate || !frontmatter.date) frontmatter.date = defaults.date;
	frontmatter.model ??= previous?.model;
	frontmatter.thinking ??= previous?.thinking;
	frontmatter.stepMode ??= previous?.stepMode;
	frontmatter.todos ??= previous?.todos;

	const bodyTodos = extractTodoItems(body);
	if (bodyTodos.length > 0) frontmatter.todos = mergeTodoCompletion(bodyTodos, frontmatter.todos);

	return {
		content: stringifyFrontmatter(frontmatter) + body,
		frontmatter,
		todos: frontmatter.todos ?? [],
	};
}

/**
 * Best-effort repo name detection: parses `git remote get-url origin` (works
 * for both SSH `git@host:org/repo.git` and HTTPS `https://host/org/repo.git`
 * remote URL forms), falling back to the cwd folder's basename when there's
 * no git repo, no `origin` remote, `git` isn't installed, or the command
 * times out.
 */
export async function detectRepoName(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: 2000 });
		const url = stdout.trim().replace(/\.git$/, "");
		const name = url.split(/[/:]/).filter(Boolean).pop();
		if (name) return name;
	} catch {
		// Not a git repo, no origin remote, git missing, or timed out - fall back below.
	}
	return basename(cwd);
}

/**
 * Best-effort title extraction: the text of the first markdown heading
 * (`#` .. `######`) among the first 20 lines of the file. Returns undefined
 * when no heading is found nearby (e.g. plan doesn't follow the convention).
 */
export function extractPlanTitle(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < Math.min(lines.length, 20); i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

/**
 * Reads a plan file and parses its frontmatter/body. Returns `null` on any
 * read error (e.g. the file was moved/deleted since it was last known about)
 * instead of throwing, so callers can treat that as "nothing to sync".
 */
export async function readPlanFrontmatter(
	path: string,
): Promise<{ frontmatter: PlanFrontmatter; body: string } | null> {
	try {
		return parseFrontmatter(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Writes an updated `todos` list into a plan file's frontmatter, preserving
 * every other frontmatter field and the body unchanged. This is direct
 * filesystem I/O performed by the extension itself - not routed through the
 * `write`/`edit` tool pipeline - since `todos` is exclusively extension-
 * managed. Returns `true` on success, `false` on any failure (file missing,
 * permission error, etc.) without throwing, so callers can treat a failed
 * sync as non-fatal.
 */
export async function writePlanTodos(path: string, todos: TodoItem[]): Promise<boolean> {
	const current = await readPlanFrontmatter(path);
	if (!current) return false;
	try {
		const merged: PlanFrontmatter = { ...current.frontmatter, todos };
		await writeFile(path, stringifyFrontmatter(merged) + current.body, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Merges execution settings (`model`/`thinking`/`stepMode`) into a plan file's
 * frontmatter, preserving every other frontmatter field - notably `todos` - and
 * the body unchanged. Only keys present in `settings` are touched, so a caller
 * can persist just `stepMode` without disturbing a stored model.
 *
 * Like `writePlanTodos`, this is direct filesystem I/O performed by the
 * extension (not routed through the write/edit tool pipeline) because these
 * fields are exclusively extension-managed, and it returns `false` instead of
 * throwing so a failed sync is never fatal.
 */
export async function writePlanExecutionSettings(path: string, settings: PlanExecutionSettings): Promise<boolean> {
	const current = await readPlanFrontmatter(path);
	if (!current) return false;
	try {
		const merged: PlanFrontmatter = { ...current.frontmatter };
		if (settings.model !== undefined) merged.model = settings.model;
		if (settings.thinking !== undefined) merged.thinking = settings.thinking;
		if (settings.stepMode !== undefined) merged.stepMode = settings.stepMode;
		await writeFile(path, stringifyFrontmatter(merged) + current.body, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Reads the execution settings stored in a plan file's frontmatter, used to
 * pre-seed the pre-flight panel when resuming a plan. Returns an empty object
 * when the file is unreadable or stores none of these fields.
 */
export async function readPlanExecutionSettings(path: string): Promise<PlanExecutionSettings> {
	const current = await readPlanFrontmatter(path);
	if (!current) return {};
	const { model, thinking, stepMode } = current.frontmatter;
	return { model, thinking, stepMode };
}

/**
 * Merges a freshly extracted todo list with a previously stored one, carrying
 * over `completed` flags for steps whose text still matches. Used so that
 * re-stamping a plan file's frontmatter (e.g. after the plan body is refined)
 * never resets progress that was already recorded.
 */
export function mergeTodoCompletion(next: TodoItem[], previous: TodoItem[] | undefined): TodoItem[] {
	if (!previous || previous.length === 0) return next;
	return next.map((item) => {
		const match =
			previous.find((p) => p.step === item.step && p.text === item.text) ??
			previous.find((p) => p.text === item.text);
		return match ? { ...item, completed: match.completed } : item;
	});
}

/**
 * Derives the `todos` frontmatter of a plan file from its own body (the
 * numbered list under the "Plan:" header) and writes it back, preserving the
 * completion state of steps that already existed. This is what keeps a plan
 * file's progress list in sync *as the plan is written*, rather than only once
 * execution starts.
 *
 * Returns the resulting todo list (possibly the untouched existing one), or an
 * empty array when the file can't be read or has no recognizable plan steps.
 */
export async function syncPlanTodosFromBody(path: string): Promise<TodoItem[]> {
	const current = await readPlanFrontmatter(path);
	if (!current) return [];

	const bodyTodos = extractTodoItems(current.body);
	if (bodyTodos.length === 0) return current.frontmatter.todos ?? [];

	const merged = mergeTodoCompletion(bodyTodos, current.frontmatter.todos);
	const unchanged = JSON.stringify(merged) === JSON.stringify(current.frontmatter.todos ?? []);
	if (unchanged) return merged;

	await writePlanTodos(path, merged);
	return merged;
}

/**
 * Lists saved plan markdown files in `dir`, newest first (by modification
 * time, falling back to filename for ties). Returns an empty list if the
 * directory does not exist.
 */
export async function listSavedPlans(dir: string = planWriteDir()): Promise<SavedPlan[]> {
	let entries: string[];
	try {
		const dirents = await readdir(dir, { withFileTypes: true });
		entries = dirents.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md")).map((d) => d.name);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const plans = await Promise.all(
		entries.map(async (name) => {
			const path = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = (await stat(path)).mtimeMs;
			} catch {
				// Ignore races where the file disappears between readdir and stat.
			}
			let title: string | undefined;
			let repo: string | undefined;
			let date: string | undefined;
			let todos: TodoItem[] | undefined;
			try {
				const content = await readFile(path, "utf8");
				const { frontmatter, body } = parseFrontmatter(content);
				title = frontmatter.title ?? extractPlanTitle(body) ?? deriveTitleFromFilename(name);
				repo = frontmatter.repo;
				date = frontmatter.date ?? extractDateFromFilename(name);
				todos = frontmatter.todos;
			} catch {
				// Ignore unreadable files; fields just stay undefined.
			}
			return { name, path, mtimeMs, title, repo, date, todos };
		}),
	);

	return plans.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

// ---------------------------------------------------------------------------
// Read-only bash gating
//
// Plan mode allows bash, but only commands that cannot mutate the workspace.
// The check is structural rather than a substring scan: the command line is
// split into segments (quote-aware), each segment's *command word* is matched
// against an allowlist, redirections must target /dev/null or an existing fd,
// and command substitutions are validated recursively. Nothing inside quoted
// arguments can trip the gate, so patterns like
// `rg -ln "Create|OutOfBand" && gh pr view 281 2>&1 | head` are allowed.
// ---------------------------------------------------------------------------

/**
 * Placeholder substituted for `$(...)`/backtick/process-substitution bodies so
 * the surrounding segment can be tokenized without the nested command leaking
 * into it. The nested command is validated separately.
 */
const SUBST_TOKEN = "__pi_subst__";
/** Placeholder substituted for quoted string spans while tokenizing. */
const QUOTED_TOKEN = "__pi_str__";

/**
 * Commands allowed in plan mode. `true` means any arguments are fine; a RegExp
 * is tested against the argument string (everything after the command word,
 * whitespace-normalized, quoted spans masked) and must match for the command
 * to be allowed.
 */
const SAFE_COMMANDS: Record<string, true | RegExp> = {
	// --- file/text reading -------------------------------------------------
	cat: true,
	tac: true,
	head: true,
	tail: true,
	less: true,
	more: true,
	bat: true,
	nl: true,
	rev: true,
	strings: true,
	xxd: true,
	hexdump: true,
	od: true,
	base64: true,
	// --- search / listing ---------------------------------------------------
	grep: true,
	egrep: true,
	fgrep: true,
	rg: true,
	ag: true,
	fd: true,
	fdfind: true,
	find: true,
	ls: true,
	eza: true,
	exa: true,
	tree: true,
	// --- text processing ----------------------------------------------------
	wc: true,
	sort: true,
	uniq: true,
	cut: true,
	tr: true,
	paste: true,
	comm: true,
	join: true,
	column: true,
	fold: true,
	expand: true,
	unexpand: true,
	diff: true,
	jq: true,
	yq: true,
	awk: true,
	sed: /^-n\b/,
	seq: true,
	// --- path / metadata ----------------------------------------------------
	pwd: true,
	cd: true,
	basename: true,
	dirname: true,
	realpath: true,
	readlink: true,
	file: true,
	stat: true,
	du: true,
	df: true,
	which: true,
	whereis: true,
	whatis: true,
	man: true,
	tldr: true,
	type: true,
	md5: true,
	md5sum: true,
	shasum: true,
	sha256sum: true,
	cksum: true,
	// --- shell/system info --------------------------------------------------
	echo: true,
	printf: true,
	env: /^$/,
	printenv: true,
	uname: true,
	hostname: true,
	whoami: true,
	id: true,
	groups: true,
	locale: true,
	date: true,
	cal: true,
	uptime: true,
	ps: true,
	top: true,
	htop: true,
	free: true,
	sleep: true,
	true: true,
	false: true,
	pbpaste: true,
	// --- version control (read-only subcommands only) -----------------------
	git: /^(?:status|log|diff|diff-tree|show|blame|annotate|describe|shortlog|whatchanged|reflog|rev-parse|rev-list|merge-base|name-rev|cat-file|count-objects|for-each-ref|show-ref|symbolic-ref|ls-files|ls-tree|ls-remote|grep|check-ignore|verify-commit|version|help|branch(?!\s+(?:-[dDmMcCfF]|--delete|--move|--copy|--force|--set-upstream))|remote(?:\s+(?:-v|--verbose|show|get-url)\b|\s*$)|tag\s+(?:-l|--list)\b|stash\s+(?:list|show)\b|worktree\s+list\b|submodule\s+status\b|notes\s+(?:list|show)\b|bisect\s+log\b|config\s+(?:--get|--get-all|--get-regexp|--list|-l)\b)/i,
	// GitHub CLI: read-only subcommands. Lets plan mode research prior work
	// (`gh pr view/list/diff`, `gh issue view`, `gh api` GETs, ...) while
	// keeping mutations (`pr create/merge/checkout`, `run rerun`, ...) blocked.
	gh: /^(?:pr\s+(?:view|list|diff|checks|status)\b|issue\s+(?:view|list|status)\b|repo\s+(?:view|list)\b|release\s+(?:view|list)\b|run\s+(?:view|list)\b|workflow\s+(?:view|list)\b|label\s+list\b|project\s+(?:view|list|item-list)\b|gist\s+(?:view|list)\b|cache\s+list\b|variable\s+list\b|search\s+\S+|api\b|auth\s+status\b|status\b|version\b|--version\b)/i,
	// --- language/tooling info (nothing that builds, installs or generates) --
	go: /^(?:env|list|version|doc|vet|mod\s+(?:graph|why|verify))\b/i,
	node: /^(?:-v|--version|-e\s)/i,
	npm: /^(?:list|ls|view|info|search|outdated|audit|why|explain|root|prefix|config\s+get|-v|--version)\b/i,
	yarn: /^(?:list|info|why|audit|-v|--version)\b/i,
	pnpm: /^(?:list|ls|why|outdated|audit|-v|--version)\b/i,
	python: /^(?:-V|--version|-c\s)/,
	python3: /^(?:-V|--version|-c\s)/,
	pip: /^(?:show|list|freeze|-V|--version)\b/i,
	pip3: /^(?:show|list|freeze|-V|--version)\b/i,
	cargo: /^(?:tree|metadata|-V|--version)\b/i,
	tsc: /^(?:--noEmit|-v|--version)\b/i,
	make: /^-n\b/,
	just: /^--list\b/,
	docker: /^(?:ps|images|inspect|logs|version)\b/i,
	kubectl: /^(?:get|describe|logs|top|explain|api-resources|version|config\s+(?:get-contexts|current-context|view))\b/i,
	helm: /^(?:list|get|status|template|version)\b/i,
	// --- network reads ------------------------------------------------------
	curl: true,
	wget: /^-O\s*-/,
};

/**
 * Argument patterns that turn an otherwise-allowlisted command into a writing
 * command. Tested against the raw (unmasked) argument string so quoted program
 * bodies - e.g. an `awk` script redirecting into a file - are covered too.
 */
const UNSAFE_ARG_RULES: Record<string, { pattern: RegExp; reason: string }[]> = {
	find: [
		{
			pattern: /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
			reason: "`find` may not run or delete anything in plan mode (-exec/-delete/-fprint)",
		},
	],
	fd: [
		{
			pattern: /(?:^|\s)(?:-x|-X|--exec|--exec-batch)\b/,
			reason: "`fd --exec` runs arbitrary commands",
		},
	],
	rg: [{ pattern: /(?:^|\s)--pre\b/, reason: "`rg --pre` runs an arbitrary preprocessor binary" }],
	awk: [{ pattern: /print[^;}]*>/, reason: "`awk` program redirects output into a file" }],
	sed: [{ pattern: /(?:^|\s)(?:-i|--in-place)/, reason: "`sed -i` edits files in place" }],
	curl: [
		{
			pattern: /(?:^|\s)(?:-o|-O|--output|--output-dir|--remote-name|--remote-header-name|-T|--upload-file|--config|-K)\b/,
			reason: "`curl` may not write files or upload in plan mode",
		},
		{
			pattern: /(?:^|\s)(?:-d|--data\S*|-F|--form\S*)\b/,
			reason: "`curl` may only make read requests in plan mode (no request body)",
		},
		{
			pattern: /(?:^|\s)(?:-X|--request)\s+(?!GET\b)/i,
			reason: "`curl` may only use GET in plan mode",
		},
	],
	gh: [
		{
			pattern: /(?:^|\s)(?:-X|--method)\s+(?!GET\b)/i,
			reason: "`gh api` may only use GET in plan mode",
		},
		{
			pattern: /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b/,
			reason: "`gh api` fields imply a mutating request",
		},
		{ pattern: /(?:^|\s)graphql\b.*\bmutation\b/i, reason: "`gh api graphql` mutation is not read-only" },
	],
	git: [{ pattern: /(?:^|\s)(?:--exec|--upload-pack|--receive-pack)\b/, reason: "`git` exec flags run commands" }],
};

/**
 * Commands that are definitely writing/destructive, kept only so the block
 * message can explain *why* instead of the generic "not allowlisted".
 */
const KNOWN_WRITE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"split",
	"sudo",
	"su",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"systemctl",
	"service",
	"launchctl",
	"vi",
	"vim",
	"nano",
	"emacs",
	"code",
	"subl",
	"xargs",
	"eval",
	"exec",
	"sh",
	"bash",
	"zsh",
	"fish",
	"apt",
	"apt-get",
	"brew",
	"shuttle",
	"lunarctl",
]);

/**
 * Shell keywords that may prefix a real command (`if rg -q x file`,
 * `do cat $f`, `time git log`). They are dropped so the command that actually
 * runs is the one checked against the allowlist.
 */
const SKIPPABLE_PREFIX_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "command", "nohup"]);

/**
 * Shell keywords that form a block header/terminator rather than a command.
 * Any command substitution inside them is still validated separately, so the
 * header itself can never run something unchecked.
 */
const BLOCK_KEYWORDS = new Set(["for", "select", "case", "in", "done", "fi", "esac", "function"]);

/** Redirection targets that don't write to a real file. */
const ALLOWED_REDIRECT_TARGET = /^(?:&\d+|&-|\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/dev\/fd\/\d+)$/;

const REDIRECT_PATTERN = /(?:\d+|&)?>{1,2}\s*([^\s;|]*)/g;
const INPUT_REDIRECT_PATTERN = /<{1,3}\s*[^\s;|]*/g;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface ParsedShell {
	/** Top-level command segments (split on `&&`, `||`, `|`, `;`, `&`, newlines). */
	segments: string[];
	/** Bodies of `$(...)`, backtick and process substitutions, validated recursively. */
	substitutions: string[];
	/** Set when the command line itself is structurally disallowed. */
	problem?: string;
}

/**
 * Removes heredoc bodies (`cmd <<EOF ... EOF`) from a command line so their
 * content is treated as data instead of being parsed as further commands. The
 * introducing line - including any redirection on it - is kept.
 */
function stripHeredocBodies(source: string): string {
	const lines = source.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		out.push(line);
		i++;
		const markers = [...line.matchAll(/<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)]
			.map((m) => m[2])
			.filter((m): m is string => m !== undefined);
		for (const marker of markers) {
			while (i < lines.length && (lines[i] as string).trim() !== marker) i++;
			if (i < lines.length) i++; // drop the terminator line too
		}
	}
	return out.join("\n");
}

/** Reads a parenthesized span starting at `open` (which must be `(`). */
function readBalanced(source: string, open: number): { inner: string; end: number } {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return { inner: source.slice(open + 1, i), end: i + 1 };
		}
	}
	return { inner: source.slice(open + 1), end: source.length };
}

/**
 * Quote-aware split of a command line into segments, lifting command
 * substitutions out into their own list. Unlike a naive `split(/&&|\|/)` this
 * never splits inside quotes, so regex alternations in `rg`/`grep` patterns
 * stay intact.
 */
function parseShell(command: string): ParsedShell {
	const segments: string[] = [];
	const substitutions: string[] = [];
	let problem: string | undefined;
	const source = stripHeredocBodies(command.replace(/\\\r?\n/g, " "));

	let current = "";
	const push = (): void => {
		const trimmed = current.trim();
		if (trimmed.length > 0) segments.push(trimmed);
		current = "";
	};

	let quote: "'" | '"' | null = null;
	let i = 0;
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];

		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && next !== undefined) {
				current += next;
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			current += ch + next;
			i += 2;
			continue;
		}
		if (ch === "$" && next === "(") {
			const { inner, end } = readBalanced(source, i + 1);
			substitutions.push(inner);
			current += SUBST_TOKEN;
			i = end;
			continue;
		}
		if (ch === "`") {
			const end = source.indexOf("`", i + 1);
			substitutions.push(end === -1 ? source.slice(i + 1) : source.slice(i + 1, end));
			current += SUBST_TOKEN;
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if ((ch === "<" || ch === ">") && next === "(") {
			const { inner, end } = readBalanced(source, i + 1);
			if (ch === ">") problem ??= "process substitution `>(...)` writes command output";
			substitutions.push(inner);
			current += SUBST_TOKEN;
			i = end;
			continue;
		}
		// `2>&1`, `&>/dev/null`: the `&` belongs to a redirection, not a separator.
		if (ch === "&" && (next === ">" || current.trimEnd().endsWith(">"))) {
			current += ch;
			i++;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			push();
			i += 2;
			continue;
		}
		if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
			push();
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	push();
	if (quote) problem ??= "unbalanced quote";

	return { segments, substitutions, problem };
}

/** Replaces quoted spans with a single placeholder token. */
function maskQuoted(text: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === "\\" && quote === '"') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += QUOTED_TOKEN;
			continue;
		}
		out += ch;
	}
	return out;
}

/** Returns a reason string when `segment` is not a safe read-only command. */
function checkSegment(segment: string): string | null {
	const masked = maskQuoted(segment)
		.replace(/^[({!\s]+/, "")
		.replace(/[)}\s]+$/, "");

	for (const match of masked.matchAll(REDIRECT_PATTERN)) {
		const target = (match[1] ?? "").trim();
		if (!ALLOWED_REDIRECT_TARGET.test(target)) {
			return `output redirection to "${target || "(empty)"}" writes to disk`;
		}
	}

	const commandText = masked.replace(REDIRECT_PATTERN, " ").replace(INPUT_REDIRECT_PATTERN, " ");
	const tokens = commandText.split(/\s+/).filter((t) => t.length > 0 && t !== "(" && t !== ")" && t !== "!");
	while (tokens.length > 0 && ASSIGNMENT_PATTERN.test(tokens[0] as string)) tokens.shift();
	while (tokens.length > 0 && SKIPPABLE_PREFIX_WORDS.has(tokens[0] as string)) tokens.shift();
	// A bare `VAR=value`, block keyword or redirect runs nothing.
	if (tokens.length === 0) return null;
	if (BLOCK_KEYWORDS.has(tokens[0] as string)) return null;

	const commandWord = (tokens[0] as string).replace(/^.*\//, "");
	if (commandWord.startsWith(SUBST_TOKEN)) {
		return "the command name comes from a command substitution, which cannot be verified";
	}

	const rule = SAFE_COMMANDS[commandWord];
	if (rule === undefined) {
		if (KNOWN_WRITE_COMMANDS.has(commandWord)) {
			return `\`${commandWord}\` can modify the system and is not allowed in plan mode`;
		}
		return `\`${commandWord}\` is not on the plan-mode read-only allowlist`;
	}

	const maskedArgs = tokens.slice(1).join(" ");
	if (rule instanceof RegExp && !rule.test(maskedArgs)) {
		return `\`${commandWord} ${maskedArgs}\`.trim() is not an allowlisted read-only \`${commandWord}\` invocation`;
	}

	const rawArgs = segment.trim().replace(/^\S+\s*/, "");
	for (const { pattern, reason } of UNSAFE_ARG_RULES[commandWord] ?? []) {
		if (pattern.test(rawArgs)) return reason;
	}
	return null;
}

export interface CommandSafety {
	safe: boolean;
	/** Human/model-readable explanation when `safe` is false. */
	reason?: string;
}

/**
 * Validates a bash command line for plan mode: every segment must run an
 * allowlisted read-only command, redirections may only target /dev/null or an
 * existing file descriptor, and nested command substitutions are validated the
 * same way (up to a small recursion depth).
 */
export function checkCommandSafety(command: string, depth = 0): CommandSafety {
	if (command.trim().length === 0) return { safe: false, reason: "empty command" };

	const { segments, substitutions, problem } = parseShell(command);
	if (problem) return { safe: false, reason: problem };
	if (segments.length === 0) return { safe: false, reason: "no command found" };

	for (const segment of segments) {
		const reason = checkSegment(segment);
		if (reason) return { safe: false, reason };
	}

	if (depth >= 3) {
		return { safe: false, reason: "command substitutions nested too deeply to verify" };
	}
	for (const substitution of substitutions) {
		if (substitution.trim().length === 0) continue;
		const nested = checkCommandSafety(substitution, depth + 1);
		if (!nested.safe) {
			return { safe: false, reason: `inside \`$(...)\`: ${nested.reason}` };
		}
	}

	return { safe: true };
}

export function isSafeCommand(command: string): boolean {
	return checkCommandSafety(command).safe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

/**
 * Maximum length of a rendered todo label. Long enough to stay meaningful in
 * the progress widget and in "Start with: ..." execution prompts.
 */
const MAX_STEP_TEXT_LENGTH = 70;

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // Collapse links to their text
		.replace(/\s+/g, " ")
		.replace(/[\s,;:.]+$/, "")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > MAX_STEP_TEXT_LENGTH) {
		const hard = cleaned.slice(0, MAX_STEP_TEXT_LENGTH - 3);
		const lastSpace = hard.lastIndexOf(" ");
		const body = lastSpace > MAX_STEP_TEXT_LENGTH / 2 ? hard.slice(0, lastSpace) : hard;
		cleaned = `${body.replace(/[\s,;:.]+$/, "")}...`;
	}
	return cleaned;
}

/**
 * Extracts the numbered steps of a plan from the text following a "Plan:"
 * header. The header may be plain ("Plan:"), bold ("**Plan:**"), or a
 * markdown heading ("## Plan", "### Plan:", ...), and the trailing colon is
 * optional in every form, since models drift on the exact header style even
 * when instructed otherwise. Steps may span multiple lines - indented
 * continuation lines (and nested bullets) are folded into the step they
 * belong to, so the resulting label summarizes the whole step rather than
 * just its first line.
 */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/^[ \t]{0,3}#{0,6}[ \t]*\*{0,2}Plan:?\*{0,2}[ \t]*\r?\n/im);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);

	let current: string | null = null;
	const flush = (): void => {
		if (current === null) return;
		const raw = current.trim().replace(/\*{1,2}$/, "").trim();
		current = null;
		if (raw.length <= 5 || raw.startsWith("`") || raw.startsWith("/") || raw.startsWith("-")) return;
		const cleaned = cleanStepText(raw);
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	};

	for (const line of planSection.split(/\r?\n/)) {
		// A top-level numbered item starts a new step (deeper indentation is
		// treated as continuation of the current one).
		const numbered = line.match(/^ {0,3}(\d+)[.)]\s+(.*)$/);
		if (numbered) {
			flush();
			current = numbered[2] ?? "";
			continue;
		}
		if (current === null) continue;
		if (line.trim().length === 0 || !/^\s/.test(line)) {
			// Blank line or an unindented line (prose, heading, ...) ends the step.
			flush();
			continue;
		}
		current += ` ${line.trim().replace(/^[-*]\s*/, "")}`;
	}
	flush();

	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

/**
 * A single line of the compact progress widget, described structurally so the
 * theming (colors, glyphs) stays in `index.ts` and this module remains free of
 * `ctx.ui` - which is what makes it unit-testable like the other helpers here.
 */
export type TodoWidgetRow =
	| { kind: "summary"; completed: number; remaining: number; total: number }
	| { kind: "current"; step: number; text: string }
	| { kind: "pending"; step: number; text: string }
	| { kind: "more"; count: number };

/**
 * Maximum number of todo rows the compact widget emits.
 *
 * pi's TUI hard-caps string-array widgets at `InteractiveMode.MAX_WIDGET_LINES`
 * (10) and replaces the overflow with a `... (widget truncated)` line - which
 * used to swallow exactly the steps still to do, since completed ones render
 * first. Staying at 8 leaves room for the trailing `after each step: ...` line
 * that `index.ts` appends (9 lines total) plus one spare line, so the widget
 * never trips the truncation even if another footer line shows up later.
 */
export const MAX_TODO_WIDGET_ROWS = 8;

/**
 * Condenses a plan's todo list into at most `maxRows` widget rows: a progress
 * summary, the step being worked on, the next few pending steps and a `+N more`
 * tail. The full list stays available through `/todos`.
 */
export function buildTodoWidgetRows(todos: TodoItem[], options: { maxRows?: number } = {}): TodoWidgetRow[] {
	const maxRows = options.maxRows ?? MAX_TODO_WIDGET_ROWS;
	// Nothing to show, or no room to show it in.
	if (todos.length === 0 || maxRows <= 0) return [];

	const completed = todos.filter((t) => t.completed).length;
	const remainingItems = todos.filter((t) => !t.completed);
	const rows: TodoWidgetRow[] = [
		{ kind: "summary", completed, remaining: remainingItems.length, total: todos.length },
	];
	// Nothing left to do: the summary alone tells the whole story, and there is
	// no current step to highlight. Same when the budget only fits the summary.
	if (remainingItems.length === 0 || maxRows === 1) return rows;

	for (const [index, item] of remainingItems.entries()) {
		const unshown = remainingItems.length - index;
		// The last available row has to account for everything still unshown, so
		// it becomes a `+N more` tail rather than yet another step. The current
		// step always wins its row first, so a two-row budget degrades to
		// summary + current (the summary already carries the `M left` count)
		// rather than summary + `more`.
		if (rows.length === maxRows - 1 && unshown > 1 && index > 0) {
			rows.push({ kind: "more", count: unshown });
			break;
		}
		if (rows.length >= maxRows) break;
		rows.push({ kind: index === 0 ? "current" : "pending", step: item.step, text: item.text });
	}

	return rows;
}
