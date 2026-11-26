// Configured-price estimates, never authoritative provider billing. Where the money goes. Token savings are not cost savings (a cheaper-looking context can break the prompt cache and cost more), so this measures configured-price estimates:
// - every step's cache hit rate; a step that pays for fresh input right after cached steps is a "cache break" with a reason
//   (compaction, another model/provider, a long pause, or the prefix changed) and the extra it cost;
// - a notice when a break was expensive, and a line in state/cost-watch.jsonl;
// - /cost: the chat's configured-price estimate by token type, cache hit rate, breaks, thinking share of the output, and the fixed weight of every request.
import { installTaskBudget } from "./task-budget.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG = join(homedir(), ".pi", "agent", "state", "cost-watch.jsonl");
const MIN_INPUT = 6_000; // below this a "break" is noise
const NOTIFY_EXTRA = 0.01; // dollars
const PAUSE_MS = 5 * 60_000;

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } };
type Entry = { type?: string; timestamp?: string; usage?: Usage; message?: { role?: string; provider?: string; model?: string; usage?: Usage; stopReason?: string; content?: unknown } };
// Compare observed configured per-token rates only when both are available.
export function cacheExtra(u: Usage): number | undefined {
	const fresh = (u.input ?? 0) > 0 && u.cost?.input !== undefined ? u.cost.input / u.input! : 0;
	const cached = (u.cacheRead ?? 0) > 0 && u.cost?.cacheRead !== undefined ? u.cost.cacheRead / u.cacheRead! : undefined;
	return fresh > 0 && cached !== undefined ? Math.max(0, (fresh - cached) * (u.input ?? 0)) : undefined;
}
export type Step = { n: number; model: string; input: number; cacheRead: number; output: number; cost: number; fresh$: number; ratio: number; brk?: { reason: string; extra: number } };

const ratioOf = (u: Usage) => {
	const i = u.input ?? 0, c = u.cacheRead ?? 0;
	return i + c > 0 ? c / (i + c) : 1;
};
const ms = (e: Entry) => (e.timestamp ? Date.parse(e.timestamp) : NaN);

/** Pure analysis of a chat branch: one Step per answered request, with cache breaks classified. */
export function analyze(entries: readonly Entry[]): Step[] {
	const steps: Step[] = [];
	let prev: { ratio: number; model: string; at: number } | undefined;
	let compacted = false;
	let edited = false; // pi omitted a failed attempt (retry after a provider error): the prefix changes
	for (const e of entries) {
		if (e.type === "compaction") compacted = true;
		if (e.type === "context_edit") edited = true;
		const m = e.message;
		if (e.type !== "message" || m?.role !== "assistant" || !m.usage || !(m.usage.input || m.usage.cacheRead || m.usage.output || m.usage.cost?.total)) continue;
		const u = m.usage;
		const model = `${m.provider ?? ""}/${m.model ?? ""}`;
		const ratio = ratioOf(u);
		const step: Step = { n: steps.length + 1, model, input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, output: u.output ?? 0, cost: u.cost?.total ?? 0, fresh$: u.cost?.input ?? 0, ratio };
		const at = ms(e);
		if (step.input >= MIN_INPUT && ratio < 0.5 && (compacted || edited || (prev && prev.ratio >= 0.5))) {
			const reason = compacted ? "компакция" : edited ? "повтор после сбоя провайдера" : prev && prev.model !== model ? "другая модель/провайдер" : prev && at - prev.at > PAUSE_MS ? "пауза > 5 мин" : (u.cacheRead ?? 0) < 1000 ? "провайдер не отдал кэш" : "префикс изменился";
			step.brk = { reason, extra: cacheExtra(u) ?? 0 };
		}
		compacted = false;
		edited = false;
		prev = { ratio, model, at };
		steps.push(step);
	}
	return steps;
}

/** Characters of the assistant output by kind (a proxy for how much of the output tokens is thinking). */
export function outputKinds(entries: readonly Entry[]) {
	const k = { thinking: 0, text: 0, toolCall: 0 };
	for (const e of entries) {
		const m = e.message;
		if (e.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<{ type?: string; thinking?: string; text?: string; arguments?: unknown }>) {
			if (b.type === "thinking") k.thinking += b.thinking?.length ?? 0;
			else if (b.type === "text") k.text += b.text?.length ?? 0;
			else if (b.type === "toolCall") k.toolCall += JSON.stringify(b.arguments ?? "").length;
		}
	}
	return k;
}

