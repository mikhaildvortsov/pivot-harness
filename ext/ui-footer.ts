// Footer: tokens, task/session cost, NanoGPT balance, colored provider-health lights, routed model, context meter.
// Data comes from the session branch (usage), pi.events (provider:down, nanogpt:balance) and subagent RPC cost.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { animate, blend, fmtMoney, fmtTokens, meter, pulse, rightAlign, spinnerFrame, type Tone } from "./lib/ui-kit.ts";

type Light = { name: string; match: (p: string) => boolean };
const LIGHTS: Light[] = [
	{ name: "Runware", match: (p) => p === "nanogpt-runware" },
	{ name: "NanoGPT", match: (p) => p === "nanogpt" },
	{ name: "Gonka", match: (p) => p === "gonka" },
	{ name: "Anthropic", match: (p) => p === "anthropic" },
];

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR_RUN === "1") return;

	// Provider health from active checks (so the lights mean something before the first request): name → ok | warn | down.
	const probe = new Map<string, "ok" | "warn" | "down">();
	let balance: { usd: number; level: "ok" | "low" | "empty" } | undefined;
	const lastOk = new Map<string, number>(); // provider → ts of last good response
	const lastErr = new Map<string, number>(); // provider → ts of last failed response
	const downUntil = new Map<string, number>(); // provider family → ts
	let taskStartIdx = 0;
	let childCost = 0;
	let childTokens = 0;
	let diskCost = 0;
	let diskTokens = 0;
	let diskAt = 0;
	const childFiles = new Map<string, { size: number; cost: number; tokens: number }>();
	/** Foreground and async subagents write their own sessions to <session>/<run>/run-N/session.jsonl; the session totals miss them. */
	const scanChildren = (sessionFile: string | undefined) => {
		if (!sessionFile || Date.now() - diskAt < 4000) return;
		diskAt = Date.now();
		try {
			const root = sessionFile.replace(/\.jsonl$/, "");
			if (!existsSync(root)) return;
			for (const run of readdirSync(root)) {
				const runDir = join(root, run);
				if (!statSync(runDir).isDirectory()) continue;
				for (const sub of readdirSync(runDir)) {
					const f = join(runDir, sub, "session.jsonl");
					if (!existsSync(f)) continue;
					const size = statSync(f).size;
					if (childFiles.get(f)?.size === size) continue;
					let cost = 0;
					let tokens = 0;
					for (const line of readFileSync(f, "utf8").split("\n")) {
						if (!line.includes('"usage"')) continue;
						try {
							const u = JSON.parse(line).message?.usage;
							cost += u?.cost?.total ?? 0;
							tokens += (u?.input ?? 0) + (u?.output ?? 0);
						} catch {
							/* partial line */
						}
					}
					childFiles.set(f, { size, cost, tokens });
				}
			}
			diskCost = [...childFiles.values()].reduce((a, c) => a + c.cost, 0);
			diskTokens = [...childFiles.values()].reduce((a, c) => a + c.tokens, 0);
		} catch {
			/* best effort */
		}
	};

	pi.events.on("nanogpt:balance", (d) => {
		balance = d as typeof balance;
		const s = balance?.level === "empty" ? "down" : balance?.level === "low" ? "warn" : "ok";
		probe.set("NanoGPT", s);
		probe.set("Runware", s);
	});
	pi.events.on("provider:down", (d) => {
		const x = d as { provider?: string; ms?: number };
		if (!x.provider) return;
		downUntil.set(x.provider, Date.now() + (x.ms ?? 3_600_000));
		if (x.provider === "nanogpt") downUntil.set("nanogpt-runware", Date.now() + (x.ms ?? 3_600_000));
	});
	pi.on("message_end", async (e) => {
		const m = e.message as Partial<AssistantMessage>;
		if (m.role !== "assistant" || !m.provider) return;
		(m.stopReason === "error" ? lastErr : lastOk).set(m.provider, Date.now());
	});
	// tokens/s sparkline: sampled twice a second from the growing assistant message while the agent works
	let chars = 0, lastChars = 0, sampler: ReturnType<typeof setInterval> | undefined, lastSample = 0;
	const samples: number[] = [];
	pi.on("message_update", async (e) => {
		const m = e.message as { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> };
		if (m.role !== "assistant") return;
		chars = (m.content ?? []).reduce((n, p) => n + (p.type === "text" ? (p.text?.length ?? 0) : p.type === "thinking" ? (p.thinking?.length ?? 0) : 0), 0);
	});
	pi.on("agent_start", async () => {
		samples.length = 0;
		chars = lastChars = 0;
		clearInterval(sampler);
		sampler = setInterval(() => {
			samples.push(Math.max(0, (chars - lastChars) / 4 / 0.5));
			lastChars = chars < lastChars ? 0 : chars;
			if (samples.length > 24) samples.shift();
			lastSample = Date.now();
		}, 500);
		sampler.unref?.();
	});
	pi.on("agent_settled", async () => {
		clearInterval(sampler);
		sampler = undefined;
		lastSample = Date.now();
	});
	const spark = (theme: Theme) => {
		if (samples.length < 3 || Date.now() - lastSample > 15_000) return "";
		const max = Math.max(20, ...samples);
		const bars = "▁▂▃▄▅▆▇█";
		const line = samples.map((v, i) => theme.fg(i === samples.length - 1 ? "accent" : "mdLink", bars[Math.min(7, Math.floor((v / max) * 7.99))]!)).join("");
		return `${line}${theme.fg("dim", ` ${Math.round(samples[samples.length - 1]!)} ток/с`)}`;
	};

	let taskKidBase = 0;
	pi.on("input", async (_e, ctx) => {
		taskStartIdx = ctx.sessionManager.getBranch().length;
		taskKidBase = Math.max(childCost, diskCost);
	});

	// Async subagent usage is not part of the session totals; refresh it from the subagent RPC after each settle.
	pi.on("agent_settled", async () => {
		const requestId = `ui-cost-${Date.now()}`;
		const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (r) => {
			off();
			const d = (r as { success?: boolean; data?: { childTotal?: { cost?: number; input?: number; output?: number } } }).data;
			childCost = d?.childTotal?.cost ?? childCost;
			childTokens = (d?.childTotal?.input ?? 0) + (d?.childTotal?.output ?? 0) || childTokens;
		});
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "cost", params: {} });
		setTimeout(off, 3000).unref?.();
	});

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		childCost = 0;
		childTokens = 0;
		diskCost = diskTokens = diskAt = taskKidBase = 0;
		childFiles.clear();
		taskStartIdx = ctx.sessionManager.getBranch().length;
		let cacheKey = "";
		let sums = { tIn: 0, tOut: 0, tCache: 0, tCost: 0, sCost: 0 };

		const compute = () => {
			const branch = ctx.sessionManager.getBranch();
			const key = `${ctx.sessionManager.getLeafId()}:${branch.length}:${taskStartIdx}`;
			if (key === cacheKey) return sums;
			cacheKey = key;
			sums = { tIn: 0, tOut: 0, tCache: 0, tCost: 0, sCost: 0 };
			branch.forEach((entry, i) => {
				if (entry.type !== "message" || entry.message.role !== "assistant") return;
				const u = (entry.message as AssistantMessage).usage;
				if (!u) return;
				sums.sCost += u.cost?.total ?? 0;
				if (i >= taskStartIdx) {
					sums.tIn += u.input;
					sums.tOut += u.output;
					sums.tCache += u.cacheRead;
					sums.tCost += u.cost?.total ?? 0;
				}
			});
			return sums;
		};

		const probeAll = async () => {
			// Anthropic: subscription credentials configured?
			const opus = ctx.modelRegistry.find("anthropic", "claude-opus-5-5");
			probe.set("Anthropic", opus && ctx.modelRegistry.hasConfiguredAuth(opus) ? "ok" : "down");
			// Gonka: gateway reachable and the key accepted?
			const gk = ctx.modelRegistry.find("gonka", "zai-org/GLM-5.3-Flash");
			const key = process.env.GONKA_API_KEY;
			if (!gk || !key) probe.delete("Gonka");
			else {
				try {
					const r = await fetch(`${gk.baseUrl.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
					probe.set("Gonka", r.status === 401 || r.status === 403 ? "down" : r.status >= 500 ? "warn" : "ok");
				} catch {
					probe.set("Gonka", "warn");
				}
			}
		};
		setTimeout(() => void probeAll(), 3500).unref?.(); // after the intro: network work competes with the animation
		const probeTimer = setInterval(() => void probeAll(), 5 * 60_000);
		probeTimer.unref?.();

		ctx.ui.setFooter((tui, theme, data) => {
			const off = data.onBranchChange(() => tui.requestRender());
			const refresh = setInterval(() => tui.requestRender(), 5000);
			refresh.unref?.();
			return {
				dispose() {
					off();
					clearInterval(refresh);
				},
				invalidate() {},
				render(width: number): string[] {
					if ((globalThis as { __pivotSplash?: { visible: boolean } }).__pivotSplash?.visible) return [];
					const now = Date.now();
					const busy = !ctx.isIdle();
					animate(tui, busy);
					const s = compute();
					const sep = theme.fg("borderMuted", " │ ");

					// Row 1: branch · model → routed · context meter                       provider lights
					const branch = data.getGitBranch();
					const usage = ctx.getContextUsage();
					const pct = usage?.percent ?? 0;
					const tone: Tone = pct > 85 ? "error" : pct > 65 ? "warning" : "success";
					const lastAssistant = [...ctx.sessionManager.getBranch()].reverse().find((e) => e.type === "message" && e.message.role === "assistant");
					const lastMsg = lastAssistant && lastAssistant.type === "message" ? (lastAssistant.message as AssistantMessage) : undefined;
					const tag = ({ "nanogpt-runware": "RW", nanogpt: "NG", gonka: "GK", anthropic: "AN" } as Record<string, string>)[lastMsg?.provider ?? ""];
					const routed = lastMsg?.model ? `${lastMsg.model}${tag ? ` @${tag}` : ""}` : undefined;
					const sel = (ctx.model?.id ?? "—").replace(/^.*\//, "");
					const modelId = routed && ctx.model?.provider === "router" ? `${sel} → ${routed.replace(/^.*\//, "")}` : sel;
					const left1 =
						(busy ? pulse(theme, now, spinnerFrame(now)) : theme.fg("success", "●")) +
						" " +
						(branch && !/^(detached|HEAD)$/i.test(branch) ? theme.fg("mdLink", `⎇ ${branch}`) + sep : "") +
						theme.fg("accent", modelId) +
						// context fill is shown only when it matters (the model's window is getting full)
						(pct >= 60 ? sep + meter(theme, pct / 100, 8, tone) + theme.fg(tone === "error" ? "error" : "warning", ` контекст ${Math.round(pct)}%`) : "");
					const lights = LIGHTS.map((l) => {
						const provs = [...new Set([...lastOk.keys(), ...lastErr.keys(), ...downUntil.keys()])].filter(l.match);
						const down = provs.some((p) => (downUntil.get(p) ?? 0) > now);
						const ok = Math.max(0, ...provs.map((p) => lastOk.get(p) ?? 0));
						const err = Math.max(0, ...provs.map((p) => lastErr.get(p) ?? 0));
						const probed = probe.get(l.name);
						const key =
							(l.name === "Runware" || l.name === "NanoGPT") && balance?.level === "empty" ? "error"
							: down || probed === "down" ? "error"
							: (err > ok && now - err < 600_000) || probed === "warn" ? "warning"
							: ok || probed === "ok" ? "success"
							: "dim";
						return theme.fg(key, "●") + theme.fg("dim", ` ${l.name}`);
					}).join("  ");
					const row1 = rightAlign(left1, lights, width);

					// Row 2: tokens · cost · balance · statuses
					const tokens =
						theme.fg("dim", "↑") + theme.fg("text", fmtTokens(s.tIn + s.tCache)) + " " +
						theme.fg("dim", "↓") + theme.fg("text", fmtTokens(s.tOut));
					scanChildren(ctx.sessionManager.getSessionFile());
					const kidCost = Math.max(childCost, diskCost);
					const kidTok = Math.max(childTokens, diskTokens);
					const subTok = kidTok > 0 ? theme.fg("dim", ` +подагенты ${fmtTokens(kidTok)}`) : "";
					const cost = theme.fg("dim", "задача ") + theme.fg("warning", fmtMoney(s.tCost + Math.max(0, kidCost - taskKidBase))) + theme.fg("dim", "  сессия ") + theme.fg("warning", fmtMoney(s.sCost + kidCost));
					const bal = balance
						? theme.fg("dim", "NanoGPT ") + theme.fg(balance.level === "ok" ? "success" : balance.level === "low" ? "warning" : "error", `$${balance.usd.toFixed(2)}`)
						: theme.fg("dim", "NanoGPT —");
					const statuses = [...data.getExtensionStatuses().values()].filter(Boolean).join("  ");
					const sp = spark(theme);
					const left2 = tokens + subTok + (sp ? "  " + sp : "") + sep + cost + sep + bal;
					const row2 = statuses ? rightAlign(left2, theme.fg("dim", statuses), width) : truncateToWidth(left2, width, "…");
					return [row1, row2];
				},
			};
		});
	});
}
