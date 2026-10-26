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

