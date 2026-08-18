/**
 * Tests for plan-mode utils. No test framework - run with:
 *
 *   node --experimental-strip-types ~/.pi/agent/extensions/plan-mode/utils.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildModelPickerItems,
	buildTodoWidgetRows,
	checkCommandSafety,
	extractTodoItems,
	formatModelRef,
	MAX_TODO_WIDGET_ROWS,
	normalizeStepMode,
	normalizeThinkingLevel,
	parseFrontmatter,
	parseModelRef,
	readPlanExecutionSettings,
	stringifyFrontmatter,
	syncPlanTodosFromBody,
	THINKING_LEVELS,
	type TodoItem,
	writePlanExecutionSettings,
	writePlanTodos,
} from "./utils.ts";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	return (async () => {
		try {
			await fn();
		} catch (err) {
			failures++;
			console.error(`✗ ${name}\n  ${(err as Error).message.split("\n")[0]}`);
			return;
		}
		console.log(`✓ ${name}`);
	})();
}

// --- bash gating -----------------------------------------------------------

const ALLOWED = [
	// Commands that plan mode wrongly blocked before the structural rewrite.
	"cd /tmp && gh pr view 281 --repo lunarway/x --json title,body,files 2>&1 | head -100",
	`rg -l -i "outofband|OutOfBand|auth_challenge" --iglob '!generated' | head -50`,
	`ls internal/ && rg -n "DKPaymentSlip|PaymentSlip" internal/**/*.go 2>/dev/null | head -40`,
	`rg -ln "CreateOutOfBandChallengeRequest" --glob '!*_test.go' | head`,
	"D=$(go env GOPATH)/pkg/mod; ls $(go env GOPATH)/pkg/mod 2>/dev/null",
	`ls /Users/dacz/repos/ | rg -i "fi|payment"`,
	// gh / git read-only research
	"gh pr list --repo lunarway/x --state merged --limit 20",
	"gh pr diff 281 | head -200",
	"gh issue view 42 --json title,body",
	"gh api repos/lunarway/x/pulls/281 --jq .title",
	"gh search prs --repo lunarway/x challenge",
	"git log --format='%h %s' | rg -i 'fix|feat'",
	"git remote get-url origin",
	"git branch --show-current",
	// general read-only shell
	"sed -n '1,50p' main.go",
	`awk '{ if ($1 > 2) print $2 }' data.txt`,
	"curl -s https://api.github.com/repos/lunarway/x | jq .name",
	"wc -l $(fd -e go | head -5)",
	"cat <<'EOF'\nhello\nEOF",
	"for f in *.go; do cat $f; done",
	"if rg -q foo file; then echo yes; fi",
	"time git log --oneline | head",
	"ls -la 2>&1 | tail -5",
];

const BLOCKED = [
	"rm -rf /tmp/x",
	"ls && rm -rf build",
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"cat a | tee b",
	"cat <<'EOF' > out.txt\nhello\nEOF",
	"git commit -am wip",
	"git checkout -b feature",
	"git branch -d old",
	"git remote add upstream git@github.com:x/y.git",
	"gh pr create --title x",
	"gh pr merge 281",
	"gh pr checkout 281",
	"gh api repos/x/y/issues -X POST -f title=x",
	"gh api graphql -f query='mutation { x }'",
	"gh repo clone lunarway/x",
	"sed -i '' s/a/b/ file",
	"find . -name '*.go' -delete",
	"find . -exec rm {} \\;",
	"fd -x rm",
	"curl -o out.json https://x",
	"curl -X POST https://x -d '{}'",
	`awk '{ print > "out.txt" }' in.txt`,
	"npm install",
	"pip install requests",
	"sudo ls",
	"bash -c 'rm -rf x'",
	"xargs rm < list",
	"ls $(rm -rf /tmp/x)",
	"cat < <(rm -rf x)",
	"D=$(rm -rf /tmp/x); ls",
	"for f in *.go; do rm $f; done",
	"env FOO=1 rm -rf x",
	"mkdir -p build",
	"go build ./...",
	"go test ./...",
	"shuttle run build",
	"lunarctl schema generate",
	"vim main.go",
	"kill -9 123",
];

await check("allowlisted read-only commands pass", () => {
	for (const cmd of ALLOWED) {
		const res = checkCommandSafety(cmd);
		assert.equal(res.safe, true, `should allow: ${cmd} (${res.reason})`);
	}
});

await check("writing/destructive commands are blocked with a reason", () => {
	for (const cmd of BLOCKED) {
		const res = checkCommandSafety(cmd);
		assert.equal(res.safe, false, `should block: ${cmd}`);
		assert.ok((res.reason ?? "").length > 0, `missing reason: ${cmd}`);
	}
});

// --- plan step extraction --------------------------------------------------

await check("extractTodoItems folds multi-line steps into one label", () => {
	const items = extractTodoItems(`Some preamble.

