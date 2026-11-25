// Swarm panel: live tree of subagent runs (workflow → stage/agent), ✓ done / ✗ failed / shimmering skeleton while running.
//  - compact widget above the editor while a swarm runs (hotkey or /subagents opens the full panel)
//  - panel: enter walks into a run, a stage, an agent (live tool, output, usage, final result); esc walks back out
// Data: foreground `subagent` tool calls (tool_execution_* events with details.results/progress) and background runs
// (pi-subagents RPC `status` → asyncSnapshot), refreshed on pi-subagents events.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Panel, panelOptions, type Row, type View } from "./lib/panel.ts";
import { animate, fmtDur, fmtTokens, KEYS, keyLabel, skeleton, statusMark, type Status, TONE } from "./lib/ui-kit.ts";

type Node = {
	id: string;
	label: string;
	state: Status;
	startedAt?: number;
	endedAt?: number;
	agent?: string;
	model?: string;
	task?: string;
	tool?: string;
	toolArgs?: string;
	tokens?: number;
	recentTools?: string[];
	output?: string[];
	finalOutput?: string;
	error?: string;
	runId?: string;
	index?: number;
	sessionFile?: string;
	source: "foreground" | "async";
	children: Node[];
};

const asyncState = (s: string): Status =>
	s === "running" ? "running" : s === "queued" ? "queued" : s === "complete" ? "pass" : s === "paused" ? "paused" : s === "stopped" ? "skip" : "fail";
const progState = (s?: string): Status => (s === "running" || s === "detached" ? "running" : s === "completed" ? "pass" : s === "failed" ? "fail" : "queued");

/** Role name for a worker: its task label when it is short ("frontend"), else the agent type. */
const roleName = (k: { label: string; agent?: string }) => (/^[\p{L}\d_.\/-]{2,16}$/u.test(k.label.trim()) ? k.label.trim() : (k.agent ?? k.label));
const short = (s: string | undefined, n = 70) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
const debug = (kind: string, data: unknown) => {
	if (process.env.UI_DEBUG) appendFileSync("/tmp/ui-swarm-debug.jsonl", JSON.stringify({ t: Date.now(), kind, data }).slice(0, 20000) + "\n");
};

