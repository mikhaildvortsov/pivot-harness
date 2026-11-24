// Final delivery step, like the Claude feature-task "Ship" phase: once every earlier gate is satisfied (no gate asked for
// another turn), a task that changed code in a git repo with a remote is shipped via the ship-pr skill: task branch,
// rebase, push, draft PR, verified head SHA, CI status. Never merges. Must be the LAST extension in settings.json.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL = join(homedir(), ".pi", "agent", "skills", "ship-pr", "SKILL.md");
const OPT_OUT = /не\s*пуш|без\s*(pr|пр\b|пулл?\s*реквест|пуша)|не\s*(создавай|открывай)\s*(pr|пр\b)|не\s*коммит|только\s*локально|no\s*pr\b|don'?t\s*push|do\s*not\s*push|local\s*only/i;
const DOC_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|svg)$|(^|\/)(\.pi\/context)\//i;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1") return;
	let optOut = false;
	let requested = false;
	let baseline = "";

	const sh = async (cwd: string, script: string) => (await pi.exec("bash", ["-c", script], { cwd, timeout: 30_000 })).stdout.trim();

	pi.on("input", async (event) => {
		const text = (event as { text?: string }).text ?? "";
		optOut = OPT_OUT.test(text);
		requested = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType === "user") {
			if (OPT_OUT.test(event.prompt)) optOut = true;
			baseline = await sh(ctx.cwd, "git rev-parse HEAD 2>/dev/null; git status --porcelain --untracked-files=all 2>/dev/null");
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || event.continue || requested || optOut) return;
		const top = await sh(ctx.cwd, "git rev-parse --show-toplevel 2>/dev/null");
		if (!top || !(await sh(top, "git remote"))) return;
		const now = await sh(top, "git rev-parse HEAD 2>/dev/null; git status --porcelain --untracked-files=all 2>/dev/null");
		if (now === baseline) return;
		const changed = (await sh(top, `git status --porcelain --untracked-files=all | cut -c4-; git diff --name-only ${baseline.split("\n")[0] || "HEAD"}..HEAD 2>/dev/null`))
			.split("\n")
			.filter(Boolean);
		if (changed.length === 0 || changed.every((f) => DOC_ONLY.test(f))) return;
		requested = true;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "ship-gate",
					content:
						`[ship] All gates passed. Deliver the task now: read ${SKILL} with the read tool and follow it exactly ` +
						"(task branch, explicit staging, Conventional Commit without AI trailers, rebase on fresh base, push without force, " +
						"DRAFT PR, verify head SHA, report real CI status). Never merge. If a precondition fails, do not ship — report why.",
					display: true,
				},
			],
			continue: true,
		};
	});
}