const usd = (v: number) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export function report(entries: readonly Entry[], fixed: { system: number; tools: number; toolCount: number }): string {
	const steps = analyze(entries);
	if (!steps.length) return "Пока нет ни одного ответа модели с учётом токенов.";
	const sum = (f: (s: Step) => number) => steps.reduce((a, s) => a + f(s), 0);
	const total = sum((s) => s.cost), inTok = sum((s) => s.input), cached = sum((s) => s.cacheRead), out = sum((s) => s.output);
	let freshCost = 0, outCost = 0, cacheCost = 0;
	for (const e of entries) {
		const c = e.message?.usage?.cost;
		if (e.type === "message" && e.message?.role === "assistant" && c) {
			freshCost += c.input ?? 0;
			outCost += c.output ?? 0;
			cacheCost += (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
		}
	}
	// summarization calls of compactions are billed too but live on the compaction entries, not on assistant messages
	const compactions = entries.filter((e) => e.type === "compaction" && e.usage?.cost?.total);
	const compCost = compactions.reduce((a, e) => a + (e.usage!.cost!.total ?? 0), 0);
	const breaks = steps.filter((s) => s.brk);
	const byReason = new Map<string, { n: number; extra: number }>();
	for (const s of breaks) {
		const r = byReason.get(s.brk!.reason) ?? { n: 0, extra: 0 };
		r.n++;
		r.extra += s.brk!.extra;
		byReason.set(s.brk!.reason, r);
	}
	const kinds = outputKinds(entries);
	const chars = kinds.thinking + kinds.text + kinds.toolCall;
	const lines = [
		`Оценка по настроенным ценам (не счёт провайдера; включает прайс подписок): ${steps.length} шагов, всего ${usd(total + compCost)}${compactions.length ? ` (шаги ${usd(total)} + вызовы суммаризации ${compactions.length} компакций ${usd(compCost)})` : ""}. Шаги: свежий вход ${usd(freshCost)} (${pct(freshCost, total)}), чтение кэша ${usd(cacheCost)} (${pct(cacheCost, total)}), вывод ${usd(outCost)} (${pct(outCost, total)}).`,
		`Кэш: ${pct(cached, inTok + cached)} входных токенов из кэша; свежих ${Math.round(inTok / 1000)}k, из кэша ${Math.round(cached / 1000)}k, вывод ${Math.round(out / 1000)}k.`,
		breaks.length
			? `Разрывы кэша: ${breaks.length}, оценка разницы при известных ставках ${usd(sum((s) => s.brk?.extra ?? 0))} (${[...byReason].map(([r, v]) => `${r} ${v.n} / ${usd(v.extra)}`).join(", ")}).`
			: "Разрывов кэша нет.",
		chars ? `Вывод по символам: размышления ${pct(kinds.thinking, chars)}, текст ${pct(kinds.text, chars)}, аргументы вызовов ${pct(kinds.toolCall, chars)}.` : "",
		`Вес каждого запроса (оценка символы/4): системный промпт ~${Math.round(fixed.system / 4000)}k, схемы ${fixed.toolCount} инструментов ~${Math.round(fixed.tools / 4000)}k токенов.`,
		...[...breaks].sort((a, b) => b.brk!.extra - a.brk!.extra).slice(0, 3).map((s) => `  шаг ${s.n}: ${s.brk!.reason}, +${usd(s.brk!.extra)}, свежих ${Math.round(s.input / 1000)}k`),
	];
	return lines.filter(Boolean).join("\n");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	installTaskBudget(pi);
	let prev: { ratio: number; model: string; at: number } | undefined;
	let compacted = false;
	pi.on("session_start", async () => {
		prev = undefined;
		compacted = false;
	});
	pi.on("session_compact" as never, (async () => {
		compacted = true;
	}) as never);
	pi.on("message_end", async (e, ctx) => {
		const m = e.message as Entry["message"];
		if (m?.role !== "assistant" || !m.usage || m.stopReason === "error" || !(m.usage.input || m.usage.cacheRead)) return;
		const model = `${m.provider ?? ""}/${m.model ?? ""}`;
		const ratio = ratioOf(m.usage);
		const input = m.usage.input ?? 0;
		const now = Date.now();
		if (input >= MIN_INPUT && ratio < 0.5 && (compacted || (prev && prev.ratio >= 0.5))) {
			const reason = compacted ? "компакция" : prev && prev.model !== model ? "другая модель/провайдер" : prev && now - prev.at > PAUSE_MS ? "пауза > 5 мин" : (m.usage.cacheRead ?? 0) < 1000 ? "провайдер не отдал кэш" : "префикс изменился";
			const extra = cacheExtra(m.usage) ?? 0;
			try {
				mkdirSync(dirname(LOG), { recursive: true });
				appendFileSync(LOG, JSON.stringify({ at: new Date(now).toISOString(), session: ctx.sessionManager.getSessionFile?.(), model, reason, freshInput: input, extra: +extra.toFixed(4) }) + "\n");
			} catch {
				/* best effort */
			}
			if (extra >= NOTIFY_EXTRA && ctx.mode === "tui") ctx.ui.notify(`Кэш сломан (${reason}): свежих ${Math.round(input / 1000)}k токенов, оценка разницы ${usd(extra)}. Подробности: /cost`, "warning");
		}
		compacted = false;
		prev = { ratio, model, at: now };
	});

	pi.registerCommand("cost", {
		description: "Оценка по настроенным ценам (не счёт): кэш, разрывы кэша, размышления, вес запроса",
		handler: async (_args, ctx) => {
			const active = new Set(pi.getActiveTools());
			const tools = pi.getAllTools().filter((t) => active.has(t.name));
			const toolChars = tools.reduce((a, t) => a + JSON.stringify(t).length, 0);
			ctx.ui.notify(report(ctx.sessionManager.getBranch() as readonly Entry[], { system: ctx.getSystemPrompt().length, tools: toolChars, toolCount: tools.length }), "info");
		},
	});
}
