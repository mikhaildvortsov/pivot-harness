// Loaded ONLY in subagents (settings.json → subagents.defaultExtensions), never in the parent.
// Every subagent starts its subtask by picking REQUIRED_SKILLS relevant skills from aas/ecc via find_skills and reading
// them fully. Writers (write/edit) are blocked until that many distinct library SKILL.md files have been read.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { isLibrarySkill } from "./lib/skill-library.ts";

const REQUIRED_SKILLS = 2;

export default function (pi: ExtensionAPI) {
	const read = new Set<string>();

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		return {
			message: {
				customType: "subagent-skills",
				display: false,
				content:
					`[subagent-skills] MANDATORY first step for this subtask: call find_skills with 5-10 English keywords for THIS subtask, ` +
					`pick exactly ${REQUIRED_SKILLS} directly relevant skills from the aas/ecc results, read each SKILL.md fully with the read tool, ` +
					"name them in one line with the reason, then do the subtask following them. Writing files is blocked until both are read. " +
					"Cost rule: every step re-sends the whole context, so batch related commands (reads, greps, test runs that do not depend on each other) into ONE bash call instead of one command per step.",
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const path = (event.input as { path?: string }).path;
		if (event.toolName === "read" && path) {
			const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
			if (isLibrarySkill(abs)) read.add(abs);
			return;
		}
		if ((event.toolName === "write" || event.toolName === "edit") && read.size < REQUIRED_SKILLS) {
			return {
				block: true,
				reason:
					`subagent-skills: read ${REQUIRED_SKILLS} relevant aas/ecc skills before writing (read so far: ${read.size}). ` +
					"Call find_skills with English keywords for this subtask, then read the two best SKILL.md files fully.",
			};
		}
	});
}
