// Stream watchdog + hedging for the Gonka proxy. Gonka assigns a random GPU node per request, so a slow start or a
// stalled stream is usually one bad node. This wraps the built-in openai-completions stream:
// 1. Hedge:  if no content token arrives within HEDGE_MS, the same request is started once more in parallel; whichever
//            attempt produces the first token wins, the other is aborted. Events are buffered until a winner is known.
// 2. Stall:  after the first token, a gap longer than STALL_MS aborts the stream with a transient error (pi retries).
// 3. Slow:   after GRACE_MS, a rate below the threshold over WINDOW_MS aborts too. When the whole network is slow,
//            each consecutive abort halves the threshold; after MAX_CONSECUTIVE_ABORTS slow streams are accepted.
// models.json sets provider gonka to api "gonka-watchdog"; this file registers that api.
// pi's extension loader resolves only "@earendil-works/pi-ai/compat". The completions stream is resolved defensively
// (namespace import, several known export names) so a pi update that renames it cannot crash pi at load time;
// watchdog-maintainer.ts detects that case and asks Opus to repair this file.
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import * as compat from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Env overrides exist for testing (e.g. PI_WATCHDOG_MIN_TPS=100000 PI_WATCHDOG_GRACE_MS=2000 PI_WATCHDOG_HEDGE_MS=1).
const HEDGE_MS = Number(process.env.PI_WATCHDOG_HEDGE_MS) || 8_000;
const STALL_MS = Number(process.env.PI_WATCHDOG_STALL_MS) || 15_000;
const GRACE_MS = Number(process.env.PI_WATCHDOG_GRACE_MS) || 30_000;
const WINDOW_MS = Math.min(20_000, GRACE_MS);
const CHECK_MS = 1_000;
const MIN_TOKENS_PER_S = Number(process.env.PI_WATCHDOG_MIN_TPS) || 10;
const CHARS_PER_TOKEN = 3.5;
const MAX_CONSECUTIVE_ABORTS = 3;
let consecutiveAborts = 0;

type Attempt = { id: number; controller: AbortController; buffer: AssistantMessageEvent[]; firstTokenAt: number; done: boolean };

function deltaChars(event: AssistantMessageEvent): number {
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") return event.delta.length;
	return 0;
}

type StreamSimple = (model: never, context: never, options?: never) => AsyncIterable<AssistantMessageEvent>;

/** Built-in openai-completions streamSimple, or undefined if this pi version no longer exposes any known name. */
export function resolveCompletionsStream(): StreamSimple | undefined {
	const c = compat as Record<string, unknown>;
	const api = c.openAICompletionsApi as undefined | (() => { streamSimple?: StreamSimple });
	const fromApi = typeof api === "function" ? api().streamSimple : undefined;
	const fromRegistry = (c.getApiProvider as undefined | ((a: string) => { streamSimple?: StreamSimple } | undefined))?.("openai-completions")?.streamSimple;
	return fromApi ?? fromRegistry ?? (c.streamSimpleOpenAICompletions as StreamSimple | undefined);
}

