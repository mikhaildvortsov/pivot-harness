// Delegation is a complexity decision, not a plan-item quota.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1") return;
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		return { message: {
			customType: "delegation-policy",
			display: false,
			content: "[delegation] Honor explicit user/repository delegation rules. Otherwise delegate only when independent ownership, complexity or required review justifies the cost; plan-item count alone never blocks direct work.",
		} };
	});
}
