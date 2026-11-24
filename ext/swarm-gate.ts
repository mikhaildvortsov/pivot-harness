// Mandatory swarm for big plans: if the agent wrote a plan in this task with more than MAX_SOLO_SUBTASKS subtasks and has
// not dispatched any subagent yet, writing code is blocked until it delegates via the `subagent` tool (pi-subagents).
// After the first `subagent` call the parent may edit code again (integration, review fixes).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const MAX_SOLO_SUBTASKS = 3;
const DOC_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|svg|json|ya?ml)$|(^|\/)(specs|docs|\.specify|\.pi\/context)\//i;
const PLAN_DIRS = ["docs/superpowers/plans", "docs/plans"];
const TASK_HEADING = /^#{2,4}\s*(?:task|step|subtask|задача|шаг|подзадача)\s*\d+/gim;
const PLAN_SECTION = /^##\s*(?:plan|план|steps|шаги|tasks|задачи|подзадачи)\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im;

function countSubtasks(text: string): number {
	const headings = text.match(TASK_HEADING)?.length ?? 0;
	const section = text.match(PLAN_SECTION)?.[1] ?? "";
	const numbered = section.match(/^\d+[.)]\s/gm)?.length ?? 0;
	return Math.max(headings, numbered);
}

function plansSince(root: string, since: number): Array<{ path: string; subtasks: number }> {
	const files = [join(root, ".pi", "context", "plan.md")];
	for (const dir of PLAN_DIRS) {
		const abs = join(root, dir);
		if (existsSync(abs)) for (const f of readdirSync(abs)) if (f.endsWith(".md")) files.push(join(abs, f));
	}
	return files
		.filter((f) => existsSync(f) && statSync(f).mtimeMs >= since)
		.map((f) => ({ path: f, subtasks: countSubtasks(readFileSync(f, "utf8")) }));
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1") return;
	let taskStart = Date.now();
	let delegated = false;

	pi.on("input", async () => {
		taskStart = Date.now();
		delegated = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent") {
			delegated = true;
			return;
		}
		if (delegated || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = (event.input as { path?: string }).path ?? "";
		if (!path || DOC_ONLY.test(path)) return;
		const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 10_000 });
		const root = top.code === 0 ? top.stdout.trim() : ctx.cwd;
		const big = plansSince(root, taskStart).find((p) => p.subtasks > MAX_SOLO_SUBTASKS);
		if (!big) return;
		const target = isAbsolute(path) ? path : resolve(ctx.cwd, path);
		return {
			block: true,
			reason:
				`swarm-gate: the plan ${big.path} has ${big.subtasks} subtasks (> ${MAX_SOLO_SUBTASKS}), so implementation must go through the swarm. ` +
				`Do not write ${target} yourself. Follow superpowers subagent-driven-development: dispatch one \`worker\` per subtask with the \`subagent\` tool ` +
				"(parallel `tasks` only for disjoint files; dependent subtasks one after another), then a `reviewer`. " +
				"After the first subagent call you may edit code for integration and review fixes.",
		};
	});
}
