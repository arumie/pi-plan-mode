import { createHash } from "node:crypto";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import type { PlanFrontmatter, TodoItem } from "./types.ts";

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
	const runtimeTodos = bodyTodos.length > 0 ? mergeTodoCompletion(bodyTodos, frontmatter.todos) : (frontmatter.todos ?? []);
	frontmatter.todos = compactTodoDescriptions(runtimeTodos);

	return {
		content: stringifyFrontmatter(frontmatter) + body,
		frontmatter,
		todos: runtimeTodos,
	};
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

function todoTextHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function compactTodoDescriptions(todos: TodoItem[]): TodoItem[] {
	return todos.map((todo) => {
		const text = shortenTodoDescription(todo.text);
		return text === todo.text ? { ...todo } : { ...todo, text, textHash: todo.textHash ?? todoTextHash(todo.text) };
	});
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
		const hash = todoTextHash(item.text);
		const matchesFullText = (p: TodoItem): boolean =>
			p.textHash !== undefined ? p.textHash === hash : p.text === item.text;
		const match =
			previous.find((p) => p.step === item.step && matchesFullText(p)) ??
			previous.find(matchesFullText) ??
			// Legacy compact labels have no identity. Only use a prefix at the same
			// position; never transfer a colliding label's progress to another step.
			previous.find((p) => p.textHash === undefined && p.step === item.step &&
				p.text.endsWith("...") && item.text.startsWith(p.text.slice(0, -3)));
		return match ? { ...item, completed: match.completed } : item;
	});
}

/**
 * Revises the ordered steps and/or applies targeted edits to Context, Notes,
 * and Results. Section edits require exact existing text and replace only that
 * match; additions use sectionAppends. This prevents routine updates from
 * replacing an entire section accidentally.
 */
export function updatePlanContentInContent(
	content: string,
	updates: {
		steps?: string[];
		sectionEdits?: Array<{ section: PlanContentSection; oldText: string; newText: string }>;
		sectionAppends?: Array<{ section: PlanContentSection; text: string }>;
	},
): { content: string; todos: TodoItem[] } {
	const sectionEdits = updates.sectionEdits ?? [];
	const sectionAppends = updates.sectionAppends ?? [];
	if (updates.steps === undefined && sectionEdits.length === 0 && sectionAppends.length === 0) {
		throw new Error("A plan update must include steps, sectionEdits, or sectionAppends.");
	}
	for (const edit of sectionEdits) {
		if (!edit.oldText) throw new Error("Section edits require non-empty oldText so the exact content to change is explicit.");
	}
	for (const append of sectionAppends) {
		if (!append.text.trim()) throw new Error("Section appends require non-empty text.");
	}
	const { frontmatter, body } = parseFrontmatter(content);
	const lines = body.split(/\r?\n/);
	const bodyTodos = extractTodoItems(body);
	const previousTodos =
		bodyTodos.length > 0 ? mergeTodoCompletion(bodyTodos, frontmatter.todos) : (frontmatter.todos ?? []);
	let todos = previousTodos;
	let updatedFrontmatter = frontmatter;

	if (updates.steps !== undefined) {
		const descriptions = updates.steps.map((step) => step.trim().replace(/\s+/g, " "));
		if (descriptions.length === 0 || descriptions.some((step) => step.length === 0)) {
			throw new Error("A plan update must contain at least one non-empty step description.");
		}
		const { sections, fenced } = scanPlanMarkdown(lines);
		const section = findPlanSection(lines, sections, fenced);
		if (!section) throw new Error('The saved plan has no "Plan:" section to update.');
		const headerIndex = section.start;
		const renderedSteps = descriptions.map((step, index) => `${index + 1}. ${step}`);
		const nextTodos = extractTodoItems(`Plan:\n\n${renderedSteps.join("\n")}\n`);
		if (nextTodos.length !== descriptions.length) throw new Error("A plan step is too short to track.");
		let firstStep = -1;
		let lastStep = -1;
		let continuationAllowed = false;
		for (let i = headerIndex + 1; i < section.end; i++) {
			const line = lines[i] ?? "";
			if (fenced[i]) continue;
			if (/^ {0,3}\d+[.)]\s+/.test(line)) {
				if (firstStep < 0) firstStep = i;
				lastStep = i;
				continuationAllowed = true;
				continue;
			}
			if (line.trim().length === 0) continue;
			if (firstStep >= 0 && continuationAllowed && /^\s/.test(line)) {
				lastStep = i;
				continue;
			}
			// Prose ends this step's continuation, not the complete ordered plan.
			// Later numbered steps still belong to the replacement range.
			continuationAllowed = false;
		}
		if (firstStep < 0) {
			lines.splice(headerIndex + 1, 0, "", ...renderedSteps, "");
		} else {
			lines.splice(firstStep, lastStep - firstStep + 1, ...renderedSteps);
		}
		todos = mergeTodoCompletion(nextTodos, previousTodos);
		updatedFrontmatter = { ...frontmatter, todos: compactTodoDescriptions(todos) };
	}

	for (const edit of sectionEdits) {
		editNamedPlanSection(lines, edit.section, edit.oldText, edit.newText);
	}
	for (const append of sectionAppends) {
		appendToNamedPlanSection(lines, append.section, append.text);
	}

	return { content: stringifyFrontmatter(updatedFrontmatter) + lines.join("\n"), todos };
}

