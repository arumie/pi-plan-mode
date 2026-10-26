import type { StepMode, ThinkingLevelName } from "./plan-settings.ts";

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

/** Structured metadata stored in a plan file's YAML-ish frontmatter. */
export interface PlanFrontmatter {
	repo?: string;
	title?: string;
	date?: string;
	/** Extension-managed execution settings. */
	model?: string;
	thinking?: ThinkingLevelName;
	stepMode?: StepMode;
	/** Progress list exclusively written by the extension. */
	todos?: TodoItem[];
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
	/** Identity of the full description when `text` is a compact persisted label. */
	textHash?: string;
}