export default function (pi: ExtensionAPI) {
	const completionsStream = resolveCompletionsStream();
	const createStream = (compat as Record<string, unknown>).createAssistantMessageEventStream as
		| (() => ReturnType<typeof compat.createAssistantMessageEventStream>)
		| undefined;
	if (!completionsStream || !createStream) {
		console.error("[stream-watchdog] pi-ai no longer exposes the openai-completions stream; gonka requests will fail until watchdog-maintainer repairs ~/.pi/agent/ext/stream-watchdog.ts");
	}
	pi.registerProvider("gonka", {
		api: "gonka-watchdog",
		streamSimple(model, context, options) {
			if (!completionsStream || !createStream) throw new Error("stream-watchdog is broken after a pi update: openai-completions stream not found (watchdog-maintainer will repair it)");
			const out = createStream();
			const userSignal = options?.signal;
			const attempts: Attempt[] = [];
			let winner: Attempt | undefined;
			let finished = false;
			let lastError: AssistantMessageEvent | undefined;
			let slowReason = "";
			let lastChunkAt = 0;
			const samples: Array<{ t: number; chars: number }> = [];
			let partial: AssistantMessage | undefined;

			const finish = () => {
				if (finished) return;
				finished = true;
				clearInterval(timer);
				clearTimeout(hedgeTimer);
				userSignal?.removeEventListener("abort", onUserAbort);
				out.end();
			};
			const onUserAbort = () => {
				for (const a of attempts) a.controller.abort(userSignal?.reason);
			};
			if (userSignal?.aborted) queueMicrotask(onUserAbort);
			else userSignal?.addEventListener("abort", onUserAbort, { once: true });

			const emit = (event: AssistantMessageEvent) => {
				if ("partial" in event && event.partial) partial = event.partial;
				if (event.type === "done") consecutiveAborts = 0;
				out.push(event);
			};

			const run = async (attempt: Attempt) => {
				const inner = completionsStream({ ...model, api: "openai-completions" } as never, context as never, {
					...options,
					signal: attempt.controller.signal,
				} as never);
				try {
					for await (const event of inner) {
						if (finished || (winner && winner !== attempt)) break;
						const chars = deltaChars(event);
						if (!winner) {
							if (chars === 0 && event.type !== "done" && event.type !== "error") {
								attempt.buffer.push(event);
								continue;
							}
							if (event.type === "error") {
								lastError = event;
								attempt.done = true;
								if (attempts.every((a) => a.done)) {
									emit(event);
									finish();
								}
								return;
							}
							// First content (or an empty but complete answer): this attempt wins.
							winner = attempt;
							for (const other of attempts) if (other !== attempt) other.controller.abort(new Error("hedge lost"));
							for (const buffered of attempt.buffer) emit(buffered);
							attempt.buffer = [];
						}
						if (chars > 0) {
							const now = Date.now();
							if (!attempt.firstTokenAt) attempt.firstTokenAt = now;
							lastChunkAt = now;
							samples.push({ t: now, chars });
							while (samples.length > 0 && samples[0].t < now - WINDOW_MS) samples.shift();
						}
						if (event.type === "error" && slowReason && !userSignal?.aborted) {
							// Our own abort, not the user's: a transient error so pi retries (failover may switch models).
							const base = partial ?? event.error;
							emit({ type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: slowReason } });
							continue;
						}
						emit(event);
					}
				} finally {
					attempt.done = true;
					if (winner === attempt || (!winner && attempts.every((a) => a.done))) {
						if (!winner && lastError && !finished) emit(lastError);
						finish();
					}
				}
			};

			const start = () => {
				const attempt: Attempt = { id: attempts.length + 1, controller: new AbortController(), buffer: [], firstTokenAt: 0, done: false };
				attempts.push(attempt);
				void run(attempt);
			};

			const hedgeTimer = setTimeout(() => {
				if (!winner && !finished && !userSignal?.aborted) start();
			}, HEDGE_MS);

			const timer = setInterval(() => {
				if (!winner || finished || slowReason || !winner.firstTokenAt) return;
				const now = Date.now();
				if (now - lastChunkAt > STALL_MS) {
					slowReason = `stream stalled: no tokens for ${Math.round((now - lastChunkAt) / 1000)}s; retrying on another node (timeout)`;
					winner.controller.abort(new Error(slowReason));
					return;
				}
				if (now - winner.firstTokenAt < GRACE_MS || consecutiveAborts >= MAX_CONSECUTIVE_ABORTS) return;
				const recent = samples.filter((s) => s.t >= now - WINDOW_MS).reduce((sum, s) => sum + s.chars, 0);
				const rate = recent / CHARS_PER_TOKEN / (WINDOW_MS / 1000);
				const minRate = MIN_TOKENS_PER_S / 2 ** consecutiveAborts;
				if (rate < minRate) {
					consecutiveAborts++;
					slowReason = `slow stream timeout: ${rate.toFixed(1)} tok/s over last ${WINDOW_MS / 1000}s (min ${minRate.toFixed(1)}, abort ${consecutiveAborts}/${MAX_CONSECUTIVE_ABORTS}); retrying on another node`;
					winner.controller.abort(new Error(slowReason));
				}
			}, CHECK_MS);

			start();
			return out;
		},
	});
}
