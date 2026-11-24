// Agents must not modify the harness itself (~/.pi/agent: settings, models, extensions, skills, packages).
// Reading is allowed. The user changes the harness, not the agent working on a task.
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const AGENT_DIR = resolve(homedir(), ".pi", "agent");
// Claude Code project memory is read by project-memory.ts; agents must not edit it either.
const CLAUDE_MEMORY = new RegExp(`^${resolve(homedir(), ".claude", "projects").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+/memory(/|$)`);
const MENTIONS_DIR = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.pi\/agent\b|\.pi\/agent\/|\.claude\/projects\/[^/\s]+\/memory/;
const MUTATING = /(^|[\s;&|(])(>>?|tee|sed\s+-[a-z]*i|perl\s+-[a-z]*i|mv|cp|rm|rmdir|chmod|chown|ln|touch|mkdir|truncate|install|rsync|unzip|tar\s+-?x|jq\b[^|]*>)(\s|$)|>{1,2}\s*\S*\.pi\/agent/;
const HARNESS_CMD = /\bpi\s+(install|remove|uninstall|update|config)\b/;
const REASON =
	"config-guard: the agent must not modify the pi harness (~/.pi/agent) or the Claude project memory. If the harness config blocks the task, stop and tell the user the exact change needed.";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			const cmd = event.input.command;
			if (HARNESS_CMD.test(cmd) || (MENTIONS_DIR.test(cmd) && MUTATING.test(cmd))) return { block: true, reason: REASON };
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = (event.input as { path?: string }).path;
		if (!path) return;
		const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path.replace(/^~(?=\/)/, homedir()));
		const target = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : abs;
		if (target === AGENT_DIR || target.startsWith(`${AGENT_DIR}/`) || CLAUDE_MEMORY.test(target)) return { block: true, reason: REASON };
	});
}