Plan:

1. Create a Linear issue on team **Atlas**, modelled on ATL-9389,
   referencing the bank-giro PRs.
2. Consume the \`auth-challenge\` gRPC schema.

   - add it to schema.yaml
3. Short one.

## Follow-ups

Not a step.
`);
	assert.equal(items.length, 3);
	assert.ok(items[0]?.text.startsWith("Create a Linear issue on team Atlas"), items[0]?.text);
	assert.ok(items[1]?.text.startsWith("Consume the auth-challenge gRPC schema"), items[1]?.text);
	assert.equal(items[2]?.text, "Short one");
	assert.deepEqual(
		items.map((i) => i.step),
		[1, 2, 3],
	);
});

await check("extractTodoItems accepts a markdown '## Plan' heading (no colon)", () => {
	const items = extractTodoItems(`# Some Title

## Background

Some findings.

## Plan

1. First step of the plan.
2. Second step of the plan.

## Follow-ups

Not a step.
`);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.text, "First step of the plan");
	assert.equal(items[1]?.text, "Second step of the plan");
});

// --- frontmatter todo sync -------------------------------------------------

await check("syncPlanTodosFromBody stamps todos and preserves completion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plan-mode-test-"));
	const path = join(dir, "2026-07-31-example.md");
	await writeFile(
		path,
		`---
repo: my-repo
title: Example
date: 2026-07-31
---

# Example

Plan:

1. First step of the plan
2. Second step of the plan
`,
		"utf8",
	);

	const todos = await syncPlanTodosFromBody(path);
	assert.equal(todos.length, 2);
	const stamped = parseFrontmatter(await readFile(path, "utf8"));
	assert.equal(stamped.frontmatter.todos?.length, 2);
	assert.equal(stamped.frontmatter.repo, "my-repo");
	assert.ok(stamped.body.includes("# Example"));

	// completion recorded during execution survives a re-sync of the same body
	todos[0] = { ...(todos[0] as { step: number; text: string; completed: boolean }), completed: true };
	await writePlanTodos(path, todos);
	const resynced = await syncPlanTodosFromBody(path);
	assert.equal(resynced[0]?.completed, true);
	assert.equal(resynced[1]?.completed, false);

	// a body without plan steps leaves existing todos untouched
	await writeFile(path, `---\nrepo: my-repo\n---\n\n# Example\n\nNo steps here.\n`, "utf8");
	assert.deepEqual(await syncPlanTodosFromBody(path), []);
});

// --- execution settings: model refs & step mode ----------------------------

await check("formatModelRef/parseModelRef round-trip, splitting on the first slash only", () => {
	assert.equal(formatModelRef("amazon-bedrock", "eu.anthropic.claude-opus-5"), "amazon-bedrock/eu.anthropic.claude-opus-5");
	assert.deepEqual(parseModelRef("amazon-bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0"), {
		provider: "amazon-bedrock",
		modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
	});
	// model ids may themselves contain slashes
	assert.deepEqual(parseModelRef("openrouter/anthropic/claude-3"), {
		provider: "openrouter",
		modelId: "anthropic/claude-3",
	});
	assert.equal(parseModelRef("no-slash"), undefined);
	assert.equal(parseModelRef("/leading"), undefined);
	assert.equal(parseModelRef("trailing/"), undefined);
	assert.equal(parseModelRef(42), undefined);
	assert.equal(parseModelRef(undefined), undefined);
});

