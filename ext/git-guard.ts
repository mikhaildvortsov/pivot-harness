// Hard git/GitHub rules for delivery: no force-push, no push to the base branch, no hook bypass.
// Merging is allowed only when the user's current message explicitly asks for it (agents never merge on their own;
// subagents never receive user messages, so they can never merge).
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const BASE_BRANCHES = new Set(["main", "master", "develop"]);
const MERGE_CMD = /\bgh\s+pr\s+merge\b|--auto-merge\b|\bgh\s+pr\s+[^\n]*--auto\b/;
const MERGE_REQUEST = /(с|за)?м[её]рдж|(с|за)?мерж|\bmerge\b/i;
const MERGE_CONFLICT = /merge[\s-]*conflict|конфликт/i;
const MERGE_QUESTION = /м[её]рджить\s+pr|merge\s+pr\s*#?\d+\s*\?/i;
// No \b here: in JS it treats Cyrillic letters as non-word characters, so "да" would never match.
const AFFIRMATIVE = /^\s*(да|ага|ок|окей|yes|yep|ok|давай|го|мерджи|мержи|сливай)(?=$|[\s,.!)])/i;
const MERGE_NEGATION = /не\s+(с|за)?м[её]рдж|не\s+(с|за)?мерж|без\s+м[её]рдж|без\s+мерж|\b(don'?t|do\s+not|no)\s+merge\b/i;
const RULES: Array<[RegExp, string]> = [
	[/\bgit\s+push\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+[\w/.-]+)/, "force-push is forbidden"],
	[/\bgit\s+push\b[^\n;&|]*\s(HEAD:)?(refs\/heads\/)?(main|master|develop)\b/, "pushing the base branch is forbidden; push a task branch and open a draft PR"],
	[/--no-verify\b/, "--no-verify is forbidden; fix the hook failure instead"],
	[/\bgit\s+add\s+(-A\b|--all\b|\.(\s|$))/, "stage explicit paths only (no git add . / -A)"],
	[/Co-authored-by|Generated-by|Generated with/i, "no AI attribution or co-author trailers in commits/PRs"],
];

export default function (pi: ExtensionAPI) {
	let mergeAuthorized = false;
	let askedToMerge = false;
	pi.on("message_end", async (event) => {
		const m = event.message as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) return;
		const text = m.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
		if (text.trim()) askedToMerge = MERGE_QUESTION.test(text);
	});
	pi.on("input", async (event) => {
		const t = event.text;
		const explicit = MERGE_REQUEST.test(t) && !MERGE_NEGATION.test(t) && !MERGE_CONFLICT.test(t);
		const answeredYes = askedToMerge && AFFIRMATIVE.test(t) && !MERGE_NEGATION.test(t);
		mergeAuthorized = explicit || answeredYes;
		askedToMerge = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const cmd = event.input.command;
		for (const [re, why] of RULES) if (re.test(cmd)) return { block: true, reason: `git-guard: ${why}` };
		const branch = async () => (await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 10_000 })).stdout.trim();
		const mergesBase = /\bgit\s+merge\b/.test(cmd) && BASE_BRANCHES.has(await branch());
		if ((MERGE_CMD.test(cmd) || mergesBase) && !mergeAuthorized) {
			return {
				block: true,
				reason:
					"git-guard: merging only on the user's explicit request in their current message. Finish with the draft PR and ask: " +
					"\"Мерджить PR #<n> (<branch> → <base>, head <sha>, CI: <status>)?\"",
			};
		}
		// `git push <remote> HEAD` from the base branch would push the base branch too.
		if (/\bgit\s+push\b/.test(cmd)) {
			const current = await branch();
			if (BASE_BRANCHES.has(current)) return { block: true, reason: `git-guard: current branch is ${current}; create a task branch first` };
		}
	});
}
