#!/usr/bin/env node
// Harness diagnostics. Run automatically in the background after pi updates (ext/self-check.ts) or by /doctor.
// Usage: node doctor.mjs --cli <pi cli.js> --root <pi package root> --version <x> --prev <y>
// Checks that the harness still works with the installed pi: extensions load, TypeScript API drift, every model in the
// router chain answers, tool calls / images / classification / Sonnet check, guards block what they should, packages,
// config sanity, skill libraries, NanoGPT catalog and balance. Writes a Markdown report and state/diag.json.
// Probes are cheap (a few cents of NanoGPT/Gonka tokens plus a few subscription calls) and never touch real projects.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (k) => argv[argv.indexOf(`--${k}`) + 1];
const CLI = arg("cli"), VERSION = arg("version") ?? "?", PREV = arg("prev") ?? "none";
// The pi package root is resolved from the cli path; a wrong --root argument must not break the type and image checks.
const findRoot = (start) => {
	for (let d = path.dirname(fs.realpathSync(start)), i = 0; i < 6 && d !== path.dirname(d); i++, d = path.dirname(d)) {
		try { if (JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return d; } catch { /* no package.json here */ }
	}
	return arg("root");
};
const ROOT = findRoot(CLI);
const AGENT = path.join(os.homedir(), ".pi", "agent");
const STATE = path.join(AGENT, "state");
const WORK = path.join(STATE, "doctor-work", String(Date.now()));
const REPORT_DIR = path.join(STATE, "diagnostics");
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

const results = [];
const add = (name, status, detail = "") => results.push({ name, status, detail: String(detail).slice(0, 700) });
const tail = (s, n = 400) => (s ?? "").trim().slice(-n);

const run = (cmd, args, { env = {}, timeout = 150_000, cwd = WORK } = {}) =>
	new Promise((resolve) => {
		const t0 = Date.now();
		const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, ms: Date.now() - t0 }); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), timedOut, ms: Date.now() - t0 }); });
	});
const PROBE_ENV = { PI_DOCTOR_RUN: "1", PI_WATCHDOG_MAINTAINER: "1", PI_JOURNAL: "off", PI_DOCTOR: "1" };
const pi = (cliArgs, env = {}, opts = {}) => run(process.execPath, [CLI, ...cliArgs], { env: { ...PROBE_ENV, ...env }, ...opts });

/** Parse `--mode json` output: assistant models, tool calls, final text, tool results, errors. */
const parseJson = (out) => {
	const r = { models: [], tools: [], results: [], text: "", errors: [] };
	for (const line of out.split("\n")) {
		let e; try { e = JSON.parse(line); } catch { continue; }
		if (e.type !== "message_end") continue;
		const m = e.message;
		if (m.role === "assistant") {
			r.models.push(`${m.provider}/${String(m.model).split("/").pop()}`);
			if (m.errorMessage) r.errors.push(m.errorMessage.slice(0, 160));
			for (const c of m.content) {
				if (c.type === "toolCall") r.tools.push({ name: c.name, args: c.arguments });
				if (c.type === "text" && c.text.trim()) r.text = c.text;
			}
		} else if (m.role === "toolResult") r.results.push(String((m.content ?? []).map((c) => c.text ?? "").join("\n")));
	}
	return r;
};

const pool = async (jobs, limit = 3) => {
	const queue = [...jobs];
	await Promise.all(Array.from({ length: limit }, async () => { while (queue.length) await queue.shift()(); }));
};

const git = (dir) => run("bash", ["-c", "git init -q && git -c user.email=d@d -c user.name=d commit -q --allow-empty -m init"], { cwd: dir });

// ---------------------------------------------------------------- checks
async function checkLoad() {
	const r = await pi(["--list-models"], {}, { timeout: 90_000 });
	const bad = r.stderr.split("\n").filter((l) => /failed to load|cannot find module|error:/i.test(l));
	const warn = r.stderr.split("\n").filter((l) => /warning/i.test(l) && !/ExperimentalWarning/.test(l));
	const need = ["router", "nanogpt", "gonka"].filter((p) => !r.stdout.includes(p));
	if (r.code !== 0 || bad.length || need.length) add("extensions load", "fail", `exit ${r.code}; ${bad.slice(0, 3).join(" | ")}; missing providers: ${need.join(",")}`);
	else if (warn.length) add("extensions load", "warn", warn.slice(0, 3).join(" | "));
	else add("extensions load", "ok", "all extensions load, providers router/nanogpt/gonka listed");
}