await check("normalizeStepMode defaults to continue, normalizeThinkingLevel rejects unknown levels", () => {
	assert.equal(normalizeStepMode("stop"), "stop");
	assert.equal(normalizeStepMode(" STOP "), "stop");
	assert.equal(normalizeStepMode("continue"), "continue");
	assert.equal(normalizeStepMode("bogus"), "continue");
	assert.equal(normalizeStepMode(undefined), "continue");
	assert.equal(normalizeStepMode(7), "continue");

	assert.equal(normalizeThinkingLevel("High"), "high");
	assert.equal(normalizeThinkingLevel("off"), "off");
	assert.equal(normalizeThinkingLevel("turbo"), undefined);
	assert.equal(normalizeThinkingLevel(undefined), undefined);
});

// --- thinking levels -------------------------------------------------------
//
// Plan mode offers pi's canonical level list and lets `pi.setThinkingLevel()`
// clamp to the model, so there is no per-model availability logic to test here
// (see the note in README's Tests section). What must not regress is the list
// itself: it is the single source for what the picker offers.

await check("THINKING_LEVELS is pi's full canonical list, cheapest-first", () => {
	assert.deepEqual(
		[...THINKING_LEVELS],
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		"the picker's option list must not silently shrink or reorder",
	);
	for (const level of THINKING_LEVELS) {
		assert.equal(normalizeThinkingLevel(level), level, `${level} must round-trip through normalizeThinkingLevel`);
	}
});

await check(
	'regression: thinkingLevelMap {"xhigh","max"} (eu.anthropic.claude-opus-5) must not reduce options to off/xhigh/max',
	() => {
		// The real metadata of the model that surfaced the bug: a sparse
		// `thinkingLevelMap` where only the opt-in levels have entries. Plan mode used
		// to treat that map as an allowlist and offered exactly [off, xhigh, max],
		// which also clamped a session on `high` down to `off`.
		const model = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };

		// Option building no longer consults the model at all, so the invariant to
		// pin is that the offered set is the full canonical list for *any* model.
		const offeredFor = (_model: unknown): readonly string[] => THINKING_LEVELS;

		assert.deepEqual([...offeredFor(model)], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.notDeepEqual([...offeredFor(model)], ["off", "xhigh", "max"], "the reported bug must stay fixed");
		assert.ok(offeredFor(model).includes("high"), "a session on `high` must still see `high` offered");
		// Same list for a non-reasoning model: pi resolves it to `off` on apply.
		assert.deepEqual([...offeredFor({ reasoning: false })], [...THINKING_LEVELS]);
		assert.deepEqual([...offeredFor(undefined)], [...THINKING_LEVELS]);
	},
);

// --- model picker parity with /model ---------------------------------------

