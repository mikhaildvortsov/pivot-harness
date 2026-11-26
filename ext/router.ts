// Virtual model router/auto: picks the physical model per request and fails over along a chain.
//   text: NanoGPT DeepSeek plain/thinking → Gonka DeepSeek → Gonka GLM → NanoGPT Qwen (last resort)
//   images: NanoGPT GLM-5.3 Flash → Gonka GLM-5.3 Flash
// pi thinking level "off" uses the plain DeepSeek variant, any other level the ":thinking" variant.
// Failures: a transient error (timeout, 5xx, 429, reset) benches the failed model immediately for BENCH_MS and moves
// on. An auth/billing error (401/402/403, insufficient balance) benches the whole provider for PROVIDER_BENCH_MS — so when
// the NanoGPT balance runs out, work continues on the Gonka reserve. Missing credentials skip a provider silently.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Ref = { provider: string; id: string };
const NG = "nanogpt";
const GK = "gonka";
const DS_PLAIN: Ref = { provider: NG, id: "deepseek/deepseek-v4.1-flash-1017" };
const DS_THINK: Ref = { provider: NG, id: "deepseek/deepseek-v4.1-flash-1017:thinking" };
const QWEN: Ref = { provider: NG, id: "qwen/qwen3-coder-next" };
const NG_GLM: Ref = { provider: NG, id: "z-ai/glm-5.3-flash" };
const GK_GLM: Ref = { provider: GK, id: "zai-org/GLM-5.3-Flash" };
const GK_DS: Ref = { provider: GK, id: "deepseek-ai/DeepSeek-V4-Flash-0731" };

// NanoGPT direct only (Runware dropped on purpose, to compare the bill); Qwen3 Coder is about 4x the price per step of DeepSeek (measured: $0.0035 vs $0.0009), so it is the last resort, behind the Gonka reserve.
const CHAIN_PLAIN = [DS_PLAIN, GK_DS, GK_GLM, QWEN];
const CHAIN_THINK = [DS_THINK, GK_DS, GK_GLM, QWEN];
const CHAIN_IMAGE = [NG_GLM, GK_GLM];

const BENCH_MS = 10 * 60_000;
const PROVIDER_BENCH_MS = 60 * 60_000;
const SAME_MODEL_RETRIES = 0;
// A refused/reset connection is a network blip (it hits every NanoGPT model at once): bench briefly instead of for 10 minutes, so the run does not sit on a fallback.
const NETWORK_BLIP = /ECONNREFUSED|ECONNRESET|connection error|fetch failed|EPIPE|socket/i;
const BLIP_BENCH_MS = 45_000;
const PROVIDER_DOWN = /\b(401|402|403)\b|unauthori[sz]ed|forbidden|insufficient|balance|credit|payment|invalid api key|no api key/i;
const TRANSIENT = /timeout|timed out|idle|stalled|ECONNRESET|ETIMEDOUT|EPIPE|socket|connection|closed|stopped sending|fetch failed|\b5\d\d\b|upstream|unavailable|overloaded|rate.?limit|\b429\b/i;

type State = { fails: number };
const key = (r: Ref) => `${r.provider}/${r.id}`;
const benchedUntil = new Map<string, number>();
// nanogpt-runware shares the NanoGPT account: auth/billing failures bench both.
const family = (provider: string) => (provider.startsWith(NG) ? NG : provider);
const isBenched = (r: Ref) => (benchedUntil.get(key(r)) ?? 0) > Date.now() || (benchedUntil.get(family(r.provider)) ?? 0) > Date.now();

