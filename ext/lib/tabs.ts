// Tab mode for Ghostty: every pivot process is one tab (one chat). Each writes a small heartbeat file with its chat and status;
// the sessions panel reads them to show live status of chats open in other tabs, to jump to a tab, or to open a chat in a new tab.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TabStatus = "idle" | "working" | "done" | "error";
export type Beat = { pid: number; tty: string; session?: string; name: string; cwd: string; status: TabStatus; updated: number; since: number };

const DIR = join(homedir(), ".pi", "agent", "state", "tabs");
export const inGhostty = () => /ghostty/i.test(`${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`);

let ttyCache: string | undefined;
export function myTty(): string {
	if (ttyCache !== undefined) return ttyCache;
	try {
		const t = execFileSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 }).trim();
		ttyCache = t && t !== "??" ? `/dev/${t}` : "";
	} catch {
		ttyCache = "";
	}
	return ttyCache;
}

export function writeBeat(b: Omit<Beat, "pid" | "tty" | "updated">): void {
	try {
		mkdirSync(DIR, { recursive: true });
		writeFileSync(join(DIR, `${process.pid}.json`), JSON.stringify({ ...b, pid: process.pid, tty: myTty(), updated: Date.now() }));
	} catch {
		/* best effort */
	}
}
export function removeBeat(): void {
	try {
		unlinkSync(join(DIR, `${process.pid}.json`));
	} catch {
		/* already gone */
	}
}
/** Live heartbeats of other pivot processes (dead or stale ones are cleaned up). */
export function liveBeats(includeSelf = false): Beat[] {
	const out: Beat[] = [];
	if (!existsSync(DIR)) return out;
	for (const f of readdirSync(DIR)) {
		try {
			const b = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Beat;
			let alive = true;
			try {
				process.kill(b.pid, 0);
			} catch {
				alive = false;
			}
			if (!alive || Date.now() - b.updated > 60_000) {
				unlinkSync(join(DIR, f));
				continue;
			}
			if (includeSelf || b.pid !== process.pid) out.push(b);
		} catch {
			/* partially written file */
		}
	}
	return out;
}

const osa = (lines: string[]) => {
	try {
		return execFileSync("osascript", lines.flatMap((l) => ["-e", l]), { encoding: "utf8", timeout: 6000 }).trim();
	} catch {
		return "";
	}
};
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Brings the Ghostty tab whose terminal runs on `tty` to the front. */
export function focusTab(tty: string): boolean {
	const r = osa([
		'tell application "Ghostty"',
		"set found to false",
		"repeat with w in windows",
		"repeat with t in tabs of w",
		"repeat with term in terminals of t",
		`if tty of term is "${esc(tty)}" then`,
		"select tab t",
		"focus term",
		"set found to true",
		"exit repeat",
		"end if",
		"end repeat",
		"if found then exit repeat",
		"end repeat",
		"if found then exit repeat",
		"end repeat",
		"activate",
		"return found",
		"end tell",
	]);
	return r === "true";
}

/** Opens `pivot --session <file>` in a new tab of the front Ghostty window (or a new window). */
export function openTab(cwd: string, sessionFile: string): boolean {
	const cmd = `"$HOME/.local/bin/pivot" --session '${sessionFile.replace(/'/g, "'\\''")}'; exec "$SHELL" -l`;
	const r = osa([
		'tell application "Ghostty"',
		`set cfg to new surface configuration`,
		`set command of cfg to "${esc(cmd)}"`,
		`set initial working directory of cfg to "${esc(cwd)}"`,
		"if (count of windows) is 0 then",
		"new window with configuration cfg",
		"else",
		"new tab in front window with configuration cfg",
		"end if",
		"activate",
		"return \"ok\"",
		"end tell",
	]);
	return r === "ok";
}

/** Opens a fresh pivot chat (no session file) in a new tab of the front Ghostty window, in `cwd`. */
export function openNewTab(cwd: string): boolean {
	const cmd = `"$HOME/.local/bin/pivot"; exec "$SHELL" -l`;
	const r = osa([
		'tell application "Ghostty"',
		`set cfg to new surface configuration`,
		`set command of cfg to "${esc(cmd)}"`,
		`set initial working directory of cfg to "${esc(cwd)}"`,
		"if (count of windows) is 0 then",
		"new window with configuration cfg",
		"else",
		"new tab in front window with configuration cfg",
		"end if",
		"activate",
		'return "ok"',
		"end tell",
	]);
	return r === "ok";
}
