// Hard git/GitHub rules for delivery: no force-push, no push to the base branch, no hook bypass.
// Merging is allowed only when a user message explicitly asks for it (agents never merge on their own; subagents never receive
// user messages, so they can never merge). A request that names PRs ("мерджить #375 и #374", also inside a pasted message of a
// colleague) authorizes exactly those PRs for the rest of the chat, so "продолжай работу" does not take it back; a request without
// numbers counts for that message only. "не мерджи" revokes everything.
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const BASE_BRANCHES = new Set(["main", "master", "develop"]);
const MERGE_CMD = /\bgh\s+pr\s+merge\b|--auto-merge\b|\bgh\s+pr\s+[^\n]*--auto\b/;
const MERGE_REQUEST = /(с|за)?м[её]рдж|(с|за)?мерж|вл(ей|ивай|ить|ейте|ива)|(с|за)?сл(ей|ивай|ить)\s+(pr|пр|оба|все|обе)|\bmerge\b/i;
const MERGE_CONFLICT = /merge[\s-]*conflicts?|конфликт\w*/gi;
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
	const approved = new Set<string>(); // PR numbers the user asked to merge
	let anyThisTurn = false; // a merge request without PR numbers, valid for the current message only
	let askedToMerge = false;
	let askedNumbers: string[] = [];
	const numbers = (line: string) => [...line.matchAll(/(?:#|pull\/)(\d+)/g)].map((m) => m[1]!);
	pi.on("message_end", async (event) => {
		const m = event.message as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) return;
		const text = m.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
		if (text.trim()) {
			askedToMerge = MERGE_QUESTION.test(text);
			askedNumbers = askedToMerge ? text.split("\n").filter((l) => MERGE_QUESTION.test(l)).flatMap(numbers) : [];
		}
	});
	pi.on("input", async (event) => {
		const t = event.text.replace(MERGE_CONFLICT, "");
		anyThisTurn = false;
		if (MERGE_NEGATION.test(t)) approved.clear();
		else {
			for (const line of t.split("\n")) {
				if (!MERGE_REQUEST.test(line)) continue;
				const nums = numbers(line);
				if (nums.length) nums.forEach((n) => approved.add(n));
				else anyThisTurn = true;
			}
			if (askedToMerge && AFFIRMATIVE.test(t)) {
				if (askedNumbers.length) askedNumbers.forEach((n) => approved.add(n));
				else anyThisTurn = true;
			}
		}
		askedToMerge = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const cmd = event.input.command;
		for (const [re, why] of RULES) if (re.test(cmd)) return { block: true, reason: `git-guard: ${why}` };
		const branch = async () => (await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 10_000 })).stdout.trim();
		const mergesBase = /\bgit\s+merge\b/.test(cmd) && BASE_BRANCHES.has(await branch());
		const target = /\bgh\s+pr\s+merge\s+(?:\S*pull\/|#)?(\d+)/.exec(cmd)?.[1];
		const allowed = anyThisTurn || (target !== undefined && approved.has(target));
		if ((MERGE_CMD.test(cmd) || mergesBase) && !allowed) {
			return {
				block: true,
				reason:
					"git-guard: merging only on the user's explicit request naming the PR (\"Мерджить #<n>\"), in this message or earlier in this chat. Finish with the draft PR and ask: " +
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
