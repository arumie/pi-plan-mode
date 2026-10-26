import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	buildExecutionInstructions,
	formatExecutionContext,
	seedExecutionSettings,
	showExecutionPreflight,
	applyExecutionSettings,
	persistExecutionSettings,
} from "./execution-preflight.ts";
import {
	checkCommandSafety,
	detectRepoName,
	deriveTitleFromFilename,
	extractDateFromFilename,
	extractPlanTitle,
	extractTodoItems,
	isPlanFilePath,
	normalizePlanContent,
	planWriteDir,
	readPlanFrontmatter,
	resolvePlanPath,
	syncPlanTodosFromBody,
	normalizeStepMode,
	writePlanTodos,
	type TodoItem,
} from "./utils.ts";
import { isAssistantMessage, getTextContent } from "./message-utils.ts";
import { PLAN_GATED_TOOLS, PLAN_MODE_DISABLED_TOOLS, PLAN_MODE_MUTATION_TOOLS } from "./tool-policy.ts";
import type { PlanModeRuntime, PlanModeState, ResolvedExecutionSettings } from "./plan-runtime.ts";

export function registerPlanLifecycleHooks(runtime: PlanModeRuntime): void {
	const { pi } = runtime;

	pi.on("tool_call", async (event) => {
		if (!runtime.planModeEnabled) return;

		if (PLAN_MODE_DISABLED_TOOLS.has(event.toolName)) {
			const detail = PLAN_MODE_MUTATION_TOOLS.has(event.toolName)
				? "this file-editing tool can bypass the plan-directory write guard"
				: "this tool is disabled in plan mode";
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked because ${detail}. Use write/edit only for plan markdown under ${planWriteDir()}, or disable plan mode first.`,
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			const safety = checkCommandSafety(command);
			if (!safety.safe) {
				return {
					block: true,
					reason: `Plan mode: command blocked - ${safety.reason ?? "not allowlisted"}. Plan mode only allows read-only commands; use /plan to disable plan mode first.\nCommand: ${command}`,
				};
			}
			return;
		}

		if (!PLAN_GATED_TOOLS.has(event.toolName)) return;
		const targetPath = (event.input as { path?: unknown }).path;
		if (!isPlanFilePath(targetPath, process.cwd(), planWriteDir())) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is only allowed for plan markdown files under ${planWriteDir()}. Use /plan to disable plan mode first.\nPath: ${String(targetPath)}`,
			};
		}

		if (isToolCallEventType("write", event)) {
			try {
				const path = resolvePlanPath(String(event.input.path), process.cwd());
				const filename = basename(path);
				const previous = (await readPlanFrontmatter(path))?.frontmatter;
				const normalized = normalizePlanContent(String(event.input.content ?? ""), {
					repo: await detectRepoName(process.cwd()),
					title: deriveTitleFromFilename(filename),
					date: extractDateFromFilename(filename) ?? new Date().toISOString().slice(0, 10),
					previous,
				});
				event.input.content = normalized.content;
				runtime.lastSavedPlanPath = path;
			} catch {
				// Frontmatter backfill is best-effort; leave the write untouched.
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!runtime.planModeEnabled || event.isError || !PLAN_GATED_TOOLS.has(event.toolName)) return;
		const inputPath = (event.input as { path?: unknown }).path;
		if (!isPlanFilePath(inputPath, process.cwd(), planWriteDir())) return;

		try {
			const path = resolvePlanPath(String(inputPath), process.cwd());
			runtime.lastSavedPlanPath = path;
			const synced = await syncPlanTodosFromBody(path);
			if (synced.length > 0) {
				runtime.todoItems = synced;
				runtime.activePlanPath = path;
				runtime.updateStatus(ctx);
				runtime.persistState();
			}
		} catch {
			// Todo sync is best-effort; never turn a successful write into an error.
		}
	});

	pi.on("context", async (event) => {
		if (runtime.planModeEnabled) return;
		const filtered = event.messages.filter((message) => {
			const msg = message as AgentMessage & { customType?: string };
			if (msg.customType === "plan-mode-context") return false;
			if (msg.role !== "user") return true;
			const content = msg.content;
			if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
			if (Array.isArray(content)) {
				return !content.some((block) => block.type === "text" && (block as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
			}
			return true;
		});
		return { messages: filtered };
	});

	pi.on("before_agent_start", async () => {
		if (runtime.planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- The only writes allowed are markdown plan files under ${planWriteDir()} (via write/edit, save_plan, or update_plan). Every other path is blocked.
- Other currently active tools remain available
- Bash is restricted to read-only commands. Read-only research is allowed, including \`gh\` lookups (\`gh pr view/list/diff\`, \`gh issue view\`, \`gh api\` GETs, \`gh search\`, \`gh run list\`) and read-only \`git\` subcommands. Anything that writes, installs, builds or mutates remote state is blocked with a reason explaining why.

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:
Write detailed, useful descriptions in the Plan body; progress labels in frontmatter are shortened automatically and should not constrain the plan's actual descriptions.

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes to the project - just describe what you would do.
When the finished plan is ready to save, call the save_plan tool with a short descriptive name and the full markdown content. The tool creates ${planWriteDir()}/YYYY-MM-DD-task-summary.md automatically, supplies the current date, and backfills frontmatter. Do NOT use write to create a new plan file. After saving a draft, use update_plan to revise the complete ordered steps or use sectionEdits/sectionAppends for targeted Context/Notes/Results changes. Exact edits require matching oldText and preserve all other section content. These saved sections are distinct from the run-only execution context. You may use write/edit only to refine other content in a plan that save_plan has already created. Keep a "Plan:" body (use that literal header text, e.g. "Plan:" or "## Plan" - either works - immediately followed by numbered steps). Do NOT include a "todos" field - progress tracking is managed automatically from that numbered list, so don't hand-maintain a separate checklist section.`,
					display: false,
				},
			};
		}

		if (runtime.executionMode && runtime.todoItems.length > 0) {
			const remaining = runtime.todoItems.filter((todo) => !todo.completed);
			const todoList = remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

${formatExecutionContext(runtime.executionContext)}Remaining steps:
${todoList}

${buildExecutionInstructions(runtime.stepMode)}

This instruction is only shown once, at the start of this execution run — call complete_plan_step as soon as you finish each step rather than waiting for a nudge.`,
					display: false,
				},
			};
		}
	});

	pi.on("agent_start", async () => {
		runtime.stepsCompletedThisRun = 0;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (runtime.executionMode && runtime.todoItems.length > 0) {
			if (runtime.todoItems.every((todo) => todo.completed)) {
				const completedList = runtime.todoItems.map((todo) => `~~${todo.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				if (runtime.activePlanPath) {
					try {
						await writePlanTodos(runtime.activePlanPath, runtime.todoItems);
					} catch {
						// Best-effort final disk sync.
					}
				}
				await runtime.endExecution(ctx);
				runtime.updateStatus(ctx);
				runtime.persistState();
				return;
			}

			if (runtime.stepMode === "stop" && runtime.stepsCompletedThisRun > 0 && ctx.hasUI) {
				const completed = runtime.todoItems.filter((todo) => todo.completed).length;
				const remaining = runtime.todoItems.filter((todo) => !todo.completed);
				const next = remaining[0];
				runtime.stepsCompletedThisRun = 0;
				const continueOne = "Continue to next step";
				const continueAll = "Continue without stopping again";
				const pause = "Stay paused";
				const choice = await ctx.ui.select(
					`Step ${completed}/${runtime.todoItems.length} complete - continue?`,
					[continueOne, continueAll, pause],
				);
				if (choice === pause || choice === undefined) {
					ctx.ui.notify(
						`Paused after step ${completed}/${runtime.todoItems.length}. Type your next instruction, or /plan step off to stop pausing.`,
						"info",
					);
					runtime.persistState();
					return;
				}
				if (choice === continueAll) {
					runtime.stepMode = "continue";
					await persistExecutionSettings(runtime, ctx, runtime.activePlanPath);
					ctx.ui.notify("Step gating off: continuing through the remaining steps.", "info");
				}
				runtime.updateStatus(ctx);
				runtime.persistState();
				const remainingList = remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-mode-execute",
						content: `Continue executing the plan.

Remaining steps:
${remainingList}

Continue with: ${next?.text ?? "the next remaining step"}

${buildExecutionInstructions(runtime.stepMode)}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
			return;
		}

		if (!runtime.planModeEnabled || !ctx.hasUI) return;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let extracted: TodoItem[] = [];
		if (runtime.lastSavedPlanPath) {
			try {
				extracted = await syncPlanTodosFromBody(runtime.lastSavedPlanPath);
			} catch {
				extracted = [];
			}
		}
		if (extracted.length === 0 && lastAssistant) extracted = extractTodoItems(getTextContent(lastAssistant));
		if (extracted.length > 0) runtime.todoItems = extracted;
		if (runtime.todoItems.length === 0) return;

		if (runtime.lastSavedPlanPath) {
			try {
				await writePlanTodos(runtime.lastSavedPlanPath, runtime.todoItems);
				runtime.activePlanPath = runtime.lastSavedPlanPath;
			} catch {
				// Best-effort disk sync.
			}
		}
		runtime.persistState();

		const todoListText = runtime.todoItems.map((todo, index) => `${index + 1}. ☐ ${todo.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${runtime.todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};
		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = runtime.todoItems[0];
			if (!firstTodoItem) return;
			const planPath = runtime.lastSavedPlanPath ?? runtime.activePlanPath;
			const seed = await seedExecutionSettings(runtime, ctx, planPath);
			let settings: ResolvedExecutionSettings = { ...seed, stepMode: seed.stepMode };
			if (ctx.hasUI) {
				const chosen = await showExecutionPreflight(runtime, ctx, {
					...seed,
					title: lastAssistant ? extractPlanTitle(getTextContent(lastAssistant)) : undefined,
				});
				if (!chosen) return;
				settings = chosen;
			}

			runtime.planModeEnabled = false;
			runtime.executionMode = true;
			runtime.stepMode = settings.stepMode;
			runtime.executionContext = settings.executionContext.trim();
			runtime.stepsCompletedThisRun = 0;
			runtime.restoreNormalModeTools();
			await applyExecutionSettings(runtime, ctx, settings);
			try {
				const planText = lastAssistant ? getTextContent(lastAssistant) : undefined;
				const path = await runtime.ensurePlanFileForExecution(planText);
				await writePlanTodos(path, runtime.todoItems);
				runtime.activePlanPath = path;
				await persistExecutionSettings(runtime, ctx, path);
			} catch (err) {
				ctx.ui.notify(`Plan mode: failed to save plan file (${(err as Error).message}); continuing without disk tracking.`, "warning");
			}

			runtime.updateStatus(ctx);
			runtime.persistState();
			const remainingList = runtime.todoItems.map((todo) => `${todo.step}. ${todo.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}

${buildExecutionInstructions(runtime.stepMode)}`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
				pi.sendMessage(
					{
						customType: "plan-mode-refine",
						content: "Refine the plan above according to the user's request. Stay in plan mode; do not execute it.",
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) runtime.planModeEnabled = true;
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			runtime.planModeEnabled = planModeEntry.data.enabled ?? runtime.planModeEnabled;
			runtime.todoItems = planModeEntry.data.todos ?? runtime.todoItems;
			runtime.executionMode = planModeEntry.data.executing ?? runtime.executionMode;
			runtime.executionContext = planModeEntry.data.executionContext ?? runtime.executionContext;
			runtime.toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? runtime.toolsBeforePlanMode;
			runtime.activePlanPath = planModeEntry.data.activePlanPath ?? runtime.activePlanPath;
			runtime.stepMode = normalizeStepMode(planModeEntry.data.stepMode);
			runtime.modelSnapshot = planModeEntry.data.modelSnapshot ?? runtime.modelSnapshot;
		}

		if (planModeEntry !== undefined && runtime.executionMode && runtime.todoItems.length > 0 && runtime.activePlanPath) {
			const onDiskTodos = await syncPlanTodosFromBody(runtime.activePlanPath);
			if (onDiskTodos.length > 0) runtime.todoItems = onDiskTodos;
			else {
				const onDisk = await readPlanFrontmatter(runtime.activePlanPath);
				if (onDisk?.frontmatter.todos && onDisk.frontmatter.todos.length > 0) runtime.todoItems = onDisk.frontmatter.todos;
			}
		}
		if (runtime.planModeEnabled) runtime.enablePlanModeTools();
		runtime.updateStatus(ctx);
	});
}
