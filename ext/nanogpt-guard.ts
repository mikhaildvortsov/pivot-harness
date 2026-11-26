// NanoGPT provider wrapper + balance monitor.
// 1. Auth/billing rejections (401/402/403, invalid key, insufficient balance) are rewritten as "provider overloaded" errors:
//    pi only auto-retries overloaded/5xx/429-style errors, and the retry lets router.ts move to the Gonka reserve.
//    The provider is reported down via pi.events "provider:down" so the router benches it for an hour.
// 2. The balance is checked at start and every BALANCE_CHECK_MS; low balance is announced, an empty one benches NanoGPT.
// models.json sets provider nanogpt to api "nanogpt-guard"; this file registers that api.
import type { AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import * as compat from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompletionsStream } from "./stream-watchdog.ts";

const PROVIDER = "nanogpt";
const PROVIDERS = [PROVIDER, "nanogpt-runware"]; // Runware-pinned copy shares the account and the same failure handling
const AUTH_OR_BILLING = /\b(401|402|403)\b|invalid[_ ]api[_ ]key|invalid session|unauthori[sz]ed|forbidden|insufficient|balance|payment required/i;
const DOWN_MS = 60 * 60_000;
const BALANCE_URL = "https://nano-gpt.com/api/check-balance";
const BALANCE_CHECK_MS = 30 * 60_000;
const LOW_USD = 0.5;
const EMPTY_USD = 0.02;

type StreamSimple = (model: never, context: never, options?: never) => AsyncIterable<AssistantMessageEvent>;

export default function (pi: ExtensionAPI) {
	const inner = resolveCompletionsStream() as StreamSimple | undefined;
	const createStream = (compat as Record<string, unknown>).createAssistantMessageEventStream as undefined | (() => ReturnType<typeof compat.createAssistantMessageEventStream>);

	for (const name of PROVIDERS)
	pi.registerProvider(name, {
		api: "nanogpt-guard",
		streamSimple(model, context, options) {
			if (!inner || !createStream) throw new Error("nanogpt-guard: openai-completions stream not found (watchdog-maintainer repairs stream-watchdog.ts)");
			const out = createStream();
			(async () => {
				try {
					for await (const event of inner({ ...model, api: "openai-completions" } as never, context as never, options as never)) {
						if (event.type === "error" && AUTH_OR_BILLING.test(event.error.errorMessage ?? "")) {
							pi.events.emit("provider:down", { provider: PROVIDER, ms: DOWN_MS });
							const original = (event.error.errorMessage ?? "").slice(0, 200);
							out.push({
								...event,
								error: { ...event.error, errorMessage: `provider overloaded: NanoGPT rejected the request (${original}); switching to the reserve provider` },
							});
							continue;
						}
						out.push(event);
					}
				} finally {
					out.end();
				}
			})();
			return out;
		},
	});

	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1") return;
	let lastCheck = 0;
	let announced: "ok" | "low" | "empty" = "ok";
	const check = async (notify: (msg: string, level: "info" | "warning" | "error") => void, minGapMs = BALANCE_CHECK_MS) => {
		const key = process.env.NANOGPT_API_KEY;
		if (!key || Date.now() - lastCheck < minGapMs) return;
		lastCheck = Date.now();
		try {
			const res = await fetch(BALANCE_URL, { method: "POST", headers: { "x-api-key": key }, signal: AbortSignal.timeout(8_000) });
			const usd = Number((await res.json() as { usd_balance?: string }).usd_balance);
			if (!Number.isFinite(usd)) return;
			const level = usd < EMPTY_USD ? "empty" : usd < LOW_USD ? "low" : "ok";
			pi.events.emit("nanogpt:balance", { usd, level });
			if (level === "empty") pi.events.emit("provider:down", { provider: PROVIDER, ms: DOWN_MS });
			if (level !== announced) {
				if (level === "empty") notify(`NanoGPT: баланс $${usd.toFixed(2)} — работа идёт на резерве (Gonka). Пополни баланс.`, "error");
				else if (level === "low") notify(`NanoGPT: баланс низкий — $${usd.toFixed(2)}. Скоро придётся пополнить.`, "warning");
				announced = level;
			}
		} catch {
			/* balance endpoint unreachable: the request path handles real failures */
		}
	};
	// The footer balance used to go stale in a long autonomous run (it was refreshed only at start, before a prompt and after a settled task):
	// poll every 30 seconds while the session lives, so it tracks the real balance within a cent or two.
	let poll: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", async (_e, ctx) => {
		void check((m, l) => ctx.ui.notify(m, l));
		clearInterval(poll);
		poll = setInterval(() => {
			try {
				void check((m, l) => ctx.ui.notify(m, l), 25_000);
			} catch {
				/* ctx retired by a session replacement */
			}
		}, 30_000);
		poll.unref?.();
	});
	pi.on("session_shutdown", async () => clearInterval(poll));
	pi.on("before_agent_start", async (_e, ctx) => void check((m, l) => ctx.ui.notify(m, l)));
	// Footer shows the balance: refresh it after each finished task (at most once a minute).
	pi.on("agent_settled", async (_e, ctx) => void check((m, l) => ctx.ui.notify(m, l), 60_000));
}
