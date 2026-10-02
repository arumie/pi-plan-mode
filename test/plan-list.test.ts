/** Behavior checks for repo-scoped, fuzzy-searchable /plan list. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import planModeExtension from "../extensions/plan-mode/index.ts";
import { detectRepoName } from "../extensions/plan-mode/utils.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-plan-list-"));
const previousPlanDir = process.env.PI_PLAN_DIR;
const plansDir = join(root, "plans");
const repoDir = join(root, "local-repo");
const nestedDir = join(repoDir, "src");
const messages: any[] = [];
const notifications: string[] = [];
let command: any;
let inspectPicker: (component: any) => void;
let pickerCalls = 0;
const pi = {
	registerTool() {}, registerFlag() {}, registerShortcut() {}, registerMessageRenderer() {}, on() {},
	registerCommand(name: string, definition: any) { if (name === "plan") command = definition; },
	sendMessage(message: any) { messages.push(message); },
} as unknown as ExtensionAPI;
planModeExtension(pi);
const ctx = {
	cwd: nestedDir,
	mode: "tui", hasUI: true,
	ui: {
		notify(message: string) { notifications.push(message); },
		async custom(factory: any) {
			pickerCalls++;
			let finished = false;
			let result: any;
			const component = factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				getKeybindings(),
				(value: any) => { finished = true; result = value; },
			);
			component.focused = true;
			inspectPicker(component);
			assert.ok(finished, "picker should resolve after selection or cancellation");
			return result;
		},
	},
};
const render = (component: any) => component.render(160).join("\n");
const clearSearch = (component: any, query: string) => {
	for (const _ of query) component.handleInput("\x7f");
};
const cancel = (component: any) => component.handleInput("\x1b");

try {
	await mkdir(plansDir);
	await mkdir(nestedDir, { recursive: true });
	process.env.PI_PLAN_DIR = plansDir;
	await exec("git", ["init", "--quiet", repoDir]);
	assert.equal(await detectRepoName(nestedDir), "local-repo", "no-origin repo detection uses git root, not subdirectory");
	const outsideDir = join(root, "outside");
	await mkdir(outsideDir);
	assert.equal(await detectRepoName(outsideDir), "outside", "non-git cwd falls back to its basename");
	await exec("git", ["-C", repoDir, "remote", "add", "origin", "git@example.com:team/current-repo.git"]);
	assert.equal(await detectRepoName(nestedDir), "current-repo");
	await exec("git", ["-C", repoDir, "remote", "set-url", "origin", "https://example.com/team/current-repo.git"]);
	assert.equal(await detectRepoName(nestedDir), "current-repo", "SSH and HTTPS remotes agree");
	const fixtures = [
		["alpha.md", "---\nrepo: current-repo\ntitle: Database migration\ndate: 2026-09-26\n---\n# Alpha\n"],
		["beta.md", "---\nrepo: current-repo\ntitle: Billing cleanup\ndate: 2025-01-01\n---\n# Beta\n"],
		["other.md", "---\nrepo: other-repo\ntitle: Database migration\n---\n# Other\n"],
		["legacy.md", "# Legacy plan without repo metadata\n"],
	] as const;
	for (const [name, content] of fixtures) await writeFile(join(plansDir, name), content);

	inspectPicker = (component) => {
		const text = render(component);
		assert.match(text, /repo: current-repo/);
		assert.match(text, /alpha\.md/);
		assert.match(text, /beta\.md/);
		assert.doesNotMatch(text, /other\.md|legacy\.md/);
		assert.equal(component.focused, true);
		for (const width of [20, 40, 80]) {
			assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		component.invalidate();
		cancel(component);
	};
	await command.handler("list", ctx);
	assert.equal(messages.length, 0, "cancelling must not load a plan");
	console.log("✓ /plan list defaults to the current repo, including from a nested directory");

	inspectPicker = (component) => {
		const text = render(component);
		assert.match(text, /all repos/);
		for (const [name] of fixtures) assert.ok(text.includes(name));
		cancel(component);
	};
	await command.handler("list --all", ctx);
	assert.ok(command.getArgumentCompletions("list --").some((item: any) => item.value === "list --all"));
	console.log("✓ --all includes other repos and legacy plans and has completion");

	inspectPicker = (component) => {
		assert.match(render(component), /alpha\.md/);
		assert.doesNotMatch(render(component), /beta\.md|other\.md/);
		clearSearch(component, "DBMIG");
		assert.match(render(component), /beta\.md/);
		component.handleInput("blcl");
		assert.match(render(component), /beta\.md/);
		assert.doesNotMatch(render(component), /alpha\.md/);
		component.handleInput("\r");
	};
	await command.handler("list DBMIG", ctx);
	assert.equal(messages.at(-1).details.name, "beta.md", "Enter loads the interactively filtered selection");
	console.log("✓ command queries and interactive typing fuzzy-match titles case-insensitively");

	const rankedPlanPath = join(plansDir, "best-match.md");
	await writeFile(rankedPlanPath, "---\nrepo: current-repo\ntitle: DBMIG\n---\n# Best match\n");
	inspectPicker = (component) => {
		const text = render(component);
		assert.match(text, /alpha\.md/);
		assert.match(text, /^→ best-match\.md/m, "the stronger fuzzy match ranks ahead of the loose match");
		cancel(component);
	};
	await command.handler("list dbmig", ctx);
	await rm(rankedPlanPath);
	console.log("✓ fuzzy results are ranked by match quality");

	for (const [query, expected] of [["alpa", "alpha.md"], ["202509", "No matching plans"], ["202609", "alpha.md"]]) {
		inspectPicker = (component) => { assert.ok(render(component).includes(expected)); cancel(component); };
		await command.handler(`list ${query}`, ctx);
	}
	inspectPicker = (component) => {
		assert.match(render(component), /other\.md/);
		assert.doesNotMatch(render(component), /alpha\.md|beta\.md|legacy\.md/);
		cancel(component);
	};
	await command.handler("list --all othr-rep", ctx);
	console.log("✓ fuzzy search covers filenames, repo, and date metadata");

	inspectPicker = (component) => {
		assert.match(render(component), /alpha\.md/);
		assert.doesNotMatch(render(component), /beta\.md/);
		cancel(component);
	};
	await command.handler("list 2026 dbmig", ctx);
	inspectPicker = (component) => {
		assert.match(render(component), /repo: current-repo/);
		assert.match(render(component), /No matching plans/);
		clearSearch(component, "--all");
		component.handleInput("\x1b[200~blcl\x1b[201~");
		assert.match(render(component), /beta\.md/);
		assert.doesNotMatch(render(component), /alpha\.md/);
		cancel(component);
	};
	await command.handler("list -- --all", ctx);
	console.log("✓ multi-term search, literal option queries, and pasted search text work");

	let expectedNavigationPlan: string | undefined;
	inspectPicker = (component) => {
		assert.match(render(component), /No matching plans/);
		component.handleInput("\r"); // No result must not finish the picker.
		clearSearch(component, "zzzzzz");
		assert.match(render(component), /alpha\.md/);
		const initialSelection = render(component).match(/^→ (\S+\.md)/m)?.[1];
		assert.ok(initialSelection);
		component.handleInput("\x1b[B");
		expectedNavigationPlan = render(component).match(/^→ (\S+\.md)/m)?.[1];
		assert.ok(expectedNavigationPlan);
		assert.notEqual(expectedNavigationPlan, initialSelection, "Down must move to another plan");
		component.handleInput("\r");
	};
	await command.handler("list zzzzzz", ctx);
	assert.equal(messages.at(-1).details.name, expectedNavigationPlan, "Enter loads the newly selected row");
	inspectPicker = (component) => { assert.doesNotMatch(render(component), /other\.md|legacy\.md/); cancel(component); };
	await command.handler("list", ctx);
	console.log("✓ no-match searches are editable, navigation works, and --all does not change the default");

	const before = pickerCalls;
	await command.handler("list", { ...ctx, cwd: outsideDir });
	assert.equal(pickerCalls, before);
	assert.match(notifications.at(-1)!, /repo: outside.*\/plan list --all/);
	console.log("✓ empty repo scope explains how to access all plans");
} finally {
	if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
	else process.env.PI_PLAN_DIR = previousPlanDir;
	await rm(root, { recursive: true, force: true });
}
