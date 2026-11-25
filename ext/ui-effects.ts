// Ambient effects: animated tab title while working, desktop notification for long
// tasks, and (only on terminals that support it, or when enabled) a pulsing cursor color and a breathing terminal background via OSC.
// Settings: state/ui-effects.json  { "osc": true|false, "baseBg": "#161b2e", "notifyAfterSec": 30 }
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { colorToHex, mixColors, parseColor } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { breathe, tint } from "./lib/accent.ts";
import { spinnerFrame } from "./lib/ui-kit.ts";

type Cfg = { osc: boolean; baseBg?: string; notifyAfterSec: number };
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
	return { osc: capable, notifyAfterSec: 30, ...user };
}

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
				const c = tint(breathe(t, 2) * 0.6);
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
		if (startedAt && sec > cfg.notifyAfterSec) {
			write(`\x1b]777;notify;Pivot;Задача завершена\x07`);
			if (process.platform === "darwin") void pi.exec("osascript", ["-e", `display notification "Задача завершена (${Math.round(sec)} с)" with title "Pivot"`], { timeout: 5000 }).catch(() => undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		restoreTerminal();
	});
}
