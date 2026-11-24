// Read-only access to the Claude Code project memory (~/.claude/projects/<encoded repo path>/memory).
// Only the MEMORY.md index (one line per fact, ~1k tokens) goes into the system prompt; the model reads a memory file
// only when its line is relevant. Works from git worktrees too (resolves the main checkout via --git-common-dir).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROJECTS = join(homedir(), ".claude", "projects");
const encode = (p: string) => p.replace(/[/_.]/g, "-");

function findMemoryDir(paths: string[]): string | undefined {
	for (const start of paths) {
		let dir = resolve(start);
		while (true) {
			const candidate = join(PROJECTS, encode(dir), "memory");
			if (existsSync(join(candidate, "MEMORY.md"))) return candidate;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1") return;

	pi.on("before_agent_start", async (event, ctx) => {
		const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ctx.cwd, timeout: 10_000 });
		const mainCheckout = common.code === 0 ? dirname(common.stdout.trim()) : undefined;
		const memDir = findMemoryDir([ctx.cwd, ...(mainCheckout ? [mainCheckout] : [])]);
		if (!memDir) return;
		const lines = readFileSync(join(memDir, "MEMORY.md"), "utf8")
			.split("\n")
			.filter((l) => l.trim().startsWith("- "))
			.filter((l) => {
				const file = l.match(/\]\(([^)]+\.md)\)/)?.[1];
				return !file || existsSync(join(memDir, file));
			});
		if (lines.length === 0) return;
		const section =
			"\n\n# Project memory (from Claude Code, read-only)\n" +
			`Durable facts and user decisions for this project. Files live in ${memDir}. When a line is relevant to the task, ` +
			"read that file before acting. Project rules here and in AGENTS.md override defaults. Status lines may be outdated: " +
			"verify against git/GitHub before relying on them. Never write to this directory.\n" +
			lines.join("\n");
		return { systemPrompt: event.systemPrompt + section };
	});
}
