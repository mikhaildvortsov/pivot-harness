// The agent starts a fresh chat for an unrelated task itself, so the old history is not re-sent (and re-billed) on every step.
// - when a new request arrives and the context is already big, the model is told it may call `new_chat`
// - `new_chat` marks a hand-off; when the turn settles the /fresh command runs (only commands may create sessions); /fresh opens a new session seeded with
//   the user's request and a short hand-off written by the model, then runs it there.
// - hand-off note: when a run that did real work settles, a note is written WITHOUT the model (git state + the run's final report); the first prompt
//   of a new chat in the same project (< 48 h) gets it injected, so work can be picked up after a pause (e.g. the reply of a second developer).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

const NUDGE_TOKENS = 30_000;
const NOTE_DIR = join(homedir(), ".pi", "agent", "state", "handoff");
const NOTE_MAX_AGE_MS = 48 * 3600_000;
const MIN_TOOL_CALLS = 4;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	let request = "";
	let pending: { prompt: string; handoff: string } | undefined;
	let toolCalls = 0;
	let work: string | undefined;
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
			`final report of the last run:\n${report.slice(0, 2200)}`,
			commits ? `last commits:\n${commits}` : "",
			dirty ? `uncommitted: ${dirty.split("\n").length} file(s)` : "",
			worktrees ? `worktrees (first 8):\n${worktrees.split("\n").slice(0, 8).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n");
		try {
			mkdirSync(NOTE_DIR, { recursive: true });
			writeFileSync(await noteFile(ctx.cwd), body.slice(0, 3500));
		} catch {
			/* best effort */
		}
	};

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
		if (pending) return void pi.sendUserMessage("/fresh");
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