const PLAN_CONTENT_SECTION_NAMES = new Set(["plan", "context", "notes", "results"]);
type PlanContentSection = "context" | "notes" | "results";

interface MarkdownSection {
	index: number;
	level: number;
	name?: string;
}

/** Find real headings and fence membership once, shared by extraction and updates. */
function scanPlanMarkdown(lines: string[]): { sections: MarkdownSection[]; fenced: boolean[] } {
	const sections: MarkdownSection[] = [];
	const fenced: boolean[] = [];
	let fence: { marker: string; length: number } | undefined;
	for (const [index, line] of lines.entries()) {
		const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			fenced[index] = true;
			if (delimiter && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) {
				fence = undefined;
			}
			continue;
		}
		if (delimiter && (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))) {
			fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
			fenced[index] = true;
			continue;
		}
		fenced[index] = false;
		const named = getNamedPlanSectionHeading(line);
		const markdownLevel = line.match(/^ {0,3}(#{1,6})[ \t]+/)?.[1]?.length;
		if (named || markdownLevel !== undefined) {
			sections.push({ index, level: named?.level ?? markdownLevel!, name: named?.name });
		}
	}
	return { sections, fenced };
}

function planSectionEnd(sections: MarkdownSection[], section: MarkdownSection, lineCount: number): number {
	// Managed sections are always peers, even when their authored heading levels
	// differ. Ordinary nested headings remain part of their enclosing section.
	return sections.find((next) => next.index > section.index &&
		(next.name !== undefined || next.level <= section.level))?.index ?? lineCount;
}

function findPlanSection(lines: string[], sections: MarkdownSection[], fenced: boolean[]): { start: number; end: number } | undefined {
	const candidates = sections.filter((heading) => heading.name === "plan").map((section) => ({
		start: section.index,
		end: planSectionEnd(sections, section, lines.length),
	}));
	// A document title such as "# Plan" can precede the actual "Plan:" section.
	return candidates.find((section) => lines.some((line, index) =>
		index > section.start && index < section.end && !fenced[index] && /^ {0,3}\d+[.)]\s+/.test(line))) ?? candidates.at(-1);
}

/** Returns one named section's heading and body boundary, rejecting ambiguity. */
function findNamedPlanSection(lines: string[], sectionName: PlanContentSection): { heading: MarkdownSection; end: number } | undefined {
	const { sections } = scanPlanMarkdown(lines);
	const matching = sections.filter((section) => section.name === sectionName);
	if (matching.length > 1) {
		const title = sectionName[0]!.toUpperCase() + sectionName.slice(1);
		throw new Error(`The plan has multiple "${title}" sections; keep only one before updating it.`);
	}
	const heading = matching[0];
	return heading ? { heading, end: planSectionEnd(sections, heading, lines.length) } : undefined;
}

