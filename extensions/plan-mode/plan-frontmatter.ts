import { normalizeStepMode, normalizeThinkingLevel, parseModelRef, STEP_MODES, type StepMode } from "./plan-settings.ts";
import type { PlanFrontmatter, TodoItem } from "./plan-types.ts";

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function isValidTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.step === "number" && typeof v.text === "string" && typeof v.completed === "boolean" &&
		(v.textHash === undefined || (typeof v.textHash === "string" && /^[a-f0-9]{64}$/.test(v.textHash)));
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

