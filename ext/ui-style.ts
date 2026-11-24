// Decoration: gradient working indicator, live status message ("Читаю src/app.ts"), terminal title, and prettier tool-call
// headers (icon, name, argument, spinner while running → ✓/✗ + duration). Tool results keep pi's own renderers.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, parseColor, truncateToWidth } from "@earendil-works/pi-tui";
import { GRADIENT_PERIOD, GRADIENTS, currentGradient, gradientColor, phase, syncShader } from "./lib/gradients.ts";
import { animate, fmtDur, spinnerFrame } from "./lib/ui-kit.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ICON: Record<string, [string, string]> = {
	read: ["◧", "читаю"], write: ["✎", "пишу"], edit: ["✐", "правлю"], bash: ["❯", "запускаю"], grep: ["⌕", "ищу"], find: ["⌕", "ищу файлы"], ls: ["☰", "смотрю"],
	classify_task: ["◈", "классифицирую"], find_skills: ["✦", "ищу skills"], ask_opus: ["♛", "советуюсь с Opus"],
};

function target(tool: string, a: Record<string, unknown> | undefined): string {
	if (!a) return "";
	const v = (a.path ?? a.file_path ?? a.pattern ?? a.command ?? a.query ?? a.keywords ?? a.summary ?? a.question) as unknown;
	return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;
	let title = "pi";

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		syncShader();
		const th: Theme = ctx.ui.theme;
		const frames = ["▖", "▌", "▘", "▀", "▝", "▐", "▗", "▄"].map((f, i) => th.style(f, { fg: mixColors(th.colors.accent, th.colors.mdLink, (Math.sin((i / 8) * Math.PI * 2) + 1) / 2), bold: true }));
		ctx.ui.setWorkingIndicator({ frames, intervalMs: 80 });
		ctx.ui.setWorkingVisible(false); // the "vibing" widget above the prompt replaces pi's own loader row
		ctx.ui.setHiddenThinkingLabel("");
	});
	// "Vibing..." line directly above the prompt, flush left: animated spinner, shimmering word, elapsed time, current activity.
	let activity = "";
	let startedAt = 0;
	let widgetOn = false;
	const showVibe = (ctx: { ui: { setWidget: (k: string, c: never) => void } }) => {
		if (widgetOn) return;
		widgetOn = true;
		ctx.ui.setWidget(
			"vibe",
			((tui: { requestRender(): void }, theme: Theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const now = Date.now();
					animate(tui, true, 60);
					const t = now / 1000;
					const spin = theme.style(spinnerFrame(now), { fg: gradientColor(phase(t)), bold: true });
					// a bright band sweeps across the letters over the animated gradient
					const word = [..."Vibing..."].map((c, i) => {
						const band = Math.max(0, 1 - Math.abs(i - ((now / 90) % 14 - 3)) / 2.5);
						return theme.style(c, { fg: mixColors(gradientColor(phase(t) * 0.5 + (i / 9) * 0.5), parseColor("#ffffff"), band * 0.85), bold: true });
					}).join("");
					const tail = theme.fg("dim", `  ${fmtDur(now - startedAt)}${activity ? `  ·  ${activity}` : ""}`);
					return [truncateToWidth(`${spin} ${word}${tail}`, width, "…")];
				},
			})) as never,
		);
	};
	pi.on("agent_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		startedAt = Date.now();
		activity = "";
		showVibe(ctx as never);
	});
	pi.on("tool_execution_start", async (e, ctx) => {
		if (ctx.mode !== "tui") return;
		const [, verb] = ICON[e.toolName] ?? ["◆", e.toolName];
		const t = target(e.toolName, e.args);
		activity = `${verb ?? e.toolName}${t ? ` ${t.slice(0, 80)}` : ""}`;
	});
	pi.on("agent_settled", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		widgetOn = false;
		ctx.ui.setWidget("vibe", undefined as never);
	});

	pi.registerCommand("gradient", {
		description: "Выбрать градиент заставки, заголовка и «Vibing...»",
		handler: async (arg, ctx) => {
			const names = Object.keys(GRADIENTS);
			let name = arg.trim();
			if (!GRADIENTS[name]) {
				const cur = currentGradient();
				const picked = await ctx.ui.select("Градиент", names.map((n) => `${n === cur ? "● " : "  "}${n} — ${GRADIENTS[n]!.label}`));
				name = names.find((n) => picked?.includes(` ${n} — `)) ?? "";
			}
			if (!GRADIENTS[name]) return;
			mkdirSync(join(homedir(), ".pi", "agent", "state"), { recursive: true });
			writeFileSync(join(homedir(), ".pi", "agent", "state", "ui-gradient.json"), JSON.stringify({ name }));
			ctx.ui.notify(`Градиент: ${GRADIENTS[name]!.label}`, "info");
			// Keep the Ghostty shader in the same colors and ask Ghostty (if it is running) to reload its config.
			if (syncShader(name) && process.platform === "darwin") {
				void pi
					.exec("osascript", ["-e", 'tell application "Ghostty"', "-e", "repeat with w in windows", "-e", "perform action \"reload_config\" on (terminal 1 of selected tab of w)", "-e", "exit repeat", "-e", "end repeat", "-e", "end tell"], { timeout: 5000 })
					.catch(() => undefined);
			}
			// A moving preview bar above the prompt for a few seconds, so the change is visible right away.
			const until = Date.now() + 8000;
			ctx.ui.setWidget(
				"gradient-preview",
				((tui: { requestRender(): void }, theme: Theme) => ({
					invalidate() {},
					render(width: number): string[] {
						const now = Date.now();
						animate(tui, now < until, 40);
						const n = Math.max(10, Math.min(width - 2, 72));
						let bar = "";
						for (let i = 0; i < n; i++) bar += theme.style("█", { fg: gradientColor(phase(now / 1000 + (i / n) * GRADIENT_PERIOD), name) });
						return [` ${theme.style(name, { fg: gradientColor(0.5, name), bold: true })} ${theme.fg("dim", GRADIENTS[name]!.label)}`, ` ${bar}`];
					},
				})) as never,
			);
			setTimeout(() => ctx.ui.setWidget("gradient-preview", undefined as never), 8000).unref?.();
		},
	});

	pi.registerToolRenderer((name, next) => {
		const base = next();
		const style = ICON[name];
		if (!style) return base;
		return {
			...base,
			renderCall(rawArgs: unknown, theme: Theme, context) {
				const args = rawArgs as Record<string, unknown>;
				const state = context.state as { timer?: ReturnType<typeof setInterval> };
				const running = context.executionStarted && context.isPartial;
				if (running && !state.timer) {
					state.timer = setInterval(() => context.invalidate(), 100);
					state.timer.unref?.();
				}
				if (!running && state.timer) {
					clearInterval(state.timer);
					state.timer = undefined;
				}
				const mark = running ? theme.fg("accent", spinnerFrame()) : context.isError ? theme.fg("error", "✗") : context.durationMs !== undefined ? theme.fg("success", "✓") : theme.fg("dim", "○");
				const dur = context.durationMs !== undefined && context.durationMs > 800 ? theme.fg("dim", `  ${fmtDur(context.durationMs)}`) : "";
				return {
					invalidate() {},
					render(width: number) {
						const head = `${mark} ${theme.fg("toolTitle", `${style[0]} ${name}`)}`;
						const t = target(name, args);
						const body = t ? "  " + theme.fg(name === "bash" ? "bashMode" : "accent", t) : "";
						return [truncateToWidth(head + body + dur, width, "…")];
					},
				};
			},
		};
	});
}