await check("buildModelPickerItems returns the scoped models verbatim (same set as /model)", () => {
	// The three models this config scopes via `enabledModels`.
	const scoped = [
		{ provider: "amazon-bedrock", id: "eu.anthropic.claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "amazon-bedrock", id: "eu.anthropic.claude-opus-5", name: "Opus 5" },
		{ provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", name: "Haiku 4.5" },
	];
	const available = [...scoped, { provider: "openai", id: "gpt-5", name: "GPT-5" }];
	const current = { provider: "amazon-bedrock", id: "eu.anthropic.claude-opus-5" };

	const scopedRows = buildModelPickerItems(scoped, available, current, "scoped");
	// same models, same order, nothing dropped - not even auth-filtered
	assert.deepEqual(
		scopedRows.map((r) => r.ref),
		scoped.map((m) => formatModelRef(m.provider, m.id)),
	);
	assert.equal(scopedRows.filter((r) => r.current).length, 1);
	assert.equal(scopedRows[1]?.current, true);
	assert.equal(scopedRows[2]?.name, "Haiku 4.5");

	// "all" scope: current model first, then provider/id ordered
	const allRows = buildModelPickerItems(scoped, available, current, "all");
	assert.equal(allRows.length, 4);
	assert.equal(allRows[0]?.ref, "amazon-bedrock/eu.anthropic.claude-opus-5");
	assert.equal(allRows[0]?.current, true);
	assert.equal(allRows[3]?.ref, "openai/gpt-5");

	// no current model and an empty scoped list are both non-fatal
	assert.equal(buildModelPickerItems([], available, undefined, "all").length, 4);
	assert.deepEqual(buildModelPickerItems([], available, undefined, "scoped"), []);
});

// --- execution settings in frontmatter -------------------------------------

await check("frontmatter round-trips model/thinking/stepMode and drops invalid values", () => {
	const parsed = parseFrontmatter(
		`---\nrepo: r\ntitle: T\ndate: 2026-08-11\nmodel: amazon-bedrock/eu.anthropic.claude-opus-5\nthinking: High\nstepMode: stop\ntodos: [{"step":1,"text":"a","completed":true}]\n---\n\n# T\n`,
	);
	assert.equal(parsed.frontmatter.model, "amazon-bedrock/eu.anthropic.claude-opus-5");
	assert.equal(parsed.frontmatter.thinking, "high");
	assert.equal(parsed.frontmatter.stepMode, "stop");
	assert.equal(parsed.body, "\n# T\n");

	// serialize -> parse is stable
	const reparsed = parseFrontmatter(`${stringifyFrontmatter(parsed.frontmatter)}\n# T\n`);
	assert.deepEqual(reparsed.frontmatter, parsed.frontmatter);

	// invalid values are ignored rather than stored
	const invalid = parseFrontmatter(`---\nmodel: no-slash\nthinking: turbo\nstepMode: maybe\n---\nbody\n`);
	assert.equal(invalid.frontmatter.model, undefined);
	assert.equal(invalid.frontmatter.thinking, undefined);
	assert.equal(invalid.frontmatter.stepMode, undefined);

	// plans predating these fields keep parsing (and stay unchanged)
	const legacy = parseFrontmatter("# Old plan\n\nPlan:\n1. one thing here\n");
	assert.deepEqual(legacy.frontmatter, {});
});

await check("writePlanExecutionSettings merges without disturbing todos or body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plan-mode-exec-"));
	const path = join(dir, "2026-08-11-example.md");
	await writeFile(
		path,
		`---\nrepo: my-repo\ntitle: Example\ndate: 2026-08-11\ntodos: [{"step":1,"text":"First step of the plan","completed":true}]\n---\n\n# Example\n\nPlan:\n\n1. First step of the plan\n2. Second step of the plan\n`,
		"utf8",
	);

	assert.equal(
		await writePlanExecutionSettings(path, {
			model: "amazon-bedrock/eu.anthropic.claude-opus-5",
			thinking: "high",
			stepMode: "stop",
		}),
		true,
	);

	const after = parseFrontmatter(await readFile(path, "utf8"));
	assert.equal(after.frontmatter.model, "amazon-bedrock/eu.anthropic.claude-opus-5");
	assert.equal(after.frontmatter.thinking, "high");
	assert.equal(after.frontmatter.stepMode, "stop");
	// untouched: identity fields, recorded progress and the plan body
	assert.equal(after.frontmatter.repo, "my-repo");
	assert.equal(after.frontmatter.title, "Example");
	assert.equal(after.frontmatter.todos?.length, 1);
	assert.equal(after.frontmatter.todos?.[0]?.completed, true);
	assert.ok(after.body.includes("2. Second step of the plan"));

	// a partial update leaves the other settings alone
	assert.equal(await writePlanExecutionSettings(path, { stepMode: "continue" }), true);
	assert.deepEqual(await readPlanExecutionSettings(path), {
		model: "amazon-bedrock/eu.anthropic.claude-opus-5",
		thinking: "high",
		stepMode: "continue",
	});

	// a re-sync of the body still preserves the execution settings
	await syncPlanTodosFromBody(path);
	const resynced = parseFrontmatter(await readFile(path, "utf8"));
	assert.equal(resynced.frontmatter.model, "amazon-bedrock/eu.anthropic.claude-opus-5");
	assert.equal(resynced.frontmatter.todos?.length, 2);
	assert.equal(resynced.frontmatter.todos?.[0]?.completed, true);

	// missing files fail softly
	assert.equal(await writePlanExecutionSettings(join(dir, "nope.md"), { stepMode: "stop" }), false);
	assert.deepEqual(await readPlanExecutionSettings(join(dir, "nope.md")), {});
});

// --- compact todo widget rows ----------------------------------------------

function todos(total: number, completed: number): TodoItem[] {
	return Array.from({ length: total }, (_, i) => ({
		step: i + 1,
		text: `Step ${i + 1} text`,
		completed: i < completed,
	}));
}

