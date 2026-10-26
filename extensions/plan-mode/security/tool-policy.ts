export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "write", "edit", "save_plan", "list_plans", "update_plan"];
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "save_plan", "list_plans", "update_plan"];
export const PLAN_MODE_MUTATION_TOOLS = new Set<string>(["replace", "replace_within", "insert", "copy", "move", "undo_last_change"]);
export const PLAN_MODE_DISABLED_TOOLS = new Set<string>(PLAN_MODE_MUTATION_TOOLS);
export const PLAN_GATED_TOOLS = new Set<string>(["write", "edit"]);
export const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);