const sessionCache = new Map<string, { at: number; size: number; lines: string[] }>();
/** Plain-text transcript of a child's session file (user task, assistant text, tool calls and short results), newest last. */
function readSession(file: string | undefined): string[] {
	if (!file || !existsSync(file)) return [];
	const hit = sessionCache.get(file);
	if (hit && Date.now() - hit.at < 600) return hit.lines;
	try {
		const size = statSync(file).size;
		if (hit && hit.size === size) return hit.lines;
		const lines: string[] = [];
		for (const raw of readFileSync(file, "utf8").split("\n")) {
			if (!raw) continue;
			let e: any;
			try {
				e = JSON.parse(raw);
			} catch {
				continue;
			}
			const m = e.type === "message" ? e.message : undefined;
			if (!m) continue;
			const parts: any[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
			if (m.role === "toolResult") {
				const txt = parts.map((p) => p.text ?? "").join(" ").trim().split("\n").slice(0, 3).join(" ⏎ ");
				if (txt) lines.push(`   ⎿ ${txt.slice(0, 240)}`);
			} else if (m.role === "assistant") {
				for (const p of parts) {
					if (p.type === "text" && p.text?.trim()) lines.push(...String(p.text).trim().split("\n"));
					else if (p.type === "toolCall") lines.push(`❯ ${p.name} ${short(typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments), 160)}`);
				}
			}
		}
		sessionCache.set(file, { at: Date.now(), size, lines });
		return lines;
	} catch {
		return hit?.lines ?? [];
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	const foreground = new Map<string, Node>();
	const argsById = new Map<string, Record<string, unknown>>();
	let asyncRuns: Node[] = [];
	let transcripts = new Map<string, string[]>();
	const sessionFiles = new Map<string, string>(); // async node id → child session file (parsed from the RPC transcript view)
	const fetching = new Set<string>();
	let uiCtx: { ui: { setWidget: (k: string, c: never, o?: never) => void } } | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;

	const runs = () => [...foreground.values(), ...asyncRuns].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 12);
	const anyRunning = () => runs().some((r) => r.state === "running" || r.children.some((c) => c.state === "running"));

	// ── foreground: subagent tool calls ───────────────────────────────────────────────────────────────────────────
	const planned = (args: Record<string, unknown>): Array<{ agent?: string; task?: string; label?: string }> => {
		const list = (args.tasks ?? args.chain) as Array<Record<string, unknown>> | undefined;
		if (Array.isArray(list)) return list.map((t) => ({ agent: t.agent as string, task: (t.task ?? t.label) as string, label: t.label as string }));
		return [{ agent: args.agent as string, task: args.task as string }];
	};

	const fromDetails = (callId: string, args: Record<string, unknown>, d: Record<string, unknown> | undefined, done?: { isError: boolean }) => {
		const prev = foreground.get(callId);
		const plan = planned(args);
		const results = (d?.results as Array<Record<string, any>> | undefined) ?? [];
		const progress = (d?.progress as Array<Record<string, any>> | undefined) ?? [];
		const n = Math.max(plan.length, results.length, progress.length);
		const mode = Array.isArray(args.chain) ? "цепочка" : Array.isArray(args.tasks) ? "параллельно" : "агент";
		const wf = (d?.workflowChildren as { children?: Array<Record<string, any>> } | undefined)?.children;
		const trace = ((d?.workflow as { trace?: Array<Record<string, any>> } | undefined)?.trace ?? []).filter((x) => x.state === "completed" || x.state === "failed");
		const children: Node[] = [];
		if (wf || trace.length) {
			const keys = new Map<string, Record<string, any>>();
			plan.forEach((p, i) => keys.set(`task-${i + 1}`, { childId: `task-${i + 1}`, state: "queued", agent: p.agent, plan: p }));
			for (const c of wf ?? []) keys.set(c.childId, { ...keys.get(c.childId), ...c });
			const ordered = [...keys.values()].sort((a, b) => String(a.childId).localeCompare(String(b.childId), undefined, { numeric: true }));
			ordered.forEach((c, i) => {
				const tr = trace.find((x) => x.key === c.childId);
				const st: Status = tr ? (tr.state === "completed" ? "pass" : "fail") : c.state === "running" ? "running" : c.state === "completed" ? "pass" : c.state === "failed" || c.state === "error" ? "fail" : "queued";
				const old = prev?.children.find((x) => x.id === `${callId}:${c.childId}`);
				children.push({
					id: `${callId}:${c.childId}`,
					label: short((c.sessionName as string | undefined)?.replace(/^[^:]+:\s*/, "") ?? c.plan?.label ?? c.plan?.task ?? c.childId, 60),
					state: st,
					startedAt: old?.startedAt ?? (st !== "queued" ? Date.now() : undefined),
					endedAt: st === "pass" || st === "fail" ? (old?.endedAt ?? Date.now()) : undefined,
					agent: c.agent ?? c.plan?.agent,
					model: (c.model as string | undefined)?.replace(/^router\//, ""),
					task: c.plan?.task ?? old?.task,
					tool: c.activity?.currentTool,
					tokens: c.activity?.tokens ?? old?.tokens,
					sessionFile: c.sessionFile ?? old?.sessionFile,
					index: i,
					source: "foreground",
					children: [],
				});
			});
		}
		for (let i = 0; i < (children.length ? 0 : n); i++) {
			const r = results.find((x) => x.index === i) ?? results[i];
			const p = (r?.progress ?? progress.find((x) => x.index === i) ?? progress[i]) as Record<string, any> | undefined;
			const finished = r && typeof r.exitCode === "number" && (!p || p.status !== "running");
			const state: Status = p ? progState(p.status) : finished ? (r.exitCode === 0 ? "pass" : "fail") : done ? (done.isError ? "fail" : "pass") : "queued";
			const startedAt = prev?.children[i]?.startedAt ?? (state !== "queued" ? Date.now() : undefined);
			children.push({
				id: `${callId}:${i}`,
				label: short(plan[i]?.label ?? p?.sessionName ?? r?.sessionName ?? plan[i]?.task ?? r?.task, 60),
				state: finished && state === "queued" ? (r.exitCode === 0 ? "pass" : "fail") : state,
				startedAt,
				endedAt: state === "pass" || state === "fail" ? (prev?.children[i]?.endedAt ?? Date.now()) : undefined,
				agent: r?.agent ?? p?.agent ?? plan[i]?.agent,
				model: r?.model ?? p?.model,
				task: r?.task ?? p?.task ?? plan[i]?.task,
				tool: p?.currentTool,
				toolArgs: p?.currentToolArgs,
				tokens: p?.tokens ?? (r?.usage ? (r.usage.input ?? 0) + (r.usage.output ?? 0) : undefined),
				recentTools: (p?.recentTools as Array<{ tool: string; args: string }> | undefined)?.map((t) => `${t.tool} ${short(t.args, 80)}`),
				output: p?.recentOutput,
				finalOutput: r?.finalOutput,
				error: r?.error,
				runId: d?.runId as string | undefined,
				index: i,
				source: "foreground",
				children: [],
			});
		}
		const all = children.length ? children : [];
		if (done && !done.isError && all.some((c) => c.state === "running" || c.state === "queued")) {
			// The call returned while children still run: it was detached (async). The background snapshot owns it from here.
			foreground.delete(callId);
			scheduleRefresh();
			sync();
			return;
		}
		if (done) for (const c of all) if (c.state === "running" || c.state === "queued") (c.state = "fail"), (c.endedAt ??= Date.now());
		const state: Status = done ? (done.isError || all.some((c) => c.state === "fail") ? "fail" : "pass") : all.some((c) => c.state === "running" || c.state === "queued") || all.length === 0 ? "running" : "pass";
		foreground.set(callId, {
			id: callId,
			label: `${mode}${n > 1 ? ` ×${n}` : ""}: ${all.map((c) => c.agent).filter(Boolean).join(" → ") || short(plan[0]?.task, 40)}`,
			state,
			startedAt: prev?.startedAt ?? Date.now(),
			endedAt: done ? Date.now() : undefined,
			runId: d?.runId as string | undefined,
			source: "foreground",
			children: all,
		});
		sync();
	};

	pi.on("tool_execution_start", async (e) => {
		if (e.toolName.startsWith("subagent")) debug("start:" + e.toolName, { id: e.toolCallId, parent: e.parentToolCallId, args: e.args });
		if (e.toolName === "subagent" && !e.args?.action && e.args?.async === true) scheduleRefresh();
		else if (e.toolName === "subagent" && !e.args?.action) {
			argsById.set(e.toolCallId, e.args ?? {});
			fromDetails(e.toolCallId, e.args ?? {}, undefined);
		}
	});
	pi.on("tool_execution_update", async (e) => {
		if (e.toolName.startsWith("subagent")) debug("update:" + e.toolName, { id: e.toolCallId, partial: e.partialResult });
		if (e.toolName === "subagent" && foreground.has(e.toolCallId)) fromDetails(e.toolCallId, argsById.get(e.toolCallId) ?? e.args ?? {}, e.partialResult?.details);
	});
	pi.on("tool_execution_end", async (e) => {
		if (e.toolName.startsWith("subagent")) debug("end:" + e.toolName, { id: e.toolCallId, result: e.result, isError: e.isError });
		if (e.toolName === "subagent" && foreground.has(e.toolCallId)) fromDetails(e.toolCallId, argsById.get(e.toolCallId) ?? {}, e.result?.details, { isError: e.isError });
	});
	pi.on("input", async () => {
		foreground.clear();
		argsById.clear();
		transcripts = new Map();
		sync();
	});

	// ── background runs: pi-subagents RPC ─────────────────────────────────────────────────────────────────────────
	const rpc = (method: string, params: Record<string, unknown>) =>
		new Promise<any>((resolve) => {
			const requestId = `ui-swarm-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (r) => {
				off();
				resolve(r);
			});
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
			setTimeout(() => {
				off();
				resolve(undefined);
			}, 4000).unref?.();
		});

	const convert = (n: any, runId?: string, index?: number): Node => ({
		id: n.id,
		label: short(n.label, 60),
		state: asyncState(n.state),
		startedAt: n.startedAt,
		endedAt: n.endedAt,
		agent: n.agent,
		model: n.model,
		tool: n.activity?.currentTool,
		output: n.progressText ? [n.progressText] : undefined,
		runId: runId ?? n.id,
		index,
		sessionFile: sessionFiles.get(n.id),
		source: "async",
		children: (n.children ?? []).map((c: any, i: number) => convert(c, runId ?? n.id, i)),
	});
	const refreshAsync = async () => {
		const r = await rpc("status", {});
		const snap = r?.data?.asyncSnapshot;
		debug("snapshot", snap);
		if (snap?.runs) asyncRuns = snap.runs.map((x: any) => convert(x));
		sync();
	};
	const scheduleRefresh = () => {
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refreshAsync();
		}, 300);
		refreshTimer.unref?.();
	};
	for (const ev of ["subagent:jobs-changed", "subagent:async-started", "subagent:child-status", "subagent:async-complete"]) pi.events.on(ev, scheduleRefresh);

	const fetchTranscript = async (n: Node) => {
		if (n.source !== "async" || !n.runId || sessionFiles.has(n.id) || fetching.has(n.id)) return;
		fetching.add(n.id);
		const r = await rpc("status", { id: n.runId, index: n.index, view: "transcript", lines: 200 });
		const text = r?.data?.text;
		const file = typeof text === "string" ? /Session:\s*(\S+\.jsonl)/.exec(text)?.[1] : undefined;
		fetching.delete(n.id);
		if (file) {
			n.sessionFile = file;
			sessionFiles.set(n.id, file);
		}
	};

	// ── widget above the editor ───────────────────────────────────────────────────────────────────────────────────
	let widgetOn = false;
	let hideAt = 0;
	function sync() {
		if (!uiCtx) return;
		const active = anyRunning();
		if (active) hideAt = Date.now() + 8000;
		const show = active || Date.now() < hideAt;
		if (show && !widgetOn) {
			widgetOn = true;
			uiCtx.ui.setWidget(
				"swarm",
				((tui: any, theme: any) => ({
					invalidate() {},
					render(width: number): string[] {
						const now = Date.now();
						const list = runs();
						const kids = list.flatMap((r) => (r.children.length ? r.children : [r]));
						const running = kids.filter((k) => k.state === "running").length;
						animate(tui, running > 0 || now < hideAt);
						if (kids.length === 0) return [];
						const done = kids.filter((k) => k.state === "pass").length;
						const failed = kids.filter((k) => k.state === "fail").length;
						const head =
							theme.fg("accent", " ⚡ Подагенты ") +
							theme.fg("success", `✓${done}`) + " " +
							(failed ? theme.fg("error", `✗${failed}`) + " " : "") +
							theme.fg("dim", `из ${kids.length}`) +
							theme.fg("borderMuted", "  ·  ") +
							theme.fg("dim", `${keyLabel(KEYS.swarm[0])} — открыть панель`);
						const rows = kids.slice(0, 6).map((k, i) => {
							const last = i === Math.min(kids.length, 6) - 1 && kids.length <= 6;
							const branch = theme.fg("borderMuted", last ? " └─ " : " ├─ ");
							const name = roleName(k).padEnd(12).slice(0, 14);
							const tail =
								k.state === "running"
									? skeleton(theme, 12, now) + theme.fg("dim", ` ${k.tool ?? "думает"}`)
									: k.state === "queued"
										? theme.fg("dim", "· · · в очереди")
										: theme.fg("dim", fmtDur((k.endedAt ?? now) - (k.startedAt ?? now)));
							return branch + statusMark(theme, k.state, now) + " " + theme.fg(k.state === "fail" ? "error" : "text", name) + " " + tail;
						});
						if (kids.length > 6) rows.push(theme.fg("dim", ` … ещё ${kids.length - 6}`));
						// data-flow line: node per agent, a pulse travels along the link next to a running agent
						const flowNodes = kids.slice(0, 10);
						const flow = flowNodes.map((k, i) => {
							const node = k.state === "pass" ? theme.fg("success", "●") : k.state === "fail" ? theme.fg("error", "✗") : k.state === "running" ? statusMark(theme, "running", now) : theme.fg("dim", "○");
							if (i === flowNodes.length - 1) return node;
							const active = k.state === "running" || flowNodes[i + 1]!.state === "running";
							const seg = "─────".split("").map((ch, j) => (active && j === Math.floor(now / 110) % 5 ? theme.fg("accent", "•") : theme.fg("borderMuted", ch))).join("");
							return node + seg;
						}).join("");
						return [head, " " + flow, ...rows];
					},
				})) as never,
			);
		} else if (!show && widgetOn) {
			widgetOn = false;
			uiCtx.ui.setWidget("swarm", undefined as never);
		}
	}
	pi.on("agent_settled", async () => {
		hideAt = Date.now() + 6000;
		setTimeout(sync, 6200).unref?.();
	});

	// ── panel ─────────────────────────────────────────────────────────────────────────────────────────────────────
	const open = async (ctx: any) => {
		if (ctx.mode !== "tui") return;
		void refreshAsync();
		await ctx.ui.custom(
			(tui: any, theme: any, _kb: any, done: () => void) => {
				const dur = (n: Node) => fmtDur((n.endedAt ?? Date.now()) - (n.startedAt ?? Date.now()));
				const counts = (n: Node) => (n.children.length ? ` ${n.children.filter((c) => c.state === "pass").length}/${n.children.length}` : "");

				const nodeRow = (n: Node, depth: number, last: boolean): Row => ({
					key: n.id,
					label: `${n.agent ?? ""} ${n.label}`,
					data: n,
					render: (w) => {
						const now = Date.now();
						const indent = depth === 0 ? "" : theme.fg("borderMuted", "  ".repeat(depth - 1) + (last ? "└─ " : "├─ "));
						const name = n.agent && depth > 0 ? theme.fg("mdLink", roleName(n)) + theme.fg("dim", " · ") : "";
						const text = theme.fg(n.state === "fail" ? "error" : depth === 0 ? "accent" : "text", n.label);
						const tail =
							n.state === "running"
								? "  " + skeleton(theme, Math.max(4, Math.min(12, w - 50)), now) + theme.fg("dim", ` ${n.tool ?? ""}`)
								: n.state === "queued"
									? theme.fg("dim", "  · · ·")
									: "";
						return `${indent}${statusMark(theme, n.state, now)} ${name}${text}${theme.fg("dim", counts(n))}${tail}${n.model && depth > 0 ? theme.fg("dim", `  ${n.model.replace(/^[^/]+\//, "")}`) : ""}${theme.fg("dim", `  ${n.startedAt ? (n.state === "running" ? "⏱ " : "") + dur(n) : ""}`)}`;
					},
				});
				const tree = (nodes: Node[], depth = 0): Row[] => nodes.flatMap((n, i) => [nodeRow(n, depth, i === nodes.length - 1), ...tree(n.children, depth + 1)]);

				const leafView = (n: Node): View => ({
					title: n.agent ?? n.label,
					hint: "↑↓ прокрутка · g/G начало/конец · esc назад",
					animated: () => n.state === "running",
					followBottom: n.state === "running",
					body: () => {
						void fetchTranscript(n).then(() => tui.requestRender());
						const live = (): Node => findNode(n.id) ?? n;
						const c = live();
						const out: string[] = [
							`${statusMark(theme, c.state)} ${theme.fg(TONE[c.state], { running: "идёт", pass: "готово", fail: "ошибка", queued: "в очереди", paused: "пауза", skip: "остановлен" }[c.state])}` +
								theme.fg("dim", `  ${c.startedAt ? dur(c) : ""}  ${c.model ?? ""}  ${c.tokens ? `${fmtTokens(c.tokens)} токенов` : ""}`),
							"",
						];
						if (c.task) out.push(theme.fg("accent", "Задача"), short(c.task, 600), "");
						if (c.state === "running") out.push(theme.fg("accent", "Сейчас"), skeleton(theme, 16) + " " + (c.tool ? `${c.tool} ${short(c.toolArgs, 90)}` : "думает"), "");
						if (c.error) out.push(theme.fg("error", "Ошибка"), c.error, "");
						if (c.recentTools?.length) out.push(theme.fg("accent", "Последние инструменты"), ...c.recentTools.slice(-8).map((t) => theme.fg("dim", ` · ${t}`)), "");
						if (c.output?.length) out.push(theme.fg("accent", "Вывод"), ...c.output.slice(-12), "");
						if (c.finalOutput) out.push(theme.fg("success", "Результат"), ...c.finalOutput.split("\n"));
						const sess = readSession(c.sessionFile);
						if (sess.length) out.push("", theme.fg("accent", "Ход работы"), ...sess.slice(-80).map((l) => (l.startsWith("❯ ") ? theme.fg("mdLink", l) : l.startsWith("   ⎿") ? theme.fg("dim", l) : l)));
						return out;
					},
				});
				const findNode = (id: string): Node | undefined => {
					const walk = (ns: Node[]): Node | undefined => {
						for (const x of ns) {
							if (x.id === id) return x;
							const f = walk(x.children);
							if (f) return f;
						}
					};
					return walk(runs());
				};
				const open = (n: Node, p: Panel) => {
					if (n.children.length === 0) return p.push(leafView(n));
					p.push({
						title: short(n.label, 28),
						hint: "↑↓ выбор · enter внутрь · esc назад",
						animated: () => (findNode(n.id) ?? n).children.some((c) => c.state === "running"),
						rows: () => tree((findNode(n.id) ?? n).children, 1).map((r, i) => r),
						onSelect: (row, pp) => open(row.data as Node, pp),
					});
				};

				return new Panel(tui, theme, () => done(), {
					title: "Подагенты",
					hint: "↑↓ выбор · enter внутрь · esc закрыть",
					empty: "Подагентов пока нет. Они запускаются сами, когда в плане больше трёх подзадач.",
					animated: anyRunning,
					header: () => {
						const kids = runs().flatMap((r) => (r.children.length ? r.children : [r]));
						const c = (s: Status) => kids.filter((k) => k.state === s).length;
						return kids.length ? [` ${theme.fg("success", `✓ ${c("pass")}`)}  ${theme.fg("error", `✗ ${c("fail")}`)}  ${theme.fg("accent", `● ${c("running")}`)}  ${theme.fg("dim", `○ ${c("queued")}`)}`, ""] : [];
					},
					rows: () => tree(runs()),
					onSelect: (row, p) => open(row.data as Node, p),
				});
			},
			panelOptions("right", 52),
		);
	};

	pi.on("session_start", async (_e, ctx) => {
		uiCtx = ctx.mode === "tui" ? (ctx as never) : undefined;
		if (ctx.mode === "tui") void refreshAsync();
	});
	for (const key of KEYS.swarm) pi.registerShortcut(key as never, { description: "Панель подагентов", handler: open });
	pi.registerCommand("subagents", { description: "Панель подагентов: запуски, этапы, агенты", handler: async (_a, ctx) => open(ctx) });
}
