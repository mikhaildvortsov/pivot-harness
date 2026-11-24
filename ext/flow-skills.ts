// Auto-runs the user's own skills at the right moments:
// - fullstack-plan: started by task-classifier.ts when the model declares the task fullstack.
// - critic: before finishing, when the change is non-trivial; runs after auto-verify passes and before the Opus review
//   (enforced by the extension order in settings.json and by skipping while another gate already requested a turn).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILLS = join(homedir(), ".pi", "agent", "skills");
const CRITIC_MIN_LINES = 30;
const CRITIC_MIN_FILES = 3;
const MAX_CRITIC_RUNS = 2;
const SENSITIVE = /auth|login|session|token|password|permission|rbac|acl|guard|policy|role|migration|\.sql$|payment|billing|crypto|secret/i;
const DOC_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|svg)$|(^|\/)(specs|docs|\.specify|\.pi\/context)\//i;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;
	let baseline: string | undefined;
	let auditedState: string | undefined;
	let criticRuns = 0;

	const sh = async (cwd: string, script: string) => (await pi.exec("bash", ["-c", script], { cwd, timeout: 30_000 })).stdout;
	const fingerprint = (cwd: string) =>
		sh(cwd, "git status --porcelain --untracked-files=all 2>/dev/null && git diff HEAD 2>/dev/null | shasum");

	pi.on("input", async () => {
		criticRuns = 0;
		auditedState = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		baseline = await fingerprint(ctx.cwd);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || event.continue || criticRuns >= MAX_CRITIC_RUNS) return;
		const top = (await sh(ctx.cwd, "git rev-parse --show-toplevel 2>/dev/null")).trim();
		if (!top) return;
		const state = await fingerprint(ctx.cwd);
		if (criticRuns > 0 && state === auditedState) pi.events.emit("check:result", { id: "review:critic", group: "review", label: "critic: самоаудит diff", status: "pass" });
		if (state === baseline || state === auditedState) return;

		const numstat = await sh(top, "git diff HEAD --numstat");
		const untracked = (await sh(top, "git ls-files --others --exclude-standard")).split("\n").filter(Boolean);
		const files = [...untracked];
		let lines = 0;
		for (const row of numstat.split("\n").filter(Boolean)) {
			const [add, del, file] = row.split("\t");
			files.push(file);
			if (!DOC_ONLY.test(file)) lines += (Number(add) || 0) + (Number(del) || 0);
		}
		if (untracked.length > 0) {
			const counted = await sh(top, "git ls-files --others --exclude-standard -z | xargs -0 cat 2>/dev/null | wc -l");
			lines += Number(counted.trim()) || 0;
		}
		const codeFiles = files.filter((f) => !DOC_ONLY.test(f));
		if (codeFiles.length === 0) return;
		if (lines < CRITIC_MIN_LINES && codeFiles.length < CRITIC_MIN_FILES && !codeFiles.some((f) => SENSITIVE.test(f))) return;

		criticRuns++;
		auditedState = state;
		pi.events.emit("check:result", { id: "review:critic", group: "review", label: "critic: самоаудит diff", status: "running" });
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "flow-skills",
					content:
						`[critic ${criticRuns}/${MAX_CRITIC_RUNS}] Before finishing, audit your own change: read ${join(SKILLS, "critic", "SKILL.md")} ` +
						"with the read tool and follow it exactly (git diff, plan/contract, RBAC/IDOR, edge cases, UI states, run the checks). " +
						"Print the report. If VERDICT is NEEDS_FIX, fix every BLOCKER now and re-run the checks. Then give the final answer with the verdict.",
					display: true,
				},
			],
			continue: true,
		};
	});
}