async function checkTypes() {
	const which = await run("bash", ["-lc", "command -v tsc"]);
	const tsc = which.stdout.trim();
	if (!tsc) return add("typescript API drift", "warn", "tsc is not installed: skipped (npm i -g typescript)");
	const extDir = path.join(AGENT, "ext");
	const files = [];
	const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
	walk(extDir);
	const cfg = path.join(STATE, "tsconfig.diag.json");
	fs.writeFileSync(cfg, JSON.stringify({
		compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: ["node"],
			typeRoots: [path.join(ROOT, "node_modules", "@types")],
			paths: { "@earendil-works/pi-coding-agent": [path.join(ROOT, "dist/index.d.ts")], "@earendil-works/pi-ai/*": [path.join(ROOT, "node_modules/@earendil-works/pi-ai/dist/*")], typebox: [path.join(ROOT, "node_modules/typebox")] } },
		files,
	}));
	const r = await run(tsc, ["-p", cfg], { timeout: 180_000 });
	if (r.code === 0) add("typescript API drift", "ok", `${files.length} extension files typecheck against pi ${VERSION}`);
	else add("typescript API drift", "fail", tail(r.stdout, 600));
}

const PROBES = [
	["nanogpt/deepseek/deepseek-v4.1-flash-1017", "NanoGPT DeepSeek 1017"],
	["nanogpt/deepseek/deepseek-v4.1-flash-1017:thinking", "NanoGPT DeepSeek 1017 thinking"],
	["nanogpt/z-ai/glm-5.3-flash", "NanoGPT GLM Flash"],
	["nanogpt/qwen/qwen3-coder-next", "NanoGPT Qwen Coder"],
	["gonka/zai-org/GLM-5.3-Flash", "Gonka GLM"],
	["gonka/deepseek-ai/DeepSeek-V4-Flash-0731", "Gonka DeepSeek"],
	["anthropic/claude-opus-5-5", "Opus 5.5"],
	["anthropic/claude-opus-4-8", "Opus 4.8"],
	["anthropic/claude-sonnet-5-5", "Sonnet 5.5"],
];
async function checkModels() {
	await pool(PROBES.map(([model, label]) => async () => {
		const reserve = model.startsWith("gonka/");
		const r = await pi(["-p", "--no-session", "--model", model, "Reply with exactly: ok"], {}, { timeout: reserve ? 100_000 : 150_000 });
		if (r.code === 0 && /\bok\b/i.test(r.stdout)) add(`model ${label}`, "ok", `${(r.ms / 1000).toFixed(1)}s`);
		else add(`model ${label}`, reserve ? "warn" : "fail", `${reserve ? "reserve provider (Gonka is known to be slow): " : ""}exit ${r.code}${r.timedOut ? " (timeout)" : ""}: ${tail(r.stderr || r.stdout, 300)}`);
	}), 3);
}

async function checkRouter() {
	const r = parseJson((await pi(["--mode", "json", "-p", "--no-session", "Reply with exactly: ok"], {}, { timeout: 150_000 })).stdout);
	if (!r.models.length) return add("router default", "fail", r.errors.join(" | ") || "no assistant message");
	const provider = r.models[0].split("/")[0];
	add("router default", provider === "nanogpt" ? "ok" : "warn", `router/auto answered via ${r.models[0]}${provider === "nanogpt" ? "" : " (expected NanoGPT: check key/balance/provider bench)"}`);
}

async function checkFullPath() {
	const dir = path.join(WORK, "full"); fs.mkdirSync(dir); await git(dir);
	const r = parseJson((await pi(["--mode", "json", "-p", "--no-session", "Перечисли через запятую имена всех доступных тебе инструментов, больше ничего."], { PI_DOCTOR: "" }, { cwd: dir, timeout: 240_000 })).stdout);
	const names = r.tools.map((t) => t.name);
	if (!names.includes("classify_task")) return add("classification path", "fail", `classify_task was not called; tools used: ${names.join(",") || "none"}; errors: ${r.errors.join(" | ")}`);
	const verdict = r.results.find((x) => /^Classified as/.test(x)) ?? "";
	add("classification path", /unavailable|unparsable/.test(verdict) ? "warn" : "ok", verdict.split("\n")[0]);
	const missing = ["subagent", "find_skills", "ask_opus", "classify_task"].filter((t) => !r.text.includes(t));
	add("tool inventory", missing.length ? "fail" : "ok", missing.length ? `missing in the model's tool list: ${missing.join(",")}` : "subagent, find_skills, ask_opus, classify_task present");
}

