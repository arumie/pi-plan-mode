import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StepMode, ThinkingLevelName, TodoItem } from "./utils.ts";

export interface ModelSnapshot {
	thinkingLevel: ThinkingLevelName;
}

/** Serialized state stored in the session's custom plan-mode entry. */
export interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	executionContext?: string;
	toolsBeforePlanMode?: string[];
	activePlanPath?: string;
	stepMode?: StepMode;
	modelSnapshot?: ModelSnapshot;
}

/**
 * Shared mutable runtime used by the extension's registration modules. The
 * entry point owns the state and supplies accessors, keeping transitions in one
 * place while allowing tools, commands, and hooks to live in focused modules.
 */
export interface PlanModeRuntime {
	pi: ExtensionAPI;
	planModeEnabled: boolean;
	executionMode: boolean;
	todoItems: TodoItem[];
	executionContext: string;
	toolsBeforePlanMode: string[] | undefined;
	activePlanPath: string | undefined;
	lastSavedPlanPath: string | undefined;
	stepMode: StepMode;
	modelSnapshot: ModelSnapshot | undefined;
	stepsCompletedThisRun: number;
	updateStatus(ctx: ExtensionContext): void;
	persistState(): void;
	enablePlanModeTools(): void;
	restoreNormalModeTools(): void;
	endExecution(ctx: ExtensionContext): Promise<void>;
	togglePlanMode(ctx: ExtensionContext): Promise<void>;
	ensurePlanFileForExecution(planText: string | undefined): Promise<string>;
}

export interface ResolvedExecutionSettings {
	model: Model<Api> | undefined;
	thinking: ThinkingLevelName;
	stepMode: StepMode;
	executionContext: string;
}
