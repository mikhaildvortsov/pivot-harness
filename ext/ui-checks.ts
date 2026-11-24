// Checks panel: everything that verifies or blocks the agent in the current task, with ✓/✗ and live state.
// Gates publish pi.events "check:result" { id, group, label, status, detail? }; this extension collects them,
// shows a summary in the footer status and opens the panel on /checks or the shortcut.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Panel, panelOptions, type Row } from "./lib/panel.ts";
import { fmtDur, KEYS, statusMark, type Status, TONE } from "./lib/ui-kit.ts";

export type CheckEvent = { id: string; group: "code" | "review" | "guard"; label: string; status: Status; detail?: string };
type Stored = CheckEvent & { startedAt: number; endedAt?: number; count: number };

const GROUP: Record<CheckEvent["group"], string> = { code: "Код", review: "Ревью", guard: "Защиты" };

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;
	const checks = new Map<string, Stored>();
	let ui: { setStatus(key: string, text: string | undefined): void } | undefined;

	const summary = () => {
		const all = [...checks.values()];
		const c = (s: Status) => all.filter((x) => x.status === s).length;
		return all.length ? `✓${c("pass")} ✗${c("fail")}${c("running") ? ` ◐${c("running")}` : ""}` : undefined;
	};

	pi.events.on("check:result", (d) => {
		const e = d as CheckEvent;
		const prev = checks.get(e.id);
		const now = Date.now();
		checks.set(e.id, {
			...e,
			startedAt: prev && prev.status === "running" ? prev.startedAt : now,
			endedAt: e.status === "running" ? undefined : now,
			count: (prev?.count ?? 0) + (e.status === "fail" || e.group === "guard" ? 1 : 0),
		});
		ui?.setStatus("checks", summary());
	});
	// Gates that refuse a tool call return a reason starting with "<gate>:"; surface those as guard rows.
	const GATE = /^(config-guard|anti-laziness|swarm-gate|subagent-skills|git-guard|opus-director|task-classifier):/;
	pi.on("tool_result", async (e) => {
		if (!e.isError) return;
		const text = e.content?.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
		const m = GATE.exec(text);
		if (m) pi.events.emit("check:result", { id: `guard:${m[1]}`, group: "guard", label: m[1]!, status: "fail", detail: text.slice(0, 600) });
	});
	pi.on("input", async () => {
		checks.clear();
		ui?.setStatus("checks", undefined);
	});

	const open = async (ctx: Parameters<Parameters<typeof pi.registerShortcut>[1]["handler"]>[0]) => {
		if (ctx.mode !== "tui") return;
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const rows = (): Row[] =>
					[...checks.values()]
						.sort((a, b) => a.group.localeCompare(b.group) || a.startedAt - b.startedAt)
						.map((c) => ({
							key: c.id,
							label: `${GROUP[c.group]} ${c.label}`,
							data: c,
							render: (_w, sel) => {
								const dur = fmtDur((c.endedAt ?? Date.now()) - c.startedAt);
								const times = c.group === "guard" && c.count > 1 ? theme.fg("warning", ` ×${c.count}`) : "";
								return `${statusMark(theme, c.status)} ${theme.fg("dim", GROUP[c.group].padEnd(7))} ${theme.fg(sel ? "text" : TONE[c.status] === "dim" ? "dim" : "text", c.label)}${times} ${theme.fg("dim", c.status === "running" || c.group !== "guard" ? dur : "")}`;
							},
							detail: () => (c.detail ? c.detail.split("\n").slice(0, 6).map((l) => theme.fg("dim", l)) : []),
						}));
				const panel = new Panel(tui, theme, () => done(), {
					title: "Проверки",
					hint: "↑↓ выбор · enter подробно · esc закрыть",
					rows,
					empty: "Пока нет проверок: они появятся, когда агент изменит код.",
					animated: () => [...checks.values()].some((c) => c.status === "running"),
					header: () => {
						const all = [...checks.values()];
						const n = (s: Status) => all.filter((x) => x.status === s).length;
						return [
							` ${theme.fg("success", `✓ ${n("pass")} пройдено`)}  ${theme.fg("error", `✗ ${n("fail")} провалено`)}  ${theme.fg("accent", `● ${n("running")} идёт`)}`,
							"",
						];
					},
					onSelect: (row, p) => {
						const c = row.data as Stored;
						p.push({
							title: c.label,
							hint: "↑↓ прокрутка · esc назад",
							body: () => [theme.fg(TONE[c.status], `${c.status}`) + theme.fg("dim", `  ${GROUP[c.group]}`), "", ...(c.detail ?? "без подробностей").split("\n")],
						});
					},
				});
				return panel;
			},
			panelOptions("right"),
		);
	};

	pi.on("session_start", async (_e, ctx) => {
		ui = ctx.mode === "tui" ? ctx.ui : undefined;
	});
	for (const key of KEYS.checks) pi.registerShortcut(key as never, { description: "Панель проверок", handler: open });
	pi.registerCommand("checks", { description: "Панель проверок текущей задачи", handler: async (_a, ctx) => open(ctx) });
}
