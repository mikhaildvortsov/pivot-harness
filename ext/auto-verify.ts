// Before the agent may settle: if this run changed the git working tree, run a fast typecheck/lint for the detected stack.
// On failure, feed the output back and continue the run (max 2 auto-retries per user task).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_RETRIES = 2;
const TIMEOUT_MS = 5 * 60_000;
const DOC_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|svg)$|(^|\/)(specs|docs|\.specify|\.pi\/context)\//i;

type Check = { dir: string; cmd: string };

function scripts(dir: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
	} catch {
		return {};
	}
}

function checksFor(root: string, rel: string): Check[] {
	const dir = join(root, rel);
	const out: Check[] = [];
	if (existsSync(join(dir, "package.json"))) {
		const s = scripts(dir);
		if (s.typecheck) out.push({ dir: rel, cmd: "npm run -s typecheck" });
		else if (existsSync(join(dir, "tsconfig.json"))) out.push({ dir: rel, cmd: "npx --no-install tsc --noEmit -p ." });
		if (s.lint) out.push({ dir: rel, cmd: "npm run -s lint" });
	} else if (existsSync(join(dir, "tsconfig.json"))) {
		out.push({ dir: rel, cmd: "npx --no-install tsc --noEmit -p ." });
	}
	if (existsSync(join(dir, "pyproject.toml"))) {
		out.push({ dir: rel, cmd: "if command -v ruff >/dev/null; then ruff check .; else python3 -m compileall -q .; fi" });
	}
	return out;
}

function detect(root: string, changed: string[]): Check[] {
	const candidates = new Set<string>();
	for (const sub of ["frontend", "backend"]) if (existsSync(join(root, sub))) candidates.add(sub);
	// Monorepo packages touched by the change (apps/web, packages/x, ...): nearest dir with a manifest.
	for (const file of changed) {
		const parts = file.split("/");
		for (let i = parts.length - 1; i >= 1; i--) {
			const rel = parts.slice(0, i).join("/");
			if (["package.json", "tsconfig.json", "pyproject.toml"].some((m) => existsSync(join(root, rel, m)))) {
				candidates.add(rel);
				break;
			}
		}
	}
	const touched = [...candidates].filter((c) => changed.some((f) => f.startsWith(`${c}/`)));
	const dirs = touched.length > 0 ? touched : candidates.size === 0 ? ["."] : [];
	return dirs.flatMap((d) => checksFor(root, d));
}

export default function (pi: ExtensionAPI) {
	let retries = 0;
	let lastFailure = "";
	let baseline: string | undefined;

	// Fingerprint of the working tree; pre-existing dirty state alone must not trigger checks.
	const fingerprint = async (cwd: string) => {
		// Untracked files are hashed by content: `git diff HEAD` ignores them and `status` collapses new dirs.
		const script =
			"git status --porcelain --untracked-files=all && git diff HEAD | shasum && " +
			"git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null | shasum";
		const r = await pi.exec("bash", ["-c", script], { cwd, timeout: 30_000 });
		return r.code === 0 ? r.stdout : undefined;
	};

	pi.on("input", async () => {
		retries = 0;
		lastFailure = "";
	});

	pi.on("agent_start", async (_event, ctx) => {
		baseline = await fingerprint(ctx.cwd);
	});

	// agent_before_settle (not agent_end): the last point where pi lets an extension request another turn;
	// agent_end + sendMessage is dropped in print/JSON mode because the process exits first.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 10_000 });
		if (top.code !== 0) return;
		const root = top.stdout.trim();
		if (lastFailure === "" && baseline !== undefined && (await fingerprint(ctx.cwd)) === baseline) return;
		const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, timeout: 30_000 });
		const changed = status.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(3).split(" -> ").pop() ?? "");
		// Docs/spec-only changes need no code checks.
		if (changed.every((f) => DOC_ONLY.test(f))) return;

		const failures: string[] = [];
		for (const c of detect(root, changed)) {
			const id = `verify:${c.dir}:${c.cmd}`;
			const label = `${c.dir === "." ? "" : `${c.dir}: `}${c.cmd.replace(/^npm run -s /, "").replace(/^npx --no-install /, "").split(" ")[0] === "tsc" ? "tsc" : c.cmd.replace(/^npm run -s /, "").slice(0, 40)}`;
			pi.events.emit("check:result", { id, group: "code", label, status: "running" });
			const r = await pi.exec("bash", ["-lc", c.cmd], { cwd: join(root, c.dir), timeout: TIMEOUT_MS });
			if (r.code !== 0) {
				const out = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-60).join("\n");
				failures.push(`$ (cd ${c.dir} && ${c.cmd})  → exit ${r.code}${r.killed ? " (timeout)" : ""}\n${out}`);
				pi.events.emit("check:result", { id, group: "code", label, status: "fail", detail: out.split("\n").slice(-12).join("\n") });
			} else pi.events.emit("check:result", { id, group: "code", label, status: "pass" });
		}
		if (failures.length === 0) {
			lastFailure = "";
			return;
		}
		const report = failures.join("\n\n");
		if (retries >= MAX_RETRIES) {
			if (report !== lastFailure) ctx.ui.notify(`auto-verify: checks still failing after ${MAX_RETRIES} retries`, "warning");
			lastFailure = report;
			return;
		}
		retries++;
		lastFailure = report;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "auto-verify",
					content:
						`[auto-verify ${retries}/${MAX_RETRIES}] Uncommitted changes fail verification. Fix the root cause ` +
						`(do not suppress, skip or delete checks), re-run the command yourself, then report the result.\n\n${report}`,
					display: true,
				},
			],
			continue: true,
		};
	});
}
