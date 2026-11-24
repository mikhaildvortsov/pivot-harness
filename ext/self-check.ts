// Harness self-check after pi updates. On session start: if the installed pi version differs from the last diagnosed one,
// run doctor/doctor.mjs in the background (detached, log in state/doctor.log) and announce the result once it exists.
// /doctor runs the same diagnostics now and shows the summary. Report: ~/.pi/agent/state/diagnostics/*.md
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piPackage } from "./lib/pi-package.ts";

const AGENT = join(homedir(), ".pi", "agent");
const STATE = join(AGENT, "state");
const DIAG = join(STATE, "diag.json");
const LOCK = join(STATE, "doctor.lock");
const DOCTOR = join(AGENT, "doctor", "doctor.mjs");
const LOCK_TTL_MS = 20 * 60_000;

type Diag = { piVersion?: string; ts?: string; status?: "ok" | "warn" | "fail"; failed?: string[]; warned?: string[]; report?: string; announced?: boolean };
const readDiag = (): Diag => {
	try {
		return JSON.parse(readFileSync(DIAG, "utf8"));
	} catch {
		return {};
	}
};
const lockedNow = () => existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < LOCK_TTL_MS;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_DOCTOR_RUN === "1" || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_WATCHDOG_MAINTAINER === "1") return;
	const pkg = piPackage();
	if (!pkg || !existsSync(DOCTOR)) return;
	const doctorArgs = (prev: string) => [DOCTOR, "--cli", pkg.cli, "--root", pkg.root, "--version", pkg.version, "--prev", prev];

	pi.on("session_start", async (_e, ctx) => {
		const diag = readDiag();
		if (diag.piVersion === pkg.version) {
			if (diag.status && diag.status !== "ok" && !diag.announced && diag.report) {
				ctx.ui.notify(`Диагностика харнеса (pi ${pkg.version}): ${diag.status.toUpperCase()}. Проблемы: ${[...(diag.failed ?? []), ...(diag.warned ?? [])].join(", ")}. Отчёт: ${diag.report}`, diag.status === "fail" ? "error" : "warning");
				writeFileSync(DIAG, JSON.stringify({ ...diag, announced: true }, null, 2));
			}
			return;
		}
		if (lockedNow()) return;
		mkdirSync(STATE, { recursive: true });
		writeFileSync(LOCK, String(Date.now()));
		const log = openSync(join(STATE, "doctor.log"), "a");
		spawn(process.execPath, doctorArgs(diag.piVersion ?? "none"), { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
		ctx.ui.notify(`pi ${diag.piVersion ? `обновился ${diag.piVersion} → ${pkg.version}` : `${pkg.version}: первая проверка`}: запускаю диагностику харнеса в фоне (2-4 минуты). Результат покажу при следующем запуске.`, "info");
	});

	pi.registerCommand("doctor", {
		description: "Диагностика харнеса сейчас (2-4 минуты): модели, инструменты, защиты, конфиг",
		handler: async (_args, ctx) => {
			if (lockedNow()) return ctx.ui.notify("Диагностика уже идёт (state/doctor.lock)", "warning");
			mkdirSync(STATE, { recursive: true });
			writeFileSync(LOCK, String(Date.now()));
			ctx.ui.notify("Диагностика запущена, подожди 2-4 минуты…", "info");
			const r = await pi.exec(process.execPath, doctorArgs(readDiag().piVersion ?? "none"), { timeout: 15 * 60_000 });
			const line = r.stdout.trim().split("\n").pop() ?? "нет вывода";
			ctx.ui.notify(line, /^FAIL/.test(line) ? "error" : /^WARN/.test(line) ? "warning" : "info");
		},
	});
}
