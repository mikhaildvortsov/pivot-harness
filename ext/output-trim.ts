// Long bash output is re-sent on every following step (it is the largest share of fresh input tokens), so keep the part that matters:
// the head, the tail (where test runners and builds print their verdict) and every error-looking line from the middle.
// The full output goes to a temp file the model can grep. Output that was asked for on purpose (cat, git diff, ...) gets a higher limit.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMIT = 9_000;
const LIMIT_READING = 24_000;
const HEAD = 40;
const TAIL = 120;
const MAX_MIDDLE_HITS = 40;
const READING = /^\s*(cat|sed\s+-n|head|tail|git\s+(diff|show|log|blame)|rg|grep)\b/;
const NOTABLE = /\b(error|errors|fail|failed|failing|fatal|exception|traceback|panic|denied|cannot|can't|not found|assert|warn(ing)?|✗|✖|FAIL)\b/i;

function excerpt(rows: Array<{ line: string; number: number }>, budget: number): string {
	// Labels also consume the cap; drop central rows first, retaining section edges.
	while (rows.length && rows.reduce((sum, row) => sum + `[line ${row.number}] `.length + Math.min(row.line.length, 80) + 1, 0) > budget) {
		const middle = Math.floor(rows.length / 2);
		rows = rows.filter((_, i) => i !== middle);
	}
	const labels = rows.map(({ number }) => `[line ${number}] `);
	let remaining = budget - labels.reduce((sum, label) => sum + label.length + 1, 0);
	const sizes = rows.map(() => 0);
	// Share space fairly: short lines leave their unused allowance for long diagnostics.
	const pending = rows.map((_, i) => i).sort((a, b) => rows[a]!.line.length - rows[b]!.line.length);
	for (let j = 0; j < pending.length; j++) {
		const i = pending[j]!;
		sizes[i] = Math.min(rows[i]!.line.length, Math.max(0, Math.floor(remaining / (pending.length - j))));
		remaining -= sizes[i]!;
	}
	return rows.map(({ line }, i) => {
		const size = sizes[i]!;
		if (line.length <= size) return labels[i] + line;
		const marker = "… [omitted] …";
		const half = Math.max(0, Math.floor((size - marker.length) / 2));
		const start = line.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
		const end = half ? line.slice(-half).replace(/^[\uDC00-\uDFFF]/, "") : "";
		return labels[i] + (size >= marker.length ? start + marker + end : marker.slice(0, size));
	}).join("\n");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1") return;
	const dir = join(tmpdir(), "pi-bash-output");

	pi.on("tool_result", async (e) => {
		if (e.toolName !== "bash") return;
		const parts = e.content;
		if (parts.length !== 1 || parts[0]!.type !== "text") return;
		const text = parts[0]!.text;
		const cmd = String((e.input as { command?: string }).command ?? "");
		const limit = READING.test(cmd) ? LIMIT_READING : LIMIT;
		if (text.length <= limit) return;
		const lines = text.split("\n");
		const rows = lines.map((line, i) => ({ line, number: i + 1 }));
		const tailStart = Math.max(HEAD, lines.length - TAIL);
		const hits = rows.slice(HEAD, tailStart).filter(({ line }) => NOTABLE.test(line)).slice(0, MAX_MIDDLE_HITS);
		let path = "";
		try {
			mkdirSync(dir, { recursive: true });
			path = join(dir, `${process.pid}-${randomUUID()}.txt`);
			writeFileSync(path, text, { flag: "wx", mode: 0o600 });
		} catch {
			return; // cannot save the full output: do not drop it
		}
		const notice = `[output-trim: ${text.length} chars, ${lines.length} lines; content omitted, including possible diagnostics. Full evidence requires reading the artifact.\nfull output: ${path}; use grep or sed -n instead of re-running]`;
		const groups = [rows.slice(0, HEAD), hits, rows.slice(tailStart)].filter((group) => group.length);
		const budget = Math.floor((limit - notice.length - groups.length) / groups.length);
		const kept = [notice, ...groups.map((group) => excerpt(group, budget))].join("\n");
		return { content: [{ type: "text", text: kept }] };
	});
}
