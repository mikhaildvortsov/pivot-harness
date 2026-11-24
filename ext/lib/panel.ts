// Generic keyboard-driven overlay panel: a stack of views (list with optional type-to-filter, or a scrollable text body),
// drawn in a rounded frame. Used by the sessions, swarm, checks and palette panels.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { animate, fit, frame, fuzzy } from "./ui-kit.ts";

export type Row = {
	key: string;
	/** Plain text used for filtering. */
	label: string;
	/** One styled line; `sel` is true for the highlighted row. Must fit `width` (it is truncated otherwise). */
	render: (width: number, sel: boolean) => string;
	/** Extra styled lines shown under the row while it is highlighted. */
	detail?: () => string[];
	data?: unknown;
};

export type View = {
	title: string;
	hint: string;
	rows?: () => Row[];
	/** Scrollable text instead of rows (transcripts, details). */
	body?: () => string[];
	/** Lines pinned above the list (summary). */
	header?: () => string[];
	filterable?: boolean;
	empty?: string;
	/** True while something in the view animates (keeps the render clock running). */
	animated?: () => boolean;
	followBottom?: boolean;
	onSelect?: (row: Row, panel: Panel) => void;
	/** Return true when the key was handled. */
	onKey?: (data: string, row: Row | undefined, panel: Panel) => boolean;
};

const printable = (d: string) => !d.startsWith("\x1b") && /^[^\x00-\x1f\x7f]+$/.test(d);

export class Panel {
	focused = false;
	private stack: View[];
	private sel = 0;
	private top = 0;
	private bodyTop = 0;
	private filter = "";
	private lastRows: Row[] = [];

	constructor(
		readonly tui: { requestRender(): void; terminal: { rows: number } },
		readonly theme: Theme,
		private readonly doneFn: (result?: unknown) => void,
		root: View,
	) {
		this.stack = [root];
	}

	get view(): View {
		return this.stack[this.stack.length - 1]!;
	}
	push(v: View) {
		this.stack.push(v);
		this.sel = this.top = this.bodyTop = 0;
		this.filter = "";
		this.tui.requestRender();
	}
	pop() {
		if (this.stack.length <= 1) return this.close();
		this.stack.pop();
		this.sel = this.top = this.bodyTop = 0;
		this.filter = "";
		this.tui.requestRender();
	}
	close(result?: unknown) {
		this.doneFn(result);
	}
	invalidate() {}

	private rows(): Row[] {
		const all = this.view.rows?.() ?? [];
		if (!this.filter) return all;
		return all
			.map((r) => ({ r, s: fuzzy(this.filter, r.label) }))
			.filter((x) => x.s >= 0)
			.sort((a, b) => a.s - b.s)
			.map((x) => x.r);
	}

