import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringifyFrontmatter } from "../plan/frontmatter.ts";
import { normalizePlanContent, updatePlanContentInContent } from "../plan/content.ts";
import { listSavedPlans, writePlanTodos } from "../plan/files.ts";
import { detectRepoName, planFilename, planWriteDir, resolvePlanPath, toDisplayPath } from "../plan/paths.ts";
import type { PlanModeRuntime } from "./runtime.ts";

async function planFileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Registers all agent-facing plan persistence and progress tools. */
export function registerPlanTools(runtime: PlanModeRuntime): void {
	const { pi } = runtime;

	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description:
			"Save a completed plan in the configured plans directory. Supply a short name and the full markdown plan content; the tool adds the current date to the filename and manages frontmatter and todo tracking.",
		promptSnippet: "Save a finished plan with a name and markdown content",
		promptGuidelines: [
			"Use save_plan, rather than write, to create a new plan after planning is complete. Supply the full plan body under a Plan: header; save_plan generates the dated filename and manages frontmatter. After saving a draft, use update_plan to revise its steps with a complete ordered list or apply targeted section edits/appends.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short descriptive plan name used for the generated filename" }),
			content: Type.String({ description: "Complete markdown plan content, including its numbered Plan: section" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Plan save cancelled.");
			const dir = planWriteDir();
			const today = new Date().toISOString().slice(0, 10);
			const basePath = resolve(dir, planFilename(params.name, today));
			await mkdir(dir, { recursive: true });

			return withFileMutationQueue(basePath, async () => {
				let path = basePath;
				let counter = 2;
				while (await planFileExists(path)) {
					path = resolve(dir, planFilename(params.name, today, counter));
					counter++;
				}

				const normalized = normalizePlanContent(params.content, {
					repo: await detectRepoName(ctx.cwd),
					title: params.name,
					date: today,
					forceDate: true,
				});
				await writeFile(path, normalized.content, "utf8");
				if (runtime.planModeEnabled) {
					runtime.lastSavedPlanPath = path;
					if (normalized.todos.length > 0) {
						runtime.todoItems = normalized.todos;
						runtime.activePlanPath = path;
						runtime.updateStatus(ctx);
					}
					runtime.persistState();
				}

				return {
					content: [{
						type: "text",
						text: `Saved plan to ${toDisplayPath(path)}${normalized.todos.length > 0 ? ` with ${normalized.todos.length} tracked step(s).` : "."}`,
					}],
					details: { path, todos: normalized.todos.length },
				};
			});
		},
	});

	pi.registerTool({
		name: "list_plans",
		label: "List Saved Plans",
		description: "List saved plans with filenames, paths, metadata, and completion counts. Use a returned filename or path to target a specific plan with update_plan.",
		promptSnippet: "List saved plans to choose a target for update_plan",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (signal?.aborted) throw new Error("Plan listing cancelled.");
			const plans = await listSavedPlans(planWriteDir());
			const summaries = plans.map((plan) => ({
				name: plan.name,
				path: plan.path,
				title: plan.title,
				repo: plan.repo,
				date: plan.date,
				steps: plan.todos?.length ?? 0,
				completed: plan.todos?.filter((todo) => todo.completed).length ?? 0,
			}));
			const text = summaries.length === 0
				? `No saved plans found in ${planWriteDir()}.`
				: `Saved plans:\n${summaries.map((plan) => {
					const metadata = [plan.title, plan.repo, plan.date].filter(Boolean).join(" · ");
					const progress = plan.steps > 0 ? `\n  progress: ${plan.completed}/${plan.steps} complete` : "";
					return `- ${plan.name}${metadata ? ` — ${metadata}` : ""}\n  path: ${plan.path}${progress}`;
				}).join("\n")}`;
			return { content: [{ type: "text", text }], details: { plans: summaries } };
		},
	});

	pi.registerTool({
		name: "complete_plan_step",
		executionMode: "sequential",
		label: "Complete Plan Step",
		description: "Mark the current plan step complete after its work is finished. Only use during plan execution, once per step, and always complete steps in order.",
		promptSnippet: "Mark the current plan step complete after finishing it",
		promptGuidelines: [
			"During plan execution, call complete_plan_step immediately after finishing each step. Complete only the next unfinished step, in order.",
		],
		parameters: Type.Object({ step: Type.Integer({ minimum: 1, description: "The completed plan step number" }) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Plan step completion cancelled.");
			if (!runtime.executionMode || runtime.todoItems.length === 0) {
				throw new Error("complete_plan_step is only available while a plan is executing.");
			}

			const path = runtime.activePlanPath ?? "__plan-mode-session-only__";
			return withFileMutationQueue(path, async () => {
				if (!runtime.executionMode || runtime.todoItems.length === 0) {
					throw new Error("complete_plan_step is only available while a plan is executing.");
				}
				const requested = runtime.todoItems.find((item) => item.step === params.step);
				if (!requested) throw new Error(`Plan step ${params.step} does not exist.`);
				if (requested.completed) throw new Error(`Plan step ${params.step} is already complete.`);
				const next = runtime.todoItems.find((item) => !item.completed);
				if (!next || next.step !== params.step) {
					throw new Error(`Complete step ${next?.step ?? "the next unfinished step"} before step ${params.step}.`);
				}

				requested.completed = true;
				runtime.stepsCompletedThisRun++;
				runtime.updateStatus(ctx);
				runtime.persistState();
				if (runtime.activePlanPath) {
					try {
						await writePlanTodos(runtime.activePlanPath, runtime.todoItems);
					} catch {
						// Progress is already persisted in the session; disk sync is best-effort.
					}
				}

				const nextStep = runtime.todoItems.find((item) => !item.completed);
				return {
					content: [{
						type: "text",
						text: nextStep
							? `Completed step ${requested.step}: ${requested.text}\nNext step: ${nextStep.step}. ${nextStep.text}`
							: `Completed step ${requested.step}: ${requested.text}\nAll plan steps are complete.`,
					}],
					details: { completedStep: requested.step, nextStep: nextStep?.step },
				};
			});
		},
	});

	pi.registerTool({
		name: "update_plan",
		executionMode: "sequential",
		label: "Update Plan",
		description: "Edit a specific saved plan in any mode. Set plan to a filename or path returned by list_plans; during planning or execution, omit it to target the active plan. Provide the complete ordered steps to change the plan, and use sectionEdits for exact targeted replacements or sectionAppends to add Context, Notes, or Results content. Section edits never replace a whole section implicitly.",
		promptSnippet: "Revise plan steps or apply targeted section edits",
		promptGuidelines: [
			"In normal mode, call list_plans and pass the chosen filename or path as plan; during planning or execution, omitting plan targets the active plan. Include steps only when changing the ordered plan and supply the complete revised list; unchanged completed steps retain their state. A steps-only update must not change Context, Notes, or Results.",
			"For Context, Notes, or Results, use sectionEdits with the exact oldText to change and the intended newText, or sectionAppends to add text. oldText must occur exactly once in that section; if it does not, re-read the current plan and retry. An empty newText removes only the exact matched oldText. Never replace the whole section as a routine update. These saved sections are distinct from the run-only execution context note.",
		],
		parameters: Type.Object({
			plan: Type.Optional(Type.String({ description: "Exact filename or absolute path returned by list_plans; required outside planning/execution mode" })),
			steps: Type.Optional(Type.Array(Type.String({ minLength: 6 }), { minItems: 1, description: "Complete ordered list of detailed step descriptions; omit when steps do not change" })),
			sectionEdits: Type.Optional(Type.Array(Type.Object({
				section: Type.Union([Type.Literal("context"), Type.Literal("notes"), Type.Literal("results")]),
				oldText: Type.String({ minLength: 1, description: "Exact existing text to replace; must match exactly once in the section" }),
				newText: Type.String({ description: "Replacement text for that exact match; empty text removes only the match" }),
			}), { minItems: 1, description: "Targeted exact-match edits within saved sections" })),
			sectionAppends: Type.Optional(Type.Array(Type.Object({
				section: Type.Union([Type.Literal("context"), Type.Literal("notes"), Type.Literal("results")]),
				text: Type.String({ minLength: 1, description: "Text to append without replacing existing section content" }),
			}), { minItems: 1, description: "Append content to saved sections without removing existing text" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Plan update cancelled.");
			const sectionEdits = params.sectionEdits ?? [];
			const sectionAppends = params.sectionAppends ?? [];
			if (params.steps === undefined && sectionEdits.length === 0 && sectionAppends.length === 0) {
				throw new Error("Supply steps, sectionEdits, or sectionAppends to update.");
			}

			const requestedPlan = params.plan?.trim();
			if (params.plan !== undefined && !requestedPlan) throw new Error("Provide a non-empty plan filename or path.");

			let path: string | undefined;
			if (requestedPlan) {
				const plans = await listSavedPlans(planWriteDir());
				const absolutePath = resolve(requestedPlan);
				const selected = plans.find((plan) => plan.name === requestedPlan || plan.path === absolutePath);
				if (!selected) throw new Error(`Saved plan not found: ${requestedPlan}. Use list_plans to see valid filenames and paths.`);
				path = selected.path;
			} else {
				path = runtime.activePlanPath ?? (runtime.planModeEnabled ? runtime.lastSavedPlanPath : undefined);
			}

			const sessionOnlyPlan = !path && !requestedPlan && (runtime.executionMode || runtime.planModeEnabled) && runtime.todoItems.length > 0;
			if (runtime.planModeEnabled && !path) throw new Error("Save the draft with save_plan before using update_plan during planning.");
			if (!path && !sessionOnlyPlan) {
				throw new Error("Specify plan using a filename or path from list_plans when updating outside planning or execution mode.");
			}
			if (!path && (sectionEdits.length > 0 || sectionAppends.length > 0)) {
				throw new Error("Context, notes, and results can only be updated in a saved plan file.");
			}
			const updatesActivePlan = !requestedPlan || path === runtime.activePlanPath || (runtime.planModeEnabled && path === runtime.lastSavedPlanPath);

			let updated: ReturnType<typeof updatePlanContentInContent>;
			if (path) {
				updated = await withFileMutationQueue(path, async () => {
					const content = await readFile(path, "utf8");
					const result = updatePlanContentInContent(content, params);
					await writeFile(path, result.content, "utf8");
					return result;
				});
			} else {
				const fallback = stringifyFrontmatter({ todos: runtime.todoItems }) +
					`Plan:\n\n${runtime.todoItems.map((item) => `${item.step}. ${item.text}`).join("\n")}\n`;
				updated = updatePlanContentInContent(fallback, params);
			}

			if (path && updatesActivePlan && runtime.planModeEnabled) {
				runtime.activePlanPath = path;
				runtime.lastSavedPlanPath = path;
			}
			if (params.steps !== undefined && updatesActivePlan && (runtime.planModeEnabled || runtime.executionMode)) {
				runtime.todoItems = updated.todos;
				runtime.updateStatus(ctx);
			}
			if (updatesActivePlan && (runtime.planModeEnabled || runtime.executionMode)) runtime.persistState();

			const changed = [
				...(params.steps !== undefined ? ["ordered steps"] : []),
				...new Set([
					...sectionEdits.map(({ section }) => `${section[0]!.toUpperCase()}${section.slice(1)} (edited)`),
					...sectionAppends.map(({ section }) => `${section[0]!.toUpperCase()}${section.slice(1)} (appended)`),
				]),
			];
			const next = runtime.executionMode && updatesActivePlan ? runtime.todoItems.find((item) => !item.completed) : undefined;
			return {
				content: [{
					type: "text",
					text: `Updated the saved plan (${changed.join(", ")}).${next ? `\nContinue with step ${next.step}: ${next.text}` : runtime.executionMode && updatesActivePlan && params.steps !== undefined ? "\nAll plan steps are complete." : ""}`,
				}],
				details: { todos: updated.todos, path, updated: changed },
			};
		},
	});
}
