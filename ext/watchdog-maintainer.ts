// Keeps stream-watchdog.ts working across pi updates.
// On session start: compare the installed pi version with the last verified one (~/.pi/agent/state/watchdog.json).
// After an update (or if the completions stream cannot be resolved) it runs a live smoke test of the watchdog once;
// if that fails, it starts Opus in the background (no extensions, scoped prompt) to repair ONLY stream-watchdog.ts,
// validate the fix, and record the result. The session keeps working meanwhile; the user is notified.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCompletionsStream } from "./stream-watchdog.ts";

const AGENT = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT, "state");
const STATE = join(STATE_DIR, "watchdog.json");
const WATCHDOG = join(AGENT, "ext", "stream-watchdog.ts");
const OPUS = "anthropic/claude-opus-5-5";
const SMOKE_MODEL = "gonka/zai-org/GLM-5.3-Flash";

type State = { piVersion?: string; status?: "ok" | "repairing" | "failed"; checkedAt?: string; note?: string };

function piPackage(): { version: string; root: string } | undefined {
	// argv[1] is usually the ~/.npm-global/bin/pi symlink; resolve it to the package's real cli path.
	let dir: string;
	try {
		dir = dirname(realpathSync(process.argv[1] ?? ""));
	} catch {
		return undefined;
	}
	for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (!existsSync(pkg)) continue;
		const json = JSON.parse(readFileSync(pkg, "utf8"));
		if (json.name === "@earendil-works/pi-coding-agent") return { version: json.version, root: dir };
	}
	return undefined;
}

const readState = (): State => {
	try {
		return JSON.parse(readFileSync(STATE, "utf8"));
	} catch {
		return {};
	}
};
const writeState = (s: State) => {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(STATE, `${JSON.stringify({ ...s, checkedAt: new Date().toISOString() }, null, 2)}\n`);
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_WATCHDOG_MAINTAINER === "1") return;
	let checked = false;

	pi.on("session_start", async (_event, ctx) => {
		if (checked) return;
		checked = true;
		const pkg = piPackage();
		if (!pkg) return;
		const state = readState();
		const resolvable = resolveCompletionsStream() !== undefined;
		if (state.piVersion === pkg.version && state.status === "ok" && resolvable) return;
		const repairFresh = state.checkedAt !== undefined && Date.now() - Date.parse(state.checkedAt) < 15 * 60_000;
		// A repair that never reported back is re-validated after 15 minutes instead of blocking forever.
		if (state.status === "repairing" && state.piVersion === pkg.version && repairFresh) {
			ctx.ui.notify("watchdog-maintainer: Opus is still repairing stream-watchdog.ts (log: ~/.pi/agent/state/watchdog-fix.log)", "warning");
			return;
		}

		const env = { ...process.env, PI_WATCHDOG_MAINTAINER: "1", PI_OPUS_CHILD: "1", PI_SUBAGENT_CHILD: "1" };
		const cli = realpathSync(process.argv[1] ?? "");
		const smoke = resolvable
			? await pi.exec("env", ["PI_WATCHDOG_MAINTAINER=1", "PI_OPUS_CHILD=1", "PI_SUBAGENT_CHILD=1", process.execPath, cli, "-ne", "-e", WATCHDOG, "--no-session", "-p", "--model", SMOKE_MODEL, "Reply with exactly: ok"], { timeout: 180_000 })
			: { code: 1, stdout: "", stderr: "completions stream not resolvable", killed: false, truncated: false };
		if (smoke.code === 0 && /\bok\b/i.test(smoke.stdout)) {
			writeState({ piVersion: pkg.version, status: "ok", note: `smoke passed after ${state.piVersion ?? "first run"} → ${pkg.version}` });
			return;
		}

		mkdirSync(STATE_DIR, { recursive: true });
		copyFileSync(WATCHDOG, join(STATE_DIR, `stream-watchdog.backup-${Date.now()}.ts`));
		writeState({ piVersion: pkg.version, status: "repairing", note: (smoke.stderr || smoke.stdout).slice(-1500) });
		const prompt = [
			`pi was updated from ${state.piVersion ?? "unknown"} to ${pkg.version} and the extension ${WATCHDOG} no longer works.`,
			`Smoke test output:\n${(smoke.stderr || smoke.stdout).slice(-3000)}`,
			"Task: repair ONLY that file so it works with the installed pi, keeping its behavior (hedging, stall/slow aborts with transient errors, consecutive-abort relaxation, provider 'gonka' with api 'gonka-watchdog').",
			`Read: the file itself; ${pkg.root}/CHANGELOG.md (recent entries); ${pkg.root}/docs/custom-provider.md and docs/extensions.md; the .d.ts files under ${pkg.root}/node_modules/@earendil-works/pi-ai/dist/ for the current openai-completions streaming API and createAssistantMessageEventStream.`,
			"Constraints: edit no other file; extensions may import only '@earendil-works/pi-ai/compat' and '@earendil-works/pi-coding-agent' (subpath imports do not resolve); keep the exported resolveCompletionsStream() function (watchdog-maintainer imports it).",
			`Validate before finishing: (1) \`pi -ne -e ${WATCHDOG} --list-models gonka\` loads without errors; (2) \`PI_WATCHDOG_MAINTAINER=1 pi -ne -e ${WATCHDOG} --no-session -p --model ${SMOKE_MODEL} "Reply with exactly: ok"\` prints ok; (3) same with PI_WATCHDOG_HEDGE_MS=1 (forced hedge) prints ok.`,
			`Finally write ${STATE} as JSON {"piVersion":"${pkg.version}","status":"ok"|"failed","note":"<what you changed or why it failed>"}.`,
		].join("\n\n");
		const log = openSync(join(STATE_DIR, "watchdog-fix.log"), "a");
		const child = spawn(process.execPath, [cli, "-ne", "--no-session", "-p", "--model", OPUS, "--thinking", "high", "--tools", "read,edit,bash,grep,find,ls", prompt], {
			cwd: AGENT,
			env,
			detached: true,
			stdio: ["ignore", log, log],
		});
		child.unref();
		ctx.ui.notify(`watchdog-maintainer: pi ${pkg.version} broke stream-watchdog.ts; Opus is repairing it in the background (log: ~/.pi/agent/state/watchdog-fix.log)`, "warning");
	});
}
