// Live task header: gradient title, session/task summary, classification badges (kind, fullstack, security, swarm, spec),
// branch and PR state, and a rule line with a sweeping light while the agent works.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { gradientText } from "./lib/gradients.ts";
import { animate, blend, rightAlign } from "./lib/ui-kit.ts";

type Class = { kind?: string; fullstack?: boolean; security?: boolean; subtasks?: number; spec_mode?: string; summary?: string; verifier?: string };
type Pr = { number: number; isDraft: boolean; state: string };

const KIND_RU: Record<string, string> = { question: "вопрос", spec: "спецификация", code: "разработка", debug: "отладка", review: "ревью", docs: "документация", ops: "операции" };

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	let cls: Class | undefined;
	let swarm = false;
	let pr: Pr | undefined;
	let prAt = 0;

	pi.events.on("task:classified", (d) => {
		cls = d as Class;
	});
	pi.on("input", async () => {
		cls = undefined;
		swarm = false;
	});
	pi.on("tool_execution_start", async (e) => {
		if (e.toolName === "subagent") swarm = true;
	});

	const refreshPr = async (cwd: string) => {
		if (Date.now() - prAt < 60_000) return;
		prAt = Date.now();
		try {
			const r = await pi.exec("gh", ["pr", "view", "--json", "number,isDraft,state"], { cwd, timeout: 8000 });
			pr = r.code === 0 ? (JSON.parse(r.stdout) as Pr) : undefined;
		} catch {
			pr = undefined;
		}
	};
	pi.on("agent_settled", async (_e, ctx) => void refreshPr(ctx.cwd));

	const pill = (theme: Theme, text: string, tone: "accent" | "success" | "warning" | "error" | "muted" | "mdLink") =>
		theme.style(` ${text} `, { fg: theme.colors[tone], bg: theme.colors.selectedBg, bold: true });

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		setTimeout(() => void refreshPr(ctx.cwd), 4000).unref?.();
		ctx.ui.setHeader((tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if ((globalThis as { __pivotSplash?: { visible: boolean } }).__pivotSplash?.visible) return [];
				const now = Date.now();
				const busy = !ctx.isIdle();
				animate(tui, busy);

				const title = gradientText(theme, "pivot", now / 1000);
				const name = ctx.sessionManager.getSessionName() || cls?.summary || "";
				const left = title + (name ? theme.fg("borderMuted", "  ▸  ") + theme.fg("text", truncateToWidth(name, Math.max(10, width - 60), "…")) : "");

				const pills: string[] = [];
				if (cls?.kind) pills.push(pill(theme, KIND_RU[cls.kind] ?? cls.kind, "accent"));
				if (cls?.fullstack) pills.push(pill(theme, "fullstack", "mdLink"));
				if (cls?.security) pills.push(pill(theme, "🔒 security", "error"));
				if (cls?.spec_mode && cls.spec_mode !== "none") pills.push(pill(theme, `spec:${cls.spec_mode}`, "warning"));
				if (cls?.kind && cls.kind !== "question") pills.push(pill(theme, swarm || (cls.subtasks ?? 0) > 3 ? `подагенты ×${cls.subtasks ?? "?"}` : "один агент", swarm ? "success" : "muted"));
				if (pr) pills.push(pill(theme, `PR #${pr.number}${pr.isDraft ? " draft" : ""}`, pr.state === "MERGED" ? "success" : "mdLink"));
				const line1 = rightAlign(left, pills.join(" "), width);

				// Rule: static dim line when idle; a light sweeps along it while the agent works.
				let rule = "";
				const pos = ((now / 40) % (width + 16)) - 8;
				for (let i = 0; i < width; i++) {
					const k = busy ? Math.max(0, 1 - Math.abs(i - pos) / 8) : 0;
					rule += blend(theme, "borderMuted", "accent", k, "━");
				}
				return [line1, rule];
			},
		}));
	});
}