	render(width: number): string[] {
		const th = this.theme;
		const v = this.view;
		const inner = Math.max(10, width - 2);
		const avail = Math.max(6, this.tui.terminal.rows - 8);
		const lines: string[] = [];
		animate(this.tui, v.animated?.() ?? false);

		const head = v.header?.() ?? [];
		lines.push(...head);
		if (v.filterable) lines.push(" " + th.fg("accent", "›") + " " + (this.filter ? th.fg("text", this.filter) : th.fg("dim", "начните печатать для поиска")) + th.fg("accent", "▏"));
		const room = Math.max(3, avail - lines.length);

		if (v.body) {
			const all = v.body().flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, inner - 2).map((x) => " " + x)));
			const max = Math.max(0, all.length - room);
			if (v.followBottom && this.bodyTop === Number.MAX_SAFE_INTEGER) this.bodyTop = max;
			this.bodyTop = Math.max(0, Math.min(this.bodyTop, max));
			const slice = all.slice(this.bodyTop, this.bodyTop + room);
			lines.push(...slice);
			if (all.length > room) lines.push(th.fg("dim", ` ${this.bodyTop + 1}–${Math.min(all.length, this.bodyTop + room)} из ${all.length}`));
		} else {
			const rows = (this.lastRows = this.rows());
			this.sel = Math.max(0, Math.min(this.sel, rows.length - 1));
			if (rows.length === 0) lines.push(th.fg("dim", " " + (v.empty ?? "пусто")));
			// Window of rows around the selection; the selected row may expand with detail lines.
			const detail = rows[this.sel]?.detail?.() ?? [];
			const rowRoom = Math.max(3, room - detail.length);
			if (this.sel < this.top) this.top = this.sel;
			if (this.sel >= this.top + rowRoom) this.top = this.sel - rowRoom + 1;
			for (let i = this.top; i < Math.min(rows.length, this.top + rowRoom); i++) {
				const r = rows[i]!;
				const selected = i === this.sel;
				const text = truncateToWidth(r.render(inner - 3, selected), inner - 3, "…");
				const line = (selected ? th.fg("accent", " ▸ ") : "   ") + text;
				lines.push(selected ? th.bg("selectedBg", fit(line, inner)) : line);
				if (selected) for (const d of detail) lines.push("     " + truncateToWidth(d, inner - 6, "…"));
			}
			if (rows.length > rowRoom) lines.push(th.fg("dim", ` ${this.sel + 1}/${rows.length}`));
		}
		const depth = this.stack.length > 1 ? this.stack.map((s) => s.title).join(" › ") : v.title;
		return frame(th, depth, lines, width, v.hint, true);
	}

	handleInput(data: string): void {
		const v = this.view;
		const row = this.lastRows[this.sel];
		if (v.onKey?.(data, row, this)) return this.tui.requestRender();

		if (matchesKey(data, "escape")) {
			if (v.filterable && this.filter) this.filter = "";
			else this.pop();
			return this.tui.requestRender();
		}
		const page = Math.max(3, this.tui.terminal.rows - 12);
		if (v.body) {
			if (matchesKey(data, "up") || data === "k") this.bodyTop = Math.max(0, (this.bodyTop === Number.MAX_SAFE_INTEGER ? 1e9 : this.bodyTop) - 1);
			else if (matchesKey(data, "down") || data === "j") this.bodyTop += 1;
			else if (matchesKey(data, "pageUp")) this.bodyTop = Math.max(0, this.bodyTop - page);
			else if (matchesKey(data, "pageDown")) this.bodyTop += page;
			else if (matchesKey(data, "home") || data === "g") this.bodyTop = 0;
			else if (matchesKey(data, "end") || data === "G") this.bodyTop = Number.MAX_SAFE_INTEGER;
			else return;
			return this.tui.requestRender();
		}
		const n = this.lastRows.length;
		if (matchesKey(data, "up") || (!v.filterable && data === "k")) this.sel = Math.max(0, this.sel - 1);
		else if (matchesKey(data, "down") || (!v.filterable && data === "j")) this.sel = Math.min(n - 1, this.sel + 1);
		else if (matchesKey(data, "pageUp")) this.sel = Math.max(0, this.sel - page);
		else if (matchesKey(data, "pageDown")) this.sel = Math.min(n - 1, this.sel + page);
		else if (matchesKey(data, "home")) this.sel = 0;
		else if (matchesKey(data, "end")) this.sel = Math.max(0, n - 1);
		else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (row) v.onSelect?.(row, this);
		} else if (v.filterable && matchesKey(data, "backspace")) this.filter = [...this.filter].slice(0, -1).join("");
		else if (v.filterable && printable(data)) {
			this.filter += data;
			this.sel = this.top = 0;
		} else return;
		this.tui.requestRender();
	}
}

/** Open a panel as a right-anchored (or centered) overlay and resolve with whatever the panel passes to close(). */
export function panelOptions(side: "right" | "center", widthPct = 46) {
	const pct = (n: number) => `${n}%` as const;
	return side === "right"
		? { overlay: true, overlayOptions: { anchor: "top-right" as const, width: pct(widthPct), minWidth: 48, maxHeight: pct(92), margin: { top: 1, right: 1, bottom: 1 } } }
		: { overlay: true, overlayOptions: { anchor: "center" as const, width: pct(70), minWidth: 56, maxHeight: pct(86) } };
}