const imageIn = (m: { content?: unknown }) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: string }).type === "image");
/** An image in the current turn: a user message (attachment) or a tool result (a DevTools screenshot) after the last assistant message. pi-ai replaces images with a placeholder for text-only models, so such a step must go to the vision chain. */
function hasImage(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role === "assistant") return false;
		if ((m.role === "user" || m.role === "toolResult") && imageIn(m)) return true;
	}
	return false;
}
/** The user themselves attached an image to this request (the prompt message, or the one paired with it). */
function promptHasImage(messages: readonly unknown[]): boolean {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0 && seen < 2; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "user") {
			if (seen) return false;
			continue;
		}
		seen++;
		if (imageIn(m)) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	// Provider-level failures reported by wrappers (nanogpt-guard.ts, balance monitor): bench the whole provider.
	pi.events.on("provider:down", (data) => {
		const d = data as { provider?: string; ms?: number };
		if (d.provider) benchedUntil.set(family(d.provider), Date.now() + (d.ms ?? PROVIDER_BENCH_MS));
	});

	pi.registerVirtualModel<State>({
		provider: "router",
		id: "auto",
		name: "Auto: NanoGPT → Gonka",
		thinkingLevels: ["off", "low", "high"],
		contextWindow: 200_000,
		maxTokens: 32_768,
		input: ["text", "image"],
		route(request, ctx) {
			const reg = ctx.modelRegistry;
			const usable = (r: Ref) => {
				const m = reg.find(r.provider, r.id);
				return m && reg.hasConfiguredAuth(m) && !isBenched(r) ? m : undefined;
			};
			const pick = (chain: Ref[]) => {
				for (const r of chain) {
					const m = usable(r);
					if (m) return m;
				}
				throw new Error("router: no authenticated, unbenched model is available in the chain");
			};
			// NanoGPT picks thinking by model id. Gonka GLM in thinking mode prints tool calls as raw text, so it always runs with thinking off.
			const withLevel = (model: { provider: string; id: string }, level: typeof request.thinkingLevel) =>
				model.provider.startsWith(NG) || /glm/i.test(model.id) ? "off" : level;

			const level = request.thinkingLevel;
			const image = hasImage(request.messages);
			const chain = image ? CHAIN_IMAGE : level === "off" ? CHAIN_PLAIN : CHAIN_THINK;
			const fails = request.state?.fails ?? 0;

			if (request.reason === "retry" && request.failed) {
				const failed = request.failed.model;
				const err = request.failed.message?.errorMessage ?? "";
				if (PROVIDER_DOWN.test(err)) {
					benchedUntil.set(family(failed.provider), Date.now() + PROVIDER_BENCH_MS);
					const m = pick(chain);
					return { model: m, thinkingLevel: withLevel(m, level), state: { fails: 0 } };
				}
				if (!TRANSIENT.test(err)) return { model: failed, thinkingLevel: request.failed.thinkingLevel ?? level };
				if (fails < SAME_MODEL_RETRIES) return { model: failed, thinkingLevel: request.failed.thinkingLevel ?? level, state: { fails: fails + 1 } };
				benchedUntil.set(key({ provider: failed.provider, id: failed.id }), Date.now() + (NETWORK_BLIP.test(err) ? BLIP_BENCH_MS : BENCH_MS));
				const m = pick(chain);
				return { model: m, thinkingLevel: withLevel(m, level), state: { fails: 0 } };
			}

			const reset = fails !== 0 ? { fails: 0 } : undefined;
			const prev = request.previous?.model;
			// Tool follow-ups stay on the model that started the turn (prompt cache), unless it was benched meanwhile.
			if (request.reason === "continuation" && prev && !isBenched({ provider: prev.provider, id: prev.id })) {
				const canSeeImages = !image || (prev.input as readonly string[]).includes("image");
				// A screenshot from a tool is read by the vision model for one step; the rest of the turn returns to the cheaper text model.
				// (An image the user attached stays with the vision model for the whole turn: the text model would only see a placeholder.)
				const backToText = !image && CHAIN_IMAGE.some((r) => r.provider === prev.provider && r.id === prev.id) && !promptHasImage(request.messages);
				const changedVariant = (prev.id === DS_PLAIN.id || prev.id === DS_THINK.id) && prev.provider === NG && prev.id !== (level === "off" ? DS_PLAIN.id : DS_THINK.id);
				if (canSeeImages && !backToText && !changedVariant) return { model: prev, thinkingLevel: request.previous?.thinkingLevel ?? withLevel(prev, level), state: reset };
			}
			if (request.reason === "direct") {
				const m = pick(CHAIN_PLAIN);
				return { model: m, thinkingLevel: withLevel(m, "off") };
			}
			const m = pick(chain);
			return { model: m, thinkingLevel: withLevel(m, level), state: reset };
		},
	});
}