/** Replaces one exact, unique substring within a named section and nothing else. */
function editNamedPlanSection(lines: string[], sectionName: PlanContentSection, oldText: string, newText: string): void {
	const title = sectionName[0]!.toUpperCase() + sectionName.slice(1);
	const section = findNamedPlanSection(lines, sectionName);
	if (!section) throw new Error(`The plan has no "${title}" section to edit; use sectionAppends to add content.`);

	const start = section.heading.index + 1;
	const body = lines.slice(start, section.end).join("\n");
	const matchIndex = body.indexOf(oldText);
	if (matchIndex < 0) throw new Error(`oldText was not found in the "${title}" section; re-read the current section and retry.`);
	if (body.indexOf(oldText, matchIndex + 1) >= 0) {
		throw new Error(`oldText matches more than once in the "${title}" section; provide a more specific exact match.`);
	}

	const updatedBody = body.slice(0, matchIndex) + newText + body.slice(matchIndex + oldText.length);
	lines.splice(start, section.end - start, ...updatedBody.split("\n"));
}

/** Appends content without replacing existing section text; creates a missing section. */
function appendToNamedPlanSection(lines: string[], sectionName: PlanContentSection, text: string): void {
	const title = sectionName[0]!.toUpperCase() + sectionName.slice(1);
	const addition = text.trim();
	const section = findNamedPlanSection(lines, sectionName);
	if (!section) {
		while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
		if (lines.length > 0) lines.push("");
		lines.push(`## ${title}`, "", ...addition.split(/\r?\n/));
		return;
	}

	const start = section.heading.index + 1;
	const body = lines.slice(start, section.end).join("\n");
	const existing = body.replace(/\n+$/, "");
	const updatedBody = existing.trim().length > 0 ? `${existing}\n\n${addition}` : `\n${addition}`;
	lines.splice(start, section.end - start, ...updatedBody.split("\n"));
}

function getNamedPlanSectionHeading(line: string): { name: string; level: number } | undefined {
	const normalize = (value: string): string => value.trim().replace(/^\*\*|\*\*$/g, "").trim().replace(/:$/, "").trim().toLowerCase();
	const markdown = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/);
	if (markdown) {
		const name = normalize(markdown[2] ?? "");
		if (PLAN_CONTENT_SECTION_NAMES.has(name)) return { name, level: (markdown[1] ?? "##").length };
	}
	// Preserve all previously supported Plan header styles, including a bare Plan.
	const plan = line.match(/^[ \t]{0,3}(#{0,6})[ \t]*\*{0,2}Plan:?\*{0,2}[ \t]*$/i);
	if (plan) return { name: "plan", level: plan[1]?.length || 2 };
	const plainLabel = line.trim().replace(/^\*\*|\*\*$/g, "").trim();
	const plainName = normalize(line);
	if (plainLabel.endsWith(":") && PLAN_CONTENT_SECTION_NAMES.has(plainName)) return { name: plainName, level: 2 };
	return undefined;
}

/** Backward-compatible steps-only helper used by plan update tests/callers. */
export function updatePlanStepsInContent(
	content: string,
	stepDescriptions: string[],
): { content: string; todos: TodoItem[] } {
	return updatePlanContentInContent(content, { steps: stepDescriptions });
}

/**
 * Keeps the plan body as the detailed source of truth while making the
 * extension-managed progress labels easier to scan in frontmatter and widgets.
 */
export const TODO_DESCRIPTION_MAX_LENGTH = 100;

export function shortenTodoDescription(text: string, maxLength = TODO_DESCRIPTION_MAX_LENGTH): string {
	if (text.length <= maxLength) return text;
	const contentLimit = Math.max(1, maxLength - 3);
	const boundary = text.lastIndexOf(" ", contentLimit);
	const cutoff = boundary >= Math.floor(contentLimit * 0.65) ? boundary : contentLimit;
	return `${text.slice(0, cutoff).trimEnd()}...`;
}


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
	const lines = message.split(/\r?\n/);
	const { sections, fenced } = scanPlanMarkdown(lines);
	const section = findPlanSection(lines, sections, fenced);
	if (!section) return items;

	let current: string | null = null;
	const flush = (): void => {
		if (current === null) return;
		const cleaned = cleanStepText(current);
		current = null;
		if (cleaned.length > 3) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	};

	for (let index = section.start + 1; index < section.end; index++) {
		if (fenced[index]) {
			flush();
			continue;
		}
		const line = lines[index]!;
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
			flush();
			continue;
		}
		current += ` ${line.trim().replace(/^[-*]\s*/, "")}`;
	}
	flush();
	return items;
}

