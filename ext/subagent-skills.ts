// Skill discovery is optional; exact user/task-required skills still apply.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		return {
			message: {
				customType: "subagent-skills",
				display: false,
				content: "[subagent-skills] Read exact user/task-required skills. Otherwise skills are optional: discover and read at most two only when they materially help this subtask. No skill quota before editing. Batch independent reads/checks; inspect targeted file ranges. Preserve required tests, review and safety checks.",
			},
		};
	});
}
