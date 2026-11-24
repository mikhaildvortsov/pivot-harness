// Shared drawing helpers for the harness TUI (header, footer, panels). Pure functions + one shared animation clock.
// Every function takes the active theme so palettes follow /theme changes. No pi state lives here.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = join(homedir(), ".pi", "agent");

export type KeyName = "sessions" | "swarm" | "checks" | "palette" | "newtab";
/**
 * Shortcut keys per platform: ~/.pi/agent/ui-keys.json (tracked, darwin / win32 / linux), overridden by
 * ~/.pi/agent/state/ui-keys.json ({ "sessions": "ctrl+r", ... }, untracked). Each action has one or more keys.
 */
export const KEYS: Record<KeyName, string[]> = (() => {
	const fallback = process.platform === "darwin" ? { sessions: "ctrl+r", swarm: "ctrl+f", checks: "ctrl+b", palette: ["ctrl+y", "f1"], newtab: "ctrl+n" } : { sessions: "alt+s", swarm: "alt+w", checks: "alt+c", palette: ["alt+k", "f1"], newtab: "alt+n" };
	const read = (p: string): Record<string, unknown> => {
		try {
			return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
		} catch {
			return {};
		}
	};
	const shipped = read(join(AGENT_DIR, "ui-keys.json"));
	const platform = (shipped[process.platform] ?? shipped.linux ?? {}) as Record<string, unknown>;
	const local = read(join(AGENT_DIR, "state", "ui-keys.json"));
	const out = {} as Record<KeyName, string[]>;
	for (const name of ["sessions", "swarm", "checks", "palette", "newtab"] as const) {
		const v = local[name] ?? platform[name] ?? fallback[name];
		out[name] = (Array.isArray(v) ? v : [v]).filter((k): k is string => typeof k === "string" && k.length > 0);
	}
	return out;
})();

/** Human label for a key id: macOS symbols (⌃R, ⌥S) elsewhere Ctrl+R / Alt+S. */
export function keyLabel(id: string | undefined): string {
	if (!id) return "";
	const mac = process.platform === "darwin";
	return id
		.split("+")
		.map((p) => (p === "ctrl" ? (mac ? "⌃" : "Ctrl+") : p === "alt" ? (mac ? "⌥" : "Alt+") : p === "shift" ? (mac ? "⇧" : "Shift+") : p === "super" ? (mac ? "⌘" : "Win+") : p.length === 1 ? p.toUpperCase() : p.toUpperCase()))
		.join("");
}

export type Tone = "success" | "error" | "warning" | "accent" | "muted" | "dim" | "text";
export type Status = "queued" | "running" | "pass" | "fail" | "skip" | "paused";

// pixel spinner: a block quadrant orbiting a square (frames after pi-beautiful-tui's Pixel style)
const FRAMES = ["▖", "▌", "▘", "▀", "▝", "▐", "▗", "▄"];
export const spinnerFrame = (now = Date.now()) => FRAMES[Math.floor(now / 80) % FRAMES.length]!;

export const GLYPH: Record<Status, string> = { queued: "○", running: "●", pass: "✓", fail: "✗", skip: "◌", paused: "⏸" };
export const TONE: Record<Status, Tone> = { queued: "dim", running: "accent", pass: "success", fail: "error", skip: "muted", paused: "warning" };

/** Blend two theme colors; t=0 → a, t=1 → b. */
export function blend(theme: Theme, a: keyof Theme["colors"], b: keyof Theme["colors"], t: number, text: string, bold = false): string {
	return theme.style(text, { fg: mixColors(theme.colors[a], theme.colors[b], Math.max(0, Math.min(1, t))), bold });
}

/** Horizontal gradient across a string between two theme colors. */
export function gradient(theme: Theme, text: string, a: keyof Theme["colors"], b: keyof Theme["colors"], bold = false): string {
	const chars = [...text];
	return chars.map((c, i) => (c === " " ? c : blend(theme, a, b, chars.length < 2 ? 0 : i / (chars.length - 1), c, bold))).join("");
}

