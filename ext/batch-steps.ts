// Fewer round trips for subagents. Every step re-sends the whole context (72% of a swarm's bill is that re-reading), and measured swarm runs spent
// 27% of their steps writing small files one per step and re-read the same files in 40-line windows. This extension:
// - adds `write_many`: several files in ONE step, each written by the normal `write` tool through its guards (git-guard, config-guard, the skill gate...);
// - appends a one-line hint to the result of the second write in a row, and of the third read window of the same file, at the moment it helps.
// Loaded in subagents only (settings.json → subagents.defaultExtensions).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FILES = 10;
const MAX_CHARS = 30_000;
const WRITE_CMD = /\bcat\s*>>?\s*\S+|\btee\s+(-a\s+)?\S+|\b(printf|echo)\b[^\n|]*>>?\s*\S+/;
const SED_WINDOW = /\bsed\s+-n\s+'?(\d+),(\d+)p'?\s+([^\s;&|'"]+)/g;

export default function (pi: ExtensionAPI) {
	let consecutiveWrites = 0;
	let inBatch = false; // nested `write` calls of write_many must not count as separate steps
	const windows = new Map<string, number>();

	pi.registerTool({
		name: "write_many",
		label: "Write several files",
		description:
			`Create or overwrite several files in ONE step (up to ${MAX_FILES} files, ${MAX_CHARS} characters in total). Use it instead of one write call or one \`cat > file\` per file: ` +
			"every extra step re-sends the whole conversation. Each file goes through the normal write tool, so all write rules apply to every file. If a batch is too big, split it into a few calls.",
		parameters: Type.Object({
			files: Type.Array(Type.Object({ path: Type.String({ description: "file path" }), content: Type.String({ description: "full file content" }) }), { minItems: 1, maxItems: MAX_FILES }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const files = (params as { files: Array<{ path: string; content: string }> }).files;
			const total = files.reduce((n, f) => n + f.content.length, 0);
			if (files.length > MAX_FILES || total > MAX_CHARS)
				return { content: [{ type: "text", text: `write_many: nothing written. ${files.length} files / ${total} characters exceeds the limit (${MAX_FILES} files, ${MAX_CHARS} characters). Split it into several write_many calls.` }], details: {} };
			const lines: string[] = [];
			inBatch = true;
			try {
				for (const f of files) {
					const r = await ctx.executeTool("write", { path: f.path, content: f.content }, { signal });
					const text = (r.result?.content ?? []).map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim();
					lines.push(`${r.isError ? "FAILED" : "ok"}  ${f.path}${text ? ` — ${text.slice(0, 200)}` : ""}`);
				}
			} finally {
				inBatch = false;
			}
			consecutiveWrites = 0;
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.on("input", async () => {
		consecutiveWrites = 0;
		windows.clear();
	});

	pi.on("tool_result", async (e) => {
		if (inBatch) return;
		const input = (e.input ?? {}) as { command?: string; path?: string; offset?: number; limit?: number };
		const cmd = e.toolName === "bash" ? String(input.command ?? "") : "";
		let hint = "";

		if (e.toolName === "write_many") consecutiveWrites = 0;
		else if (e.toolName === "write" || (e.toolName === "bash" && WRITE_CMD.test(cmd))) {
			consecutiveWrites++;
			if (consecutiveWrites >= 2 && (consecutiveWrites - 2) % 3 === 0)
				hint = `[batch] ${consecutiveWrites} files in a row, each in its own step. Every step re-sends the whole context and is billed again: put all remaining files of this batch into ONE write_many call (up to ${MAX_FILES} files).`;
		} else consecutiveWrites = 0;

		const bump = (file: string) => {
			const n = (windows.get(file) ?? 0) + 1;
			windows.set(file, n);
			return n;
		};
		const reads: Array<[string, number]> = [];
		if (e.toolName === "read" && input.path && (input.offset !== undefined || input.limit !== undefined)) reads.push([input.path, bump(input.path)]);
		if (cmd) for (const m of cmd.matchAll(SED_WINDOW)) reads.push([m[3]!, bump(m[3]!)]);
		const hot = reads.find(([, n]) => n >= 3 && n % 3 === 0);
		if (hot) hint = (hint ? hint + "\n" : "") + `[batch] Read window ${hot[1]} of ${hot[0]}. Read the whole file, or a 300+ line range, in one call instead of small windows: every extra step re-sends the whole context.`;

		if (!hint) return;
		return { content: [...e.content, { type: "text", text: hint }] };
	});
}
