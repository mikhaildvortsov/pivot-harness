// Task journal: one JSON line per user request in ~/.pi/agent/journal/journal.jsonl.
// Records what the harness did, not what you typed in full: prompt snippet, classification (and whether Sonnet corrected it),
// models used, tokens, real cost (from models.json prices), duration, errors/retries, gate activity (auto-verify, critic,
// Opus review verdict, blocks by guards), subagent calls, PR links, git change size, outcome.
// /problem <text> adds a note to the last task, /journal [n] shows the last tasks. Hand the journal to Claude to fix problems.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { piPackage } from "./lib/pi-package.ts";

const DIR = join(homedir(), ".pi", "agent", "journal");
const FILE = join(DIR, "journal.jsonl");
const BLOCK_PREFIXES = ["anti-laziness", "swarm-gate", "git-guard", "config-guard", "task-classifier", "subagent-skills", "opus-director", "BLOCKED by CC Safety Net"];
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

type Task = {
	type: "task";
	id: string;
	ts: string;
	t0: number;
	prompt: string;
	repo: string;
	piVersion?: string;
	class?: Record<string, unknown>;
	models: Record<string, number>;
	tokens: { input: number; cacheRead: number; output: number };
	costUsd: number;
	errors: string[];
	tools: Record<string, number>;
	blocks: Record<string, number>;
	gates: { autoVerify: number; critic: number; opusReview?: string; shipRequested: boolean };
	subagentCalls: number;
	events: string[];
	pr?: string;
};

const append = (obj: unknown) => {
	mkdirSync(DIR, { recursive: true });
	appendFileSync(FILE, `${JSON.stringify(obj)}\n`);
};
const text = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("\n") : "";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_WATCHDOG_MAINTAINER === "1" || process.env.PI_JOURNAL === "off") return;
	let cur: Task | undefined;
	let lastTaskId = "";
	const version = piPackage()?.version;

	const start = (prompt: string, cwd: string) => {
		cur = {
			type: "task", id: randomUUID().slice(0, 8), ts: new Date().toISOString(), t0: Date.now(), prompt: prompt.replace(/\s+/g, " ").slice(0, 200),
			repo: basename(cwd), piVersion: version, models: {}, tokens: { input: 0, cacheRead: 0, output: 0 }, costUsd: 0, errors: [], tools: {}, blocks: {},
			gates: { autoVerify: 0, critic: 0, shipRequested: false }, subagentCalls: 0, events: [],
		};
	};

	const finish = async (outcome: string, cwd: string) => {
		if (!cur) return;
		const t = cur;
		cur = undefined;
		let git: Record<string, unknown> = {};
		try {
			const top = (await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 })).stdout.trim();
			if (top) {
				const branch = (await pi.exec("git", ["branch", "--show-current"], { cwd: top, timeout: 5_000 })).stdout.trim();
				const dirty = (await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: top, timeout: 10_000 })).stdout.split("\n").filter(Boolean).length;
				const stat = (await pi.exec("git", ["diff", "--shortstat", "HEAD"], { cwd: top, timeout: 10_000 })).stdout.trim();
				git = { branch, dirtyFiles: dirty, diffStat: stat };
			}
		} catch {
			/* not a git repo or git unavailable */
		}
		const { t0, ...rest } = t;
		append({ ...rest, outcome, durationS: Math.round((Date.now() - t0) / 1000), costUsd: Number(t.costUsd.toFixed(5)), git });
		lastTaskId = t.id;
	};

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		if (cur) await finish("interrupted", ctx.cwd);
		start(event.text, ctx.cwd);
	});

	pi.events.on("task:classified", (data) => {
		if (cur) cur.class = data as Record<string, unknown>;
	});
	pi.events.on("provider:down", (data) => {
		if (cur) cur.events.push(`provider-down:${(data as { provider?: string }).provider}`);
	});

	pi.on("message_end", async (event) => {
		if (!cur) return;
		const m = event.message as { role?: string; provider?: string; model?: string; usage?: { input?: number; cacheRead?: number; output?: number; cost?: { total?: number } }; errorMessage?: string; customType?: string; content?: unknown; toolName?: string };
		if (m.role === "assistant") {
			const key = `${m.provider}/${(m.model ?? "").split("/").slice(-1)[0]}`;
			cur.models[key] = (cur.models[key] ?? 0) + 1;
			cur.tokens.input += m.usage?.input ?? 0;
			cur.tokens.cacheRead += m.usage?.cacheRead ?? 0;
			cur.tokens.output += m.usage?.output ?? 0;
			cur.costUsd += m.usage?.cost?.total ?? 0;
			if (m.errorMessage && cur.errors.length < 10) cur.errors.push(`${key}: ${m.errorMessage.replace(/\s+/g, " ").slice(0, 140)}`);
		} else if (m.role === "toolResult") {
			const body = text(m.content);
			const name = m.toolName ?? "tool";
			cur.tools[name] = (cur.tools[name] ?? 0) + 1;
			if (name === "subagent") cur.subagentCalls++;
			const blocked = BLOCK_PREFIXES.find((p) => body.trimStart().startsWith(p) || body.includes(`${p}:`));
			if (blocked) cur.blocks[blocked] = (cur.blocks[blocked] ?? 0) + 1;
			const pr = body.match(PR_URL)?.[0];
			if (pr) cur.pr = pr;
		} else if (m.role === "custom") {
			const body = text(m.content);
			if (m.customType === "auto-verify") cur.gates.autoVerify++;
			else if (m.customType === "flow-skills" && body.includes("[critic")) cur.gates.critic++;
			else if (m.customType === "opus-review") cur.gates.opusReview = body.match(/VERDICT:\s*(PASS|NEEDS_FIX)/i)?.[1]?.toUpperCase() ?? (body.includes("не выполнено") ? "unavailable" : "unknown");
			else if (m.customType === "ship-gate") cur.gates.shipRequested = true;
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!cur) return;
		const failed = cur.errors.length > 0 && Object.keys(cur.models).length === 0;
		await finish(event.aborted ? "aborted" : failed ? "error" : "completed", ctx.cwd);
	});

	pi.registerCommand("problem", {
		description: "Записать проблему в журнал харнеса: /problem что пошло не так",
		handler: async (args, ctx) => {
			const note = (args ?? "").trim();
			if (!note) return ctx.ui.notify("Использование: /problem <что пошло не так>", "warning");
			append({ type: "problem", ts: new Date().toISOString(), task: cur?.id ?? lastTaskId, repo: basename(ctx.cwd), piVersion: version, note });
			ctx.ui.notify(`Записано в журнал (${FILE.replace(homedir(), "~")})`, "info");
		},
	});

	pi.registerCommand("journal", {
		description: "Последние задачи из журнала: /journal [сколько]",
		handler: async (args, ctx) => {
			if (!existsSync(FILE)) return ctx.ui.notify("Журнал пока пуст", "info");
			const n = Math.min(Number.parseInt(args ?? "", 10) || 8, 30);
			const rows = readFileSync(FILE, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l));
			const line = (r: any) =>
				r.type === "problem"
					? `! ${r.ts.slice(5, 16)} проблема: ${r.note}`
					: `${r.ts.slice(5, 16)} ${r.outcome} ${r.durationS}s $${r.costUsd} ${r.class?.kind ?? "?"} ${Object.keys(r.models).map((k) => k.split("/").pop()).join("+")} | ${r.prompt.slice(0, 50)}`;
			ctx.ui.notify(rows.map(line).join("\n"), "info");
		},
	});
}