/** Skeleton shimmer: a bright band sweeping across `width` block cells (running placeholder). */
export function skeleton(theme: Theme, width: number, now = Date.now(), glyph = "▬"): string {
	if (width <= 0) return "";
	const span = width + 8;
	const pos = ((now / 70) % span) - 4;
	let out = "";
	for (let i = 0; i < width; i++) {
		const d = Math.abs(i - pos);
		const k = d > 3 ? 0 : 1 - d / 3;
		out += blend(theme, "borderMuted", "accent", k * 0.85, glyph);
	}
	return out;
}

/** Pulsing dot for running state. */
export function pulse(theme: Theme, now = Date.now(), glyph = "●"): string {
	const k = (Math.sin(now / 260) + 1) / 2;
	return blend(theme, "muted", "accent", k, glyph, true);
}

export function statusMark(theme: Theme, s: Status, now = Date.now()): string {
	if (s === "running") return pulse(theme, now, spinnerFrame(now));
	return theme.fg(TONE[s], GLYPH[s]);
}

export const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(2)}M`);
export const fmtMoney = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}с`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}м${String(s % 60).padStart(2, "0")}с` : `${Math.floor(m / 60)}ч${String(m % 60).padStart(2, "0")}м`;
}
export function fmtAge(d: Date | number): string {
	const ms = Date.now() - (typeof d === "number" ? d : d.getTime());
	if (ms < 60_000) return "сейчас";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m} мин`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} д`;
}

export const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - visibleWidth(s)));
export const fit = (s: string, width: number) => pad(truncateToWidth(s, width, "…"), width);
export const rightAlign = (left: string, right: string, width: number) => {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 1), "…") + " " + right;
};

/** Rounded frame with a title in the top border and an optional hint line in the bottom border. */
export function frame(theme: Theme, title: string, body: string[], width: number, hint = "", accent = false): string[] {
	const inner = Math.max(4, width - 2);
	const edge = (s: string) => theme.fg(accent ? "borderAccent" : "border", s);
	const t = title ? ` ${title} ` : "";
	const top = edge("┏━") + (accent ? gradient(theme, t.trim() ? t : "", "accent", "mdLink", true) : theme.fg("accent", t)) + edge("━".repeat(Math.max(0, inner - 1 - visibleWidth(t))) + "┓");
	const rows = body.map((l) => edge("┃") + fit(l, inner) + edge("┃"));
	const h = hint ? ` ${hint} ` : "";
	const bottom = edge("┗" + "━".repeat(Math.max(0, inner - visibleWidth(h) - 1))) + theme.fg("dim", h) + edge("━┛");
	return [top, ...rows, bottom];
}

/** Pixel progress bar like ▐████····▌ in the given tone. */
export function meter(theme: Theme, ratio: number, cells: number, tone: Tone): string {
	const r = Math.max(0, Math.min(1, ratio));
	const on = Math.round(r * cells);
	return theme.fg("borderMuted", "▐") + theme.fg(tone, "█".repeat(on)) + theme.fg("borderMuted", "·".repeat(cells - on)) + theme.fg("borderMuted", "▌");
}

/**
 * One shared animation clock: components call `animate(tui, active)` each render; while any is active the clock requests
 * renders every `intervalMs`, and it stops by itself when nothing needs animation. Keeps idle CPU at zero.
 */
const clocks = new WeakMap<object, { timer?: ReturnType<typeof setInterval>; until: number }>();
export function animate(tui: { requestRender(): void }, active: boolean, intervalMs = 90): void {
	let c = clocks.get(tui);
	if (!c) clocks.set(tui, (c = { until: 0 }));
	if (active) c.until = Date.now() + Math.max(intervalMs * 4, 1500);
	if (active && !c.timer) {
		c.timer = setInterval(() => {
			if (Date.now() > c!.until) {
				clearInterval(c!.timer);
				c!.timer = undefined;
				return;
			}
			tui.requestRender();
		}, intervalMs);
		c.timer.unref?.();
	}
}

/** Simple type-to-filter fuzzy match: every query char must appear in order. Returns a score ≥ 0 (lower is better) or -1 when it does not match. */
export function fuzzy(query: string, text: string): number {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (!q) return 0;
	let ti = 0;
	let score = 0;
	let last = -1;
	for (const ch of q) {
		const at = t.indexOf(ch, ti);
		if (at < 0) return -1;
		score += at - last - 1;
		last = at;
		ti = at + 1;
	}
	return 1000 + score + (t.startsWith(q) ? -50 : t.includes(q) ? -20 : 0);
}
