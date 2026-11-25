// The agent starts a fresh chat for an unrelated task itself, so the old history is not re-sent (and re-billed) on every step.
// - when a new request arrives and the context is already big, the model is told it may call `new_chat`
// - `new_chat` marks a hand-off; when the turn settles the /fresh command runs (only commands may create sessions); /fresh opens a new session seeded with
//   the user's request and a short hand-off written by the model, then runs it there.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NUDGE_TOKENS = 30_000;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	let request = "";
	let pending: { prompt: string; handoff: string } | undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		request = event.prompt;
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
	pi.on("agent_settled", async () => {
		if (pending) pi.sendUserMessage("/fresh");
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