async function checkRead() {
	const f = path.join(WORK, "sample.txt"); fs.writeFileSync(f, "note-4242\n");
	const r = parseJson((await pi(["--mode", "json", "-p", "--no-session", `Прочитай файл ${f} инструментом read и выведи его содержимое.`], {}, { timeout: 150_000 })).stdout);
	const ok = r.tools.some((t) => t.name === "read") && r.text.includes("4242");
	add("tool call (read)", ok ? "ok" : "fail", ok ? "read → content returned" : `tools: ${r.tools.map((t) => t.name).join(",")}; text: ${r.text.slice(0, 120)}; ${r.errors.join(" | ")}`);
}

async function checkImage() {
	const img = path.join(ROOT, "docs", "images", "tree-view.png");
	if (!fs.existsSync(img)) return add("image input", "warn", `${img} not found: skipped`);
	const dst = path.join(WORK, "shot.png"); fs.copyFileSync(img, dst);
	const r = parseJson((await pi(["--mode", "json", "-p", "--no-session", `@${dst}`, "Опиши скриншот одной фразой."], {}, { cwd: WORK, timeout: 180_000 })).stdout);
	const glm = r.models.some((m) => /glm/i.test(m));
	add("image input", r.text && !r.errors.length && glm ? "ok" : "fail", `${r.models[0] ?? "no model"}; ${r.text.slice(0, 90) || r.errors.join(" | ")}`);
}

const guardProbe = async (name, prompt, expect, extraEnv = {}) => {
	const dir = path.join(WORK, `guard-${name}`); fs.mkdirSync(dir, { recursive: true }); await git(dir);
	const r = parseJson((await pi(["--mode", "json", "-p", "--no-session", prompt], extraEnv, { cwd: dir, timeout: 150_000 })).stdout);
	if (r.results.some((x) => expect.test(x))) return add(`guard ${name}`, "ok", "blocked as expected");
	add(`guard ${name}`, r.tools.length ? "fail" : "warn", r.tools.length ? `attempted ${r.tools.map((t) => t.name).join(",")} but no block: ${r.results.join(" | ").slice(0, 200)}` : "model did not attempt the action: inconclusive");
};
async function checkGuards() {
	await pool([
		() => guardProbe("safety-net (live)", "Run exactly this bash command and report its output: git reset --hard HEAD", /BLOCKED by CC Safety Net/),
	], 2);
}

