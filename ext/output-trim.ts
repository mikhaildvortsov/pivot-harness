// Long bash output is re-sent on every following step (it is the largest share of fresh input tokens), so keep the part that matters:
// the head, the tail (where test runners and builds print their verdict) and every error-looking line from the middle.
// The full output goes to a temp file the model can grep. Output that was asked for on purpose (cat, git diff, ...) gets a higher limit.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1") return;
	const dir = join(tmpdir(), "pi-bash-output");
	let n = 0;

	pi.on("tool_result", async (e) => {
		if (e.toolName !== "bash") return;
		const parts = e.content;
		if (parts.length !== 1 || parts[0]!.type !== "text") return;
		const text = parts[0]!.text;
		const cmd = String((e.input as { command?: string }).command ?? "");
		if (text.length <= (READING.test(cmd) ? LIMIT_READING : LIMIT)) return;
		const lines = text.split("\n");
		if (lines.length <= HEAD + TAIL + 10) return; // few but very long lines: nothing sensible to cut
		const middle = lines.slice(HEAD, lines.length - TAIL);
		const hits = middle.filter((l) => NOTABLE.test(l)).slice(0, MAX_MIDDLE_HITS);
		let path = "";
		try {
			mkdirSync(dir, { recursive: true });
			path = join(dir, `${process.pid}-${++n}.txt`);
			writeFileSync(path, text);
		} catch {
			return; // cannot save the full output: do not drop it
		}
		const kept = [
			...lines.slice(0, HEAD),
			`… [output-trim: ${middle.length} of ${lines.length} lines omitted; ${hits.length ? `${hits.length} error-like lines kept below; ` : ""}full output: ${path} — grep or sed -n it instead of re-running]`,
			...hits,
			"… [end of omitted part]",
			...lines.slice(-TAIL),
		].join("\n");
		return { content: [{ type: "text", text: kept }] };
	});
}
