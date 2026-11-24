// Ambient effects: confetti burst when a long task finishes, animated tab title while working, desktop notification for long
// tasks, and (only on terminals that support it, or when enabled) a pulsing cursor color and a breathing terminal background via OSC.
// Settings: state/ui-effects.json  { "osc": true|false, "baseBg": "#161b2e", "notifyAfterSec": 30, "confetti": true }
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, mixColors, parseColor, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gradientColor, phase } from "./lib/gradients.ts";
import { animate, spinnerFrame } from "./lib/ui-kit.ts";

type Cfg = { osc: boolean; baseBg?: string; notifyAfterSec: number; confetti: boolean };
function config(): Cfg {
	const term = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`.toLowerCase();
	const capable = /ghostty|iterm|wezterm|kitty/.test(term);
	let user: Partial<Cfg> = {};
	try {
		const p = join(homedir(), ".pi", "agent", "state", "ui-effects.json");
		if (existsSync(p)) user = JSON.parse(readFileSync(p, "utf8"));
	} catch {
		/* defaults */
	}
	return { osc: capable, notifyAfterSec: 30, confetti: true, ...user };
}

const GLYPHS = ["✦", "✧", "*", "·", "+", "•"];
const hash = (n: number) => {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;
	const cfg = config();
	const write = (s: string) => {
		try {
			process.stdout.write(s);
		} catch {
			/* not a TTY */
		}
	};
	const hex = (c: ReturnType<typeof mixColors>) => colorToHex(c);
	let startedAt = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let title = "pivot";

	const restoreTerminal = () => {
		if (!cfg.osc) return;
		write("\x1b]112\x07"); // cursor color back to default
		if (cfg.baseBg) write("\x1b]111\x07"); // background back to default
	};
	process.on("exit", restoreTerminal);

	pi.on("agent_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		startedAt = Date.now();
		title = ctx.sessionManager.getSessionName() || ctx.cwd.split("/").pop() || "pivot";
		ctx.ui.setWidget("celebrate", undefined as never);
		clearInterval(timer);
		timer = setInterval(() => {
			const t = Date.now() / 1000;
			if (cfg.osc) {
				const c = gradientColor(phase(t));
				write(`\x1b]12;${hex(c)}\x07`);
				if (cfg.baseBg) write(`\x1b]11;${hex(mixColors(parseColor(cfg.baseBg), c, 0.05 + 0.03 * Math.sin(t * 2)))}\x07`);
			}
		}, 140);
		timer.unref?.();
	});

	pi.on("agent_settled", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		clearInterval(timer);
		timer = undefined;
		restoreTerminal();
		const sec = (Date.now() - startedAt) / 1000;
		if (startedAt && cfg.confetti && sec > 8) burst(ctx.ui);
		if (startedAt && sec > cfg.notifyAfterSec) {
			write(`\x1b]777;notify;Pivot;Задача завершена\x07`);
			if (process.platform === "darwin") void pi.exec("osascript", ["-e", `display notification "Задача завершена (${Math.round(sec)} с)" with title "Pivot"`], { timeout: 5000 }).catch(() => undefined);
		}
	});

	/** A short burst of sparkles rising from the middle, fading with age (drawn above the prompt for ~1.6 s). */
	function burst(ui: { setWidget: (k: string, c: never) => void }) {
		const start = Date.now();
		const life = 1600;
		ui.setWidget(
			"celebrate",
			((tui: { requestRender(): void }, theme: Theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const age = Date.now() - start;
					if (age > life) return [];
					animate(tui, true, 40);
					const rows = 6;
					const grid = Array.from({ length: rows }, () => Array<string>(width).fill(" "));
					const k = age / life;
					for (let i = 0; i < 46; i++) {
						const ang = -Math.PI / 2 + (hash(i) - 0.5) * 2.6;
						const sp = 14 + hash(i + 99) * 34;
						const x = Math.round(width / 2 + Math.cos(ang) * sp * k * 2);
						const y = Math.round(rows - 1 + Math.sin(ang) * sp * 0.34 * k + 6 * k * k);
						if (x < 0 || x >= width || y < 0 || y >= rows) continue;
						const fade = Math.max(0, 1 - k * 1.1);
						const c = mixColors(parseColor("#161b2e"), gradientColor(hash(i + 7)), 0.25 + 0.75 * fade);
						grid[y]![x] = theme.style(GLYPHS[Math.floor(hash(i + 3) * GLYPHS.length)]!, { fg: c, bold: fade > 0.5 });
					}
					return grid.map((r) => truncateToWidth(r.join(""), width));
				},
			})) as never,
		);
		setTimeout(() => ui.setWidget("celebrate", undefined as never), life + 100).unref?.();
	}

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		restoreTerminal();
	});
}
