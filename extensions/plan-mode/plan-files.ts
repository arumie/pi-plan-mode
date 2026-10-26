import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanExecutionSettings } from "./plan-settings.ts";
import { planWriteDir, extractDateFromFilename, deriveTitleFromFilename } from "./plan-paths.ts";
import { parseFrontmatter, stringifyFrontmatter } from "./plan-frontmatter.ts";
import { compactTodoDescriptions, extractPlanTitle, extractTodoItems, mergeTodoCompletion } from "./plan-content.ts";
import type { PlanFrontmatter, SavedPlan, TodoItem } from "./plan-types.ts";

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
		const merged: PlanFrontmatter = { ...current.frontmatter, todos: compactTodoDescriptions(todos) };
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
	const compact = compactTodoDescriptions(merged);
	const unchanged = JSON.stringify(compact) === JSON.stringify(current.frontmatter.todos ?? []);
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

