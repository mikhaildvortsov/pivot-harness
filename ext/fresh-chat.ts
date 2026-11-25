// Fresh chats. Automatic: once a task is finished (real work done, note saved), the next message opens a new chat that starts nearly empty: the request plus a
// pointer to the saved note (every requirement, the final report, git state) on disk, which the model reads only if the request continues that work.
// The agent starts a fresh chat for an unrelated task itself, so the old history is not re-sent (and re-billed) on every step.
// - when a new request arrives and the context is already big, the model is told it may call `new_chat`
// - `new_chat` marks a hand-off; when the turn settles the /fresh command runs (only commands may create sessions); /fresh opens a new session seeded with
//   the user's request and a short hand-off written by the model, then runs it there.
// - hand-off note: when a run that did real work settles, a note is written WITHOUT the model (git state + the run's final report); the first prompt
//   of a new chat in the same project (< 48 h) gets it injected, so work can be picked up after a pause (e.g. the reply of a second developer). The note carries all user messages (the requirements), so nothing stated is lost.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

const NUDGE_TOKENS = 30_000;
const AUTO_TOKENS = 25_000; // a request/system prompt/tool schemas alone are ~21k, so this means "a real conversation has built up"; must stay below the 50k compaction trigger (window 200k - reserve 150k)
const SHORT_WORDS = 15; // shorter messages ("да", "поправь это", "продолжай") are follow-ups: they stay in the chat
const NOTE_DIR = join(homedir(), ".pi", "agent", "state", "handoff");
const NOTE_MAX_AGE_MS = 48 * 3600_000;
const MIN_TOOL_CALLS = 4;
const REQ_BUDGET = 9_000;
const NOTE_MAX = 14_000;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	let request = "";
	let pending: { prompt: string; handoff: string; sent?: boolean } | undefined;
	let toolCalls = 0;
	let work: string | undefined;
	let noteSaved = false; // the last settled run of THIS chat left a note
	pi.on("task:classified" as never, ((c: { kind?: string; summary?: string }) => {
		if (c.kind && c.kind !== "question") work = c.summary;
	}) as never);
	pi.on("tool_execution_end", async () => void toolCalls++);

	/** One note per project: the main checkout, so every worktree of it shares it. */
	const noteFile = async (cwd: string) => {
		const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 10_000 });
		const root = common.code === 0 ? dirname(common.stdout.trim()) : cwd;
		return join(NOTE_DIR, `${createHash("sha1").update(root).digest("hex").slice(0, 10)}.md`);
	};
	const git = async (cwd: string, ...args: string[]) => (await pi.exec("git", args, { cwd, timeout: 10_000 })).stdout.trim();
	const lastReport = (branch: readonly unknown[]) => {
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
			if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
			const text = (e.message.content as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
			if (text.length > 80) return text;
		}
		return "";
	};
	/** Every user message of the chat, verbatim (the requirements live there). Long ones are cut from the middle only when the budget runs out. */
	const requirements = (branch: readonly unknown[]) => {
		const msgs: string[] = [];
		for (const raw of branch) {
			const e = raw as { type?: string; message?: { role?: string; content?: unknown } };
			if (e.type !== "message" || e.message?.role !== "user") continue;
			const c = e.message.content;
			const text = (typeof c === "string" ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") : "").trim();
			if (text && !text.startsWith("/")) msgs.push(text);
		}
		let budget = REQ_BUDGET;
		const out = msgs.map((m, i) => {
			const left = msgs.length - i;
			const share = i === msgs.length - 1 || i === 0 ? Math.min(m.length, Math.max(3500, budget / left)) : Math.min(m.length, Math.max(500, budget / left));
			budget -= Math.min(m.length, share);
			if (m.length <= share) return `#${i + 1}: ${m}`;
			const half = Math.floor(share / 2);
			return `#${i + 1}: ${m.slice(0, half)}\n[... ${m.length - share} chars cut ...]\n${m.slice(-half)}`;
		});
		return out.join("\n\n");
	};
	const saveNote = async (ctx: { cwd: string; sessionManager: { getBranch(): readonly unknown[] } }) => {
		if (toolCalls < MIN_TOOL_CALLS && !work) return;
		const report = lastReport(ctx.sessionManager.getBranch());
		if (!report) return;
		const [branch, worktrees, commits, dirty] = await Promise.all([
			git(ctx.cwd, "branch", "--show-current"),
			git(ctx.cwd, "worktree", "list"),
			git(ctx.cwd, "log", "-3", "--format=%h %s"),
			git(ctx.cwd, "status", "--short"),
		]);
		const body = [
			`saved: ${new Date().toISOString()}`,
			`cwd: ${ctx.cwd}`,
			`branch: ${branch || "(detached)"}`,
			work ? `task: ${work}` : "",
			`REQUIREMENTS: every user message of this chat, verbatim, oldest first (later ones refine or override earlier ones):\n${requirements(ctx.sessionManager.getBranch())}`,
			`final report of the last run:\n${report.slice(0, 2200)}`,
			commits ? `last commits:\n${commits}` : "",
			dirty ? `uncommitted: ${dirty.split("\n").length} file(s)` : "",
			worktrees ? `worktrees (first 8):\n${worktrees.split("\n").slice(0, 8).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n");
		try {
			mkdirSync(NOTE_DIR, { recursive: true });
			writeFileSync(await noteFile(ctx.cwd), body.slice(0, NOTE_MAX));
			noteSaved = true;
		} catch {
			/* best effort */
		}
	};

	pi.on("session_start", async () => {
		noteSaved = false;
	});

	// Automatic fresh chat: the previous task is finished (its note is saved, with every requirement) and the chat is big, so the next typed message moves to
	// a new chat that starts from that note instead of re-sending ~40k+ tokens on every step. The old chat stays on disk (/resume).
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || event.streamingBehavior || event.images?.length || pending || !noteSaved) return;
		const text = event.text.trim();
		if (!text || /^[\/!]/.test(text) || text.includes("[Hand-off from the previous chat]")) return;
		if (text.split(/\s+/).length < SHORT_WORDS) return;
		const used = ctx.getContextUsage()?.tokens ?? 0;
		if (used < AUTO_TOKENS) return;
		const file = await noteFile(ctx.cwd);
		let note = "";
		try {
			note = readFileSync(file, "utf8");
		} catch {
			return;
		}
		const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(note)?.[1] ?? "";
		pending = {
			prompt: event.text,
			handoff:
				`(automatic hand-off) The previous task finished in the old chat (~${Math.round(used / 1000)}k tokens) and this chat starts clean. ` +
				`Its full note (every requirement the user stated, the final report, branch, commits) is saved in ${file}. ` +
				"If this request continues that work (a reply to the report or to a question in it, a fix, \"продолжай\", the same branch or PR), read that file first; if the request is unrelated, ignore it.\n" +
				[field("task") && `previous task: ${field("task")}`, field("branch") && `branch: ${field("branch")}`].filter(Boolean).join("\n"),
		};
		noteSaved = false;
		ctx.ui.notify(`Задача завершена: следующий запрос начинается в чистом чате (было ${Math.round(used / 1000)}k токенов). Заметка с требованиями и отчётом на диске, старый чат: /resume`, "info");
		setTimeout(() => pi.sendUserMessage("/fresh", { expandPromptTemplates: true }), 0);
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		toolCalls = 0;
		work = undefined;
		request = event.prompt;
		// first prompt of a chat with no assistant history yet: pick up the project's recent hand-off note
		const fresh = !ctx.sessionManager.getBranch().some((e) => (e as { type?: string; message?: { role?: string } }).type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant");
		if (fresh && !event.prompt.includes("[Hand-off from the previous chat]")) {
			const file = await noteFile(ctx.cwd);
			if (existsSync(file) && Date.now() - statSync(file).mtimeMs < NOTE_MAX_AGE_MS) {
				ctx.ui.notify("Подтянута заметка о прошлой работе по проекту", "info");
				return {
					message: {
						customType: "handoff-note",
						display: false,
						content:
							"[handoff] Notes from the previous chat on this project (saved automatically, state may have moved on: verify branch/PR status before acting). " +
							"If the user's request continues that work (for example a reply to it), pick up from here; if it is unrelated, ignore it.\n\n" +
							readFileSync(file, "utf8"),
					},
				};
			}
		}
		const used = ctx.getContextUsage()?.tokens ?? 0;
		if (used < NUDGE_TOKENS) return;
		return {
			message: {
				customType: "fresh-chat",
				display: false,
				content:
					`[context] This chat already holds ~${Math.round(used / 1000)}k tokens that are re-sent on every step. If the new request is unrelated to the earlier work ` +
					"(different feature, repo area or question), call new_chat first with a short hand-off; if it continues the same work, ignore this.",
			},
		};
	});

	pi.registerTool({
		name: "new_chat",
		label: "New chat",
		description:
			"Start a fresh chat for the current request when it is unrelated to the earlier conversation, to stop re-sending old context. Pass only facts the new chat needs (branch, PR, decisions, paths). Not for continuing the same task.",
		parameters: Type.Object({
			handoff: Type.String({ description: "max 12 lines: branch/PR, decisions already taken, files that matter, what is still open" }),
		}),
		async execute(_id, params) {
			pending = { prompt: request, handoff: (params as { handoff: string }).handoff.slice(0, 2000) };
			return { content: [{ type: "text", text: "A fresh chat opens right after this step and continues the request there. Do nothing else in this chat." }], details: {} };
		},
	});

	// the command runs once this turn has ended, so the session is not replaced under a running tool call
	pi.on("agent_settled", async (e, ctx) => {
		if (pending) {
			// one attempt only: if the command did not run, drop the hand-off instead of re-sending "/fresh" after every run
			if (pending.sent) pending = undefined;
			else {
				pending.sent = true;
				pi.sendUserMessage("/fresh", { expandPromptTemplates: true });
			}
			return;
		}
		if (!e.aborted) await saveNote(ctx);
	});

	pi.registerCommand("fresh", {
		description: "Новый чат с переносом текущего запроса (для агента)",
		handler: async (_args, ctx) => {
			const job = pending;
			pending = undefined;
			if (!job?.prompt) return void ctx.ui.notify("Нечего переносить: используйте /new", "info");
			await ctx.newSession({
				withSession: async (next) => {
					await next.sendUserMessage(`${job.prompt}\n\n[Hand-off from the previous chat]\n${job.handoff}`);
				},
			});
		},
	});
}
