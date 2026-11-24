// Blocks write/edit calls that introduce stubs or type/lint escapes into code files.
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb|swift|vue|svelte)$/i;

const RULES: Array<[RegExp, string]> = [
	[/\b(TODO|FIXME|XXX)\b/, "TODO/FIXME/XXX marker"],
	[/\bNotImplementedError\b/, "NotImplementedError stub"],
	[/\bas\s+any\b/, "`as any` type escape"],
	[/@ts-ignore\b/, "@ts-ignore"],
	[/@ts-expect-error\b/, "@ts-expect-error"],
	[/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/, "empty catch block"],
];

function newCode(event: ToolCallEvent): { path: string; text: string } | undefined {
	const input = event.input as { path?: string; content?: string; edits?: Array<{ newText?: string }> };
	if (!input.path) return undefined;
	if (event.toolName === "write") return { path: input.path, text: input.content ?? "" };
	if (event.toolName === "edit") return { path: input.path, text: (input.edits ?? []).map((e) => e.newText ?? "").join("\n") };
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
		const change = newCode(event);
		if (!change || !CODE_FILE.test(change.path)) return undefined;
		const hits = RULES.filter(([re]) => re.test(change.text)).map(([, label]) => label);
		if (hits.length === 0) return undefined;
		return {
			block: true,
			reason:
				`anti-laziness: refused to write ${change.path} — found ${hits.join(", ")}. ` +
				"Implement the real logic (typed values, handled or rethrown errors, no placeholders) and retry. " +
				"If something is truly blocked, stop and report the exact blocker instead of leaving a stub.",
		};
	});
}