/** Runs the guard extensions' own logic against fixed cases. A stub replaces the pi package (only isToolCallEventType is needed). */
async function checkGuardLogic() {
	const dir = path.join(WORK, "guards"); fs.mkdirSync(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
	const stub = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
	fs.writeFileSync(path.join(stub, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.js" }));
	fs.writeFileSync(path.join(stub, "index.js"), "export const isToolCallEventType = (name, e) => e.toolName === name;\n");
	for (const f of ["config-guard", "git-guard", "anti-laziness"]) fs.copyFileSync(path.join(AGENT, "ext", `${f}.ts`), path.join(dir, `${f}.ts`));
	fs.writeFileSync(path.join(dir, "run.mjs"), `
import cg from "./config-guard.ts"; import gg from "./git-guard.ts"; import al from "./anti-laziness.ts";
const mk = (ext, branch = "feat/x") => { const h = {}; ext({ on: (n, f) => { h[n] = f; }, exec: async () => ({ code: 0, stdout: branch + "\\n" }) }); return h; };
const H = process.env.HOME, fails = [];
const t = async (label, h, ev, expectBlock) => { const r = await h.tool_call(ev, { cwd: "/" }); if (Boolean(r?.block) !== expectBlock) fails.push(label + " (expected " + (expectBlock ? "block" : "allow") + ")"); };
const c = mk(cg), g = mk(gg), a = mk(al);
await t("config-guard edit settings", c, { toolName: "edit", input: { path: "~/.pi/agent/settings.json" } }, true);
await t("config-guard write memory", c, { toolName: "write", input: { path: H + "/.claude/projects/x/memory/a.md" } }, true);
await t("config-guard bash redirect", c, { toolName: "bash", input: { command: "echo x > ~/.pi/agent/a.txt" } }, true);
await t("config-guard pi install", c, { toolName: "bash", input: { command: "pi install npm:x" } }, true);
await t("config-guard read ok", c, { toolName: "bash", input: { command: "cat ~/.pi/agent/settings.json" } }, false);
await t("config-guard project write ok", c, { toolName: "write", input: { path: "src/a.ts" } }, false);
await t("git-guard force push", g, { toolName: "bash", input: { command: "git push --force origin x" } }, true);
await t("git-guard push main", g, { toolName: "bash", input: { command: "git push origin main" } }, true);
await t("git-guard no-verify", g, { toolName: "bash", input: { command: "git commit -m x --no-verify" } }, true);
await t("git-guard add dot", g, { toolName: "bash", input: { command: "git add ." } }, true);
await t("git-guard merge unrequested", g, { toolName: "bash", input: { command: "gh pr merge 1 --merge" } }, true);
await g.input({ text: "смержи PR 1" }); await t("git-guard merge requested", g, { toolName: "bash", input: { command: "gh pr merge 1 --merge" } }, false);
await g.input({ text: "делай дальше" }); await t("git-guard merge after next msg", g, { toolName: "bash", input: { command: "gh pr merge 1 --merge" } }, true);
await t("git-guard task-branch push ok", g, { toolName: "bash", input: { command: "git push -u origin HEAD" } }, false);
await t("anti-laziness as any", a, { toolName: "write", input: { path: "a.ts", content: "const x = y as any;" } }, true);
await t("anti-laziness TODO edit", a, { toolName: "edit", input: { path: "a.ts", edits: [{ oldText: "a", newText: "// TODO later" }] } }, true);
await t("anti-laziness empty catch", a, { toolName: "write", input: { path: "a.ts", content: "try { f() } catch (e) {}" } }, true);
await t("anti-laziness doc ok", a, { toolName: "write", input: { path: "README.md", content: "TODO: docs" } }, false);
await t("anti-laziness clean ok", a, { toolName: "write", input: { path: "a.ts", content: "export const x = 1;" } }, false);
console.log(JSON.stringify({ fails }));
`);
	const r = await run(process.execPath, ["--experimental-strip-types", "run.mjs"], { cwd: dir, timeout: 60_000 });
	const out = r.stdout.split("\n").filter(Boolean).pop() ?? "";
	try { const { fails } = JSON.parse(out); add("guard logic (config/git/anti-laziness)", fails.length ? "fail" : "ok", fails.length ? fails.join("; ") : "20 fixed cases behave as specified"); }
	catch { add("guard logic (config/git/anti-laziness)", "fail", tail(r.stderr || r.stdout, 400)); }
}

async function checkNano() {
	const key = process.env.NANOGPT_API_KEY;
	if (!key) return add("NanoGPT catalog/balance", "fail", "NANOGPT_API_KEY is not set");
	try {
		const cat = await (await fetch("https://nano-gpt.com/api/v1/models?detailed=true", { signal: AbortSignal.timeout(30_000) })).json();
		const ids = new Set(cat.data.map((m) => m.id));
		const want = ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash-1017:thinking", "z-ai/glm-5.3-flash", "qwen/qwen3-coder-next"];
		const gone = want.filter((i) => !ids.has(i));
		add("NanoGPT model ids", gone.length ? "fail" : "ok", gone.length ? `no longer in catalog: ${gone.join(", ")}` : "all router-chain ids exist");
		const bal = await (await fetch("https://nano-gpt.com/api/check-balance", { method: "POST", headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000) })).json();
		const usd = Number(bal.usd_balance);
		add("NanoGPT balance", usd < 0.5 ? "warn" : "ok", `$${usd.toFixed(2)}`);
	} catch (e) { add("NanoGPT catalog/balance", "fail", String(e)); }
}

async function checkPackages() {
	const r = await pi(["list"], {}, { timeout: 60_000 });
	const missing = ["cc-safety-net", "obra/superpowers", "pi-subagents"].filter((p) => !r.stdout.includes(p));
	add("packages", missing.length ? "fail" : "ok", missing.length ? `missing: ${missing.join(", ")}` : "cc-safety-net, superpowers, pi-subagents installed");
}

function checkConfig() {
	const problems = [];
	let st, models;
	try { st = JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8")); models = JSON.parse(fs.readFileSync(path.join(AGENT, "models.json"), "utf8")); }
	catch (e) { return add("config sanity", "fail", `settings/models JSON: ${e}`); }
	for (const f of [...(st.extensions ?? []), ...(st.subagents?.defaultExtensions ?? [])]) if (!fs.existsSync(f)) problems.push(`missing extension file ${f}`);
	if (st.theme && !["system", "dark", "light"].includes(st.theme.split("/")[0]) && !fs.existsSync(path.join(AGENT, "themes", `${st.theme.split("/")[0]}.json`))) problems.push(`theme ${st.theme} not found`);
	const extSrc = (st.extensions ?? []).map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")).join("\n");
	for (const [name, p] of Object.entries(models.providers ?? {})) if (!/^openai-|^anthropic-/.test(p.api ?? "") && !extSrc.includes(`api: "${p.api}"`)) problems.push(`provider ${name} uses api "${p.api}" but no enabled extension registers it`);
	if (!/\brouter\b/.test(st.defaultProvider ?? "")) problems.push(`defaultProvider is "${st.defaultProvider}", expected router`);
	add("config sanity", problems.length ? "fail" : "ok", problems.join("; ") || "settings, models, extension paths, theme, custom provider apis consistent");
}

function checkSkills() {
	const base = path.join(os.homedir(), ".claude", "plugins", "cache");
	const count = (name) => { const root = path.join(base, name, name); if (!fs.existsSync(root)) return 0; const v = fs.readdirSync(root).filter((x) => fs.existsSync(path.join(root, x, "skills"))).sort().pop(); return v ? fs.readdirSync(path.join(root, v, "skills")).length : 0; };
	const aas = count("agentic-awesome-skills"), ecc = count("ecc");
	add("skill libraries", aas > 1000 && ecc > 100 ? "ok" : "fail", `aas ${aas} skills, ecc ${ecc} skills`);
}

// ---------------------------------------------------------------- run
const started = Date.now();
checkConfig();
checkSkills();
await Promise.all([checkLoad(), checkTypes(), checkNano(), checkPackages()]);
await Promise.all([checkModels(), checkRouter()]);
await checkRead();
await checkImage();
await checkFullPath();
await Promise.all([checkGuards(), checkGuardLogic()]);

const order = { fail: 0, warn: 1, ok: 2 };
results.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
const failed = results.filter((r) => r.status === "fail").map((r) => r.name);
const warned = results.filter((r) => r.status === "warn").map((r) => r.name);
const status = failed.length ? "fail" : warned.length ? "warn" : "ok";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reportPath = path.join(REPORT_DIR, `${stamp}-pi${VERSION}.md`);
const icon = { ok: "OK", warn: "WARN", fail: "FAIL" };
fs.writeFileSync(reportPath, [
	`# Диагностика харнеса: pi ${VERSION} (было ${PREV})`, "", `Статус: **${status.toUpperCase()}**, ${results.length} проверок, ${Math.round((Date.now() - started) / 1000)} с, ${new Date().toISOString()}`, "",
	"| Проверка | Статус | Подробности |", "|---|---|---|", ...results.map((r) => `| ${r.name} | ${icon[r.status]} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`), "",
	failed.length ? `Что делать: передай этот файл Claude: ${reportPath}` : "",
].join("\n"));
fs.writeFileSync(path.join(STATE, "diag.json"), JSON.stringify({ piVersion: VERSION, prev: PREV, ts: new Date().toISOString(), status, failed, warned, report: reportPath, announced: false }, null, 2));
fs.mkdirSync(path.join(AGENT, "journal"), { recursive: true });
fs.appendFileSync(path.join(AGENT, "journal", "journal.jsonl"), `${JSON.stringify({ type: "diagnostic", ts: new Date().toISOString(), piVersion: VERSION, prev: PREV, status, failed, warned, report: reportPath })}\n`);
fs.rmSync(path.join(STATE, "doctor-work"), { recursive: true, force: true });
try { fs.unlinkSync(path.join(STATE, "doctor.lock")); } catch { /* no lock */ }
console.log(`${status.toUpperCase()} failed=[${failed.join(", ")}] warned=[${warned.join(", ")}] report=${reportPath}`);