await check("buildTodoWidgetRows shows every step of a short plan", () => {
	const rows = buildTodoWidgetRows(todos(3, 1));
	assert.deepEqual(rows, [
		{ kind: "summary", completed: 1, remaining: 2, total: 3 },
		{ kind: "current", step: 2, text: "Step 2 text" },
		{ kind: "pending", step: 3, text: "Step 3 text" },
	]);
	// no truncation tail when everything fits
	assert.ok(!rows.some((r) => r.kind === "more"));
});

await check("buildTodoWidgetRows collapses a long plan into summary + current + more", () => {
	const rows = buildTodoWidgetRows(todos(14, 10));
	assert.equal(rows.length, 5);
	assert.deepEqual(rows[0], { kind: "summary", completed: 10, remaining: 4, total: 14 });
	assert.deepEqual(rows[1], { kind: "current", step: 11, text: "Step 11 text" });
	assert.deepEqual(
		rows.slice(2),
		[12, 13, 14].map((step) => ({ kind: "pending", step, text: `Step ${step} text` })),
	);

	// a plan long enough to overflow the budget ends in a `+N more` tail whose
	// count covers exactly the remaining steps that are not shown
	const long = buildTodoWidgetRows(todos(30, 4));
	assert.equal(long.length, MAX_TODO_WIDGET_ROWS);
	assert.equal(long.filter((r) => r.kind === "summary").length, 1);
	assert.equal(long.filter((r) => r.kind === "current").length, 1);
	const tail = long[long.length - 1];
	assert.equal(tail?.kind, "more");
	const shownSteps = long.filter((r) => r.kind === "current" || r.kind === "pending").length;
	assert.equal(tail?.kind === "more" ? tail.count : -1, 30 - 4 - shownSteps);
});

await check("buildTodoWidgetRows reports a finished plan with a single summary row", () => {
	assert.deepEqual(buildTodoWidgetRows(todos(14, 14)), [
		{ kind: "summary", completed: 14, remaining: 0, total: 14 },
	]);
});

await check("buildTodoWidgetRows handles degenerate inputs", () => {
	assert.deepEqual(buildTodoWidgetRows([]), []);
	assert.deepEqual(buildTodoWidgetRows(todos(5, 1), { maxRows: 0 }), []);
	assert.deepEqual(buildTodoWidgetRows(todos(5, 1), { maxRows: -3 }), []);
	// only the summary fits
	assert.deepEqual(buildTodoWidgetRows(todos(9, 2), { maxRows: 1 }), [
		{ kind: "summary", completed: 2, remaining: 7, total: 9 },
	]);
	// the current step wins the second row over a `more` tail
	assert.deepEqual(buildTodoWidgetRows(todos(9, 2), { maxRows: 2 }), [
		{ kind: "summary", completed: 2, remaining: 7, total: 9 },
		{ kind: "current", step: 3, text: "Step 3 text" },
	]);
	// many completed steps, one left -> summary + current, no tail
	assert.deepEqual(buildTodoWidgetRows(todos(14, 13)), [
		{ kind: "summary", completed: 13, remaining: 1, total: 14 },
		{ kind: "current", step: 14, text: "Step 14 text" },
	]);
});

await check("buildTodoWidgetRows never exceeds its row budget (widget truncation guard)", () => {
	for (let total = 1; total <= 30; total++) {
		for (let completed = 0; completed <= total; completed++) {
			const rows = buildTodoWidgetRows(todos(total, completed));
			assert.ok(
				rows.length <= MAX_TODO_WIDGET_ROWS,
				`${total} steps / ${completed} done produced ${rows.length} rows`,
			);
			for (const maxRows of [1, 2, 3, 5, 8, 12]) {
				assert.ok(buildTodoWidgetRows(todos(total, completed), { maxRows }).length <= maxRows);
			}
		}
	}
	// the default budget plus the trailing `after each step: ...` line has to stay
	// under pi's InteractiveMode.MAX_WIDGET_LINES (10)
	assert.ok(MAX_TODO_WIDGET_ROWS + 1 < 10);
});

console.log(failures === 0 ? "\nAll plan-mode util tests passed." : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
