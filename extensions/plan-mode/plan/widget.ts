import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "./types.ts";

/**
 * A single line of the compact progress widget, described structurally so the
 * theming (colors, glyphs) stays in `index.ts` and this module remains free of
 * `ctx.ui` - which is what makes it unit-testable like the other helpers here.
 */
export type TodoWidgetRow =
	| { kind: "summary"; completed: number; remaining: number; total: number }
	| { kind: "current"; step: number; text: string }
	| { kind: "pending"; step: number; text: string }
	| { kind: "more"; count: number };

/**
 * Fits a full todo description into the columns remaining after its rendered
 * glyph/number prefix. The prefix is supplied unstyled so `visibleWidth` can
 * reserve the same space that the themed widget will occupy; `truncateToWidth`
 * then accounts for Unicode and ANSI text safely when rendering the label.
 */
export function formatTodoWidgetText(text: string, prefix: string, width: number): string {
	const textWidth = Math.max(0, width - visibleWidth(prefix));
	return truncateToWidth(text, textWidth);
}

/**
 * Maximum number of todo rows the compact widget emits.
 *
 * pi's TUI hard-caps string-array widgets at `InteractiveMode.MAX_WIDGET_LINES`
 * (10) and replaces the overflow with a `... (widget truncated)` line - which
 * used to swallow exactly the steps still to do, since completed ones render
 * first. Staying at 8 leaves room for the trailing `after each step: ...` line
 * that `index.ts` appends (9 lines total) plus one spare line, so the widget
 * never trips the truncation even if another footer line shows up later.
 */
export const MAX_TODO_WIDGET_ROWS = 8;

/**
 * Condenses a plan's todo list into at most `maxRows` widget rows: a progress
 * summary, the step being worked on, the next few pending steps and a `+N more`
 * tail. The full list stays available through `/todos`.
 */
export function buildTodoWidgetRows(todos: TodoItem[], options: { maxRows?: number } = {}): TodoWidgetRow[] {
	const maxRows = options.maxRows ?? MAX_TODO_WIDGET_ROWS;
	// Nothing to show, or no room to show it in.
	if (todos.length === 0 || maxRows <= 0) return [];

	const completed = todos.filter((t) => t.completed).length;
	const remainingItems = todos.filter((t) => !t.completed);
	const rows: TodoWidgetRow[] = [
		{ kind: "summary", completed, remaining: remainingItems.length, total: todos.length },
	];
	// Nothing left to do: the summary alone tells the whole story, and there is
	// no current step to highlight. Same when the budget only fits the summary.
	if (remainingItems.length === 0 || maxRows === 1) return rows;

	for (const [index, item] of remainingItems.entries()) {
		const unshown = remainingItems.length - index;
		// The last available row has to account for everything still unshown, so
		// it becomes a `+N more` tail rather than yet another step. The current
		// step always wins its row first, so a two-row budget degrades to
		// summary + current (the summary already carries the `M left` count)
		// rather than summary + `more`.
		if (rows.length === maxRows - 1 && unshown > 1 && index > 0) {
			rows.push({ kind: "more", count: unshown });
			break;
		}
		if (rows.length >= maxRows) break;
		rows.push({ kind: index === 0 ? "current" : "pending", step: item.step, text: item.text });
	}

	return rows;
}
