// Current foreground task only; configured-price estimates are not provider bills.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export const WARN_USD = 0.10;
export const LIMIT_USD = 0.25;
const SUBSCRIPTION = new Set(["anthropic", "openai-codex"]);
export const meteredEstimate = (provider: string | undefined, cost: number | undefined, usesSubscription = false) => (usesSubscription && SUBSCRIPTION.has(provider ?? "")) || !Number.isFinite(cost) || (cost ?? 0) < 0 ? 0 : cost ?? 0;
const usesSubscription = (ctx: ExtensionContext, provider: string | undefined, id: string | undefined) => {
    if (!SUBSCRIPTION.has(provider ?? "") || !provider || !id) return false;
    const model = ctx.modelRegistry.find(provider, id);
    return model !== undefined && ctx.modelRegistry.isUsingOAuth(model);
};
export function installTaskBudget(pi: ExtensionAPI) {
    let spent = 0, limit = LIMIT_USD, warned = false, active = false, paused = false;
    const waiters = new Set<() => void>();
    const release = () => {
        for (const done of waiters) done();
    };
    const status = () => `Budget (current process/task): configured-price metered estimate $${spent.toFixed(3)} / $${limit.toFixed(2)}. ` +
        `Subscription list prices excluded. Not a billing cap: unknown prices, unreported retries, child/headless processes and other sessions are not included; one in-flight request can overshoot. ` +
        (paused ? `Paused. /budget continue adds $0.25; /budget increase 0.50 adds $0.50. Then continue the same task.` : `/budget shows this task.`);
    const pause = (ctx: ExtensionContext) => {
        if (spent < limit)
            return false;
        if (!paused) {
            paused = true;
            ctx.ui.notify(status(), "warning");
        }
        return true;
    };
    const guard = async (_event: unknown, ctx: ExtensionContext) => {
        if (!pause(ctx))
            return;
        // Print/JSON cannot accept slash commands while awaiting a model; terminate using the
        // runtime abort signal. The provider transport observes it before any HTTP request.
        if (ctx.mode === "print" || ctx.mode === "json") {
            ctx.abort();
            return;
        }
        if (ctx.signal?.aborted)
            return;
        await new Promise<void>((resolve) => {
            const done = () => {
                waiters.delete(done);
                ctx.signal?.removeEventListener("abort", done);
                resolve();
            };
            waiters.add(done);
            ctx.signal?.addEventListener("abort", done, { once: true });
            if (!paused || ctx.signal?.aborted)
                done();
        });
    };
    pi.on("input", (event, ctx) => {
        if (event.source === "extension")
            return;
        if (paused) {
            ctx.ui.notify(status(), "warning");
            return { action: "handled" };
        }
        if (!active && !event.streamingBehavior) {
            spent = 0;
            limit = LIMIT_USD;
            warned = false;
            active = true;
        }
    });
    pi.on("message_end", (event, ctx) => {
        const m = event.message;
        if (m.role !== "assistant")
            return;
        spent += meteredEstimate(m.provider, m.usage?.cost?.total, usesSubscription(ctx, m.provider, m.model));
        if (!warned && spent >= WARN_USD) {
            warned = true;
            ctx.ui.notify(status(), "warning");
        }
    });
    pi.on("session_compact", (event, ctx) => {
        spent += meteredEstimate(ctx.model?.provider, event.compactionEntry.usage?.cost?.total, usesSubscription(ctx, ctx.model?.provider, ctx.model?.id));
    });
    pi.on("turn_end", (_event, ctx) => {
        // All calls in the batch have finished; never interrupt writes or checks.
        if (pause(ctx) && (ctx.mode === "print" || ctx.mode === "json"))
            ctx.abort();
    });
    pi.on("context", guard);
    pi.on("before_provider_request", guard);
    pi.on("agent_end", (event) => {
        const last = [...event.messages].reverse().find((m) => m.role === "assistant");
        if (!paused && last?.role === "assistant" && last.stopReason !== "error" && last.stopReason !== "aborted") active = false;
    });
    pi.registerCommand("budget", {
        description: "Task estimate and explicit allowance increase: /budget continue or /budget increase 0.50",
        handler: async (args, ctx) => {
            const words = args.trim().split(/\s+/);
            const extra = words[0] === "continue" && words.length === 1 ? LIMIT_USD :
                words[0] === "increase" && words.length === 2 ? Number(words[1]) : NaN;
            if (args.trim() && (!Number.isFinite(extra) || extra <= 0)) {
                ctx.ui.notify("Use /budget, /budget continue (+$0.25), or /budget increase 0.50 (+$0.50).", "warning");
                return;
            }
            if (Number.isFinite(extra)) {
                limit = Math.max(limit, spent) + extra;
                paused = false;
                active = true;
                release();
            }
            ctx.ui.notify(status(), "info");
        },
    });
}
