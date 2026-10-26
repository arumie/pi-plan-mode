import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
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

/**
 * Best-effort repo name detection: parses `git remote get-url origin` (works
 * for both SSH `git@host:org/repo.git` and HTTPS `https://host/org/repo.git`
 * remote URL forms), falling back to the git root's basename (or the cwd
 * folder's basename outside git) when there's no `origin` remote or git
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
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2000 });
		if (stdout.trim()) return basename(stdout.trim());
	} catch {
		// Outside git or git unavailable - use the working directory below.
	}
	return basename(cwd);
}

