// When the Anthropic quota ends (or its API is blocked), the session moves to OpenAI GPT-6.1 Sol with high reasoning and carries on with the task.
// Only Anthropic failures trigger it, so a failing fallback never loops. The old model stays selectable in /model; switch back when the quota resets.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicUnavailable, FALLBACK } from "./lib/fallback.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	let hit = "";
	pi.on("message_end", async (e) => {
		const m = e.message as { role?: string; provider?: string; stopReason?: string; errorMessage?: string };
		if (m.role === "assistant" && m.provider === "anthropic" && m.stopReason === "error" && anthropicUnavailable(m.errorMessage)) hit = m.errorMessage ?? "limit";
	});
	pi.on("agent_settled", async (_e, ctx) => {
		if (!hit) return;
		const why = hit.slice(0, 160);
		hit = "";
		const model = ctx.modelRegistry.find(FALLBACK.provider, FALLBACK.id);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(`Anthropic недоступен (${why}), а ${FALLBACK.label} не настроен. Выполните в терминале: pi auth login ${FALLBACK.provider} --api-key`, "error");
			return;
		}
		if (!(await pi.setModel(model))) return;
		pi.setThinkingLevel(FALLBACK.thinking);
		ctx.ui.notify(`Anthropic недоступен (${why}): перешёл на ${FALLBACK.label}, размышления ${FALLBACK.thinking}`, "warning");
		await pi.sendMessage(
			{ customType: "quota-fallback", display: true, content: `[quota-fallback] The previous model (Anthropic) stopped on its usage limit or an access block: "${why}". You are now ${FALLBACK.label}. Continue the user's task from where it stopped; do not start over.` },
			{ triggerTurn: true },
		);
	});
}
