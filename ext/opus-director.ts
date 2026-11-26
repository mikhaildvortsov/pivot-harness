// Opus 5.5 as director/reviewer, never the main coder. DeepSeek/GLM do the implementation.
// 1. Direct:  when the model classifies the task as `spec` (task-classifier.ts → pi.events "task:classified"), the rest
//             of the run goes to Opus; the model is restored afterwards. `/opus` or `опус:` at the start forces it. While directing, Opus may only write docs/specs, not code.
// 2. Review:  before a run settles, a sizable or security-sensitive change gets a read-only Opus review; BLOCKERs are
//             sent back to the working model to fix (max 2 reviews per task).
// Security-related direct/review/advice uses Opus 4.8 (SECURITY_OPUS_ID); everything else Opus 5.5.
// 3. Advise:  `ask_opus` tool for when the working model is stuck or faces an architectural decision (max 3 per task).
// Children spawned for review/advice set PI_OPUS_CHILD=1 so these hooks do not recurse.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { anthropicUnavailable, FALLBACK } from "./lib/fallback.ts";

const OPUS_PROVIDER = "anthropic";
const OPUS_ID = "claude-opus-5-5";
// Cybersecurity work (security review, auth/permissions code, vulnerability questions) goes to Opus 4.8.
const SECURITY_OPUS_ID = "claude-opus-4-8";
const SECURITY_PATH = /auth|login|session|token|password|permission|rbac|acl|guard|policy|role|crypto|secret|csrf|cors|sanitiz|security/i;
const MAX_REVIEWS = 2;
const MAX_ADVICE = 3;
const REVIEW_MIN_LINES = 60;
const CHILD_TIMEOUT_MS = 10 * 60_000;

const FORCE_OPUS = /^\s*(\/opus\b|опус[:,]|opus[:,])/i;
const SENSITIVE_PATH = /auth|login|session|token|password|permission|rbac|acl|guard|policy|role|migration|\.sql$|payment|billing|crypto|secret/i;
const DOC_PATH = /\.(md|mdx|txt|ya?ml|json)$|(^|\/)(specs|\.specify|docs|\.pi\/context)\//i;

const REVIEW_BRIEF = `You are a senior reviewer (Opus). Another model wrote this change. You do NOT write code; you judge it.
Review the diff against the user's task and the plan/contract if given. Check: requirement coverage, correctness, access
control (object-level ownership/IDOR, roles/RBAC), validation at boundaries, transactions, error handling, UI states
(loading/error/empty/success), tests that would fail without the change, stubs or suppressed checks.
Use read/grep/find only to confirm suspicions in the repo. Report only real defects with evidence.
Answer in Russian, exactly in this format:
VERDICT: PASS | NEEDS_FIX
BLOCKER:
- [file:line] defect — concrete failure scenario — required fix
MINOR:
- [file:line] issue — suggestion
Any BLOCKER means NEEDS_FIX. No BLOCKER means PASS.`;

const ADVISE_BRIEF = `You are a senior advisor (Opus) to a less capable coding model that is stuck or must make a design decision.
Do NOT write the full implementation. Give the diagnosis, the decision with its reason, and concrete next steps (files,
functions, commands to run). Short code fragments only where they remove ambiguity. Max ~400 words. Answer in Russian.
Use read/grep/find to inspect the repo before answering.`;

const DIRECT_BRIEF = `[opus-director] You (Opus) are directing this turn: specifications, requirements clarification, architecture,
planning. Produce or refine the spec/plan documents and ask the user the clarifying questions that truly block the work.
Do not implement production code — DeepSeek/GLM will implement after you. Write documents only (specs/, .specify/, docs/,
.pi/context/, *.md). End with a short hand-off: what the implementer must do next, in order.`;

function piInvocation(args: string[]): { cmd: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { cmd: process.execPath, args: [script, ...args] };
	return { cmd: "pi", args };
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_OPUS_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "1") return;

	let directing = false;
	let classified: { kind: string; security: boolean } | undefined;
	let lastCtx: ExtensionContext | undefined;
	let restore: { model?: ExtensionContext["model"]; thinking?: ReturnType<ExtensionAPI["getThinkingLevel"]> } = {};
	let task = "";
	let reviews = 0;
	let advice = 0;
	let baseline: string | undefined;
	let reviewedState: string | undefined;

	const runOpus = async (cwd: string, brief: string, body: string, modelId: string = OPUS_ID) => {
		const run = async (model: string, thinking: string) => {
			const inv = piInvocation(["-p", "--no-session", "--model", model, "--thinking", thinking, "--tools", "read,grep,find,ls", "--append-system-prompt", brief, body]);
			const r = await pi.exec("env", ["PI_OPUS_CHILD=1", "PI_SUBAGENT_CHILD=1", "PI_GATE=off", inv.cmd, ...inv.args], { cwd, timeout: CHILD_TIMEOUT_MS });
			return { ok: r.code === 0 && r.stdout.trim().length > 0, text: r.stdout.trim() || r.stderr.trim().slice(-1500), code: r.code };
		};
		const first = await run(`${OPUS_PROVIDER}/${modelId}`, "high");
		// Anthropic quota ended or the API is blocked: the same task goes to GPT-6.1 Sol with high reasoning
		if (!first.ok && anthropicUnavailable(first.text)) {
			const second = await run(`${FALLBACK.provider}/${FALLBACK.id}`, FALLBACK.thinking);
			if (second.ok) return { ...second, text: `[${FALLBACK.label}: Anthropic unavailable]\n${second.text}` };
		}
		return first;
	};

	const git = async (cwd: string, script: string) => (await pi.exec("bash", ["-c", script], { cwd, timeout: 30_000 })).stdout;
	const fingerprint = (cwd: string) =>
		git(cwd, "git status --porcelain --untracked-files=all 2>/dev/null && git diff HEAD 2>/dev/null | shasum");

	pi.on("input", async () => {
		reviews = 0;
		advice = 0;
		classified = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		baseline = await fingerprint(ctx.cwd);
		if (event.messageType !== "user") return;
		task = event.prompt;
		lastCtx = ctx;
		if (!FORCE_OPUS.test(event.prompt)) return;
		if (!(await startDirecting(ctx, false))) return;
		return { message: { customType: "opus-director", content: DIRECT_BRIEF, display: false } };
	});

	const startDirecting = async (ctx: ExtensionContext, security: boolean) => {
		if (directing) return true;
		const directId = security ? SECURITY_OPUS_ID : OPUS_ID;
		const opus = ctx.modelRegistry.find(OPUS_PROVIDER, directId);
		if (!opus) return false;
		restore = { model: ctx.model, thinking: pi.getThinkingLevel() };
		if (!(await pi.setModel(opus))) return false;
		pi.setThinkingLevel("high");
		directing = true;
		ctx.ui.notify(`opus-director: ${directId} ведёт задачу (спецификация/требования)`, "info");
		return true;
	};

	pi.events.on("task:classified", (data) => {
		classified = data as { kind: string; security: boolean };
		if (classified.kind === "spec" && lastCtx) void startDirecting(lastCtx, classified.security);
	});

	pi.on("agent_settled", async () => {
		if (!directing) return;
		directing = false;
		if (restore.model) await pi.setModel(restore.model);
		if (restore.thinking) pi.setThinkingLevel(restore.thinking);
		restore = {};
	});

	pi.on("tool_call", async (event) => {
		if (!directing || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = (event.input as { path?: string }).path ?? "";
		if (DOC_PATH.test(path)) return;
		return {
			block: true,
			reason: `opus-director: in a directing turn Opus writes specs/docs only; ${path} is code. Put it in the plan for the implementer.`,
		};
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (directing || event.outcome !== "completed" || event.continue || reviews >= MAX_REVIEWS) return;
		const top = (await git(ctx.cwd, "git rev-parse --show-toplevel 2>/dev/null")).trim();
		const state = await fingerprint(ctx.cwd);
		if (!top || state === baseline || state === reviewedState) return;

		const numstat = await git(top, "git diff HEAD --numstat");
		const untracked = (await git(top, "git ls-files --others --exclude-standard")).split("\n").filter(Boolean);
		let lines = 0;
		const files: string[] = [...untracked];
		for (const row of numstat.split("\n").filter(Boolean)) {
			const [add, del, file] = row.split("\t");
			lines += (Number(add) || 0) + (Number(del) || 0);
			files.push(file);
		}
		for (const f of untracked) {
			try {
				lines += readFileSync(join(top, f), "utf8").split("\n").length;
			} catch {
				lines += 1;
			}
		}
		if (lines < REVIEW_MIN_LINES && !files.some((f) => SENSITIVE_PATH.test(f))) return;

		reviews++;
		reviewedState = state;
		const diff = (await git(top, "git diff HEAD")).slice(0, 60_000);
		const newFiles = untracked
			.slice(0, 20)
			.map((f) => {
				try {
					return `--- new file ${f}\n${readFileSync(join(top, f), "utf8").slice(0, 8_000)}`;
				} catch {
					return `--- new file ${f} (unreadable)`;
				}
			})
			.join("\n");
		const planPath = join(top, ".pi", "context", "plan.md");
		const plan = existsSync(planPath) ? readFileSync(planPath, "utf8").slice(0, 15_000) : "(no plan file)";
		const reviewId = files.some((f) => SECURITY_PATH.test(f)) || classified?.security ? SECURITY_OPUS_ID : OPUS_ID;
		ctx.ui.notify(`opus-director: ревью ${reviewId} (${lines} строк, раунд ${reviews}/${MAX_REVIEWS})`, "info");
		pi.events.emit("check:result", { id: "review:opus", group: "review", label: `ревью ${reviewId.replace(/^.*\//, "")} (раунд ${reviews})`, status: "running" });
		const r = await runOpus(top, REVIEW_BRIEF, `USER TASK:\n${task}\n\nPLAN/CONTRACT:\n${plan}\n\nDIFF:\n${diff}\n${newFiles}`, reviewId);
		if (!r.ok) {
			pi.events.emit("check:result", { id: "review:opus", group: "review", label: "ревью Opus", status: "fail", detail: `не выполнено (exit ${r.code})` });
			ctx.ui.notify(`opus-director: ревью не выполнено (exit ${r.code})`, "warning");
			return {
				entries: [...event.entries, { type: "custom_message" as const, customType: "opus-review", content: `[opus-review] Ревью Opus не выполнено (exit ${r.code}). Сообщи пользователю, что независимое ревью пропущено.\n${r.text.slice(0, 800)}`, display: true }],
				continue: true,
			};
		}
		const needsFix = /VERDICT:\s*NEEDS_FIX/i.test(r.text);
		pi.events.emit("check:result", { id: "review:opus", group: "review", label: `ревью ${reviewId.replace(/^.*\//, "")} (раунд ${reviews})`, status: needsFix ? "fail" : "pass", detail: r.text.slice(0, 1500) });
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "opus-review",
					content: needsFix
						? `[opus-review ${reviews}/${MAX_REVIEWS}] Opus нашёл блокеры. Исправь каждый BLOCKER сам (с тестом, где применимо), перезапусти проверки и кратко отчитайся по каждому пункту. Если считаешь пункт ложным — докажи кодом/выводом команды.\n\n${r.text}`
						: `[opus-review] ${r.text}\n\nВключи вердикт ревью в итоговый ответ пользователю.`,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.registerTool({
		name: "ask_opus",
		label: "Ask Opus",
		description:
			"Consult the senior model (Opus) for guidance. Use ONLY when stuck after 2 failed attempts at the same problem, or for a hard architectural/security decision. It advises; you implement. Max 3 calls per task.",
		parameters: Type.Object({
			question: Type.String({ description: "The concrete question or decision" }),
			context: Type.String({ description: "What you tried, exact errors/command output, relevant file:line refs" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (advice >= MAX_ADVICE) {
				return { content: [{ type: "text", text: `ask_opus limit (${MAX_ADVICE}) reached for this task. Decide yourself or report the blocker to the user.` }], details: {} };
			}
			advice++;
			const r = await runOpus(ctx.cwd, ADVISE_BRIEF, `TASK:\n${task}\n\nQUESTION:\n${params.question}\n\nCONTEXT:\n${params.context}`,
				classified?.security ? SECURITY_OPUS_ID : OPUS_ID,
			);
			return {
				content: [{ type: "text", text: r.ok ? `Opus advice (${advice}/${MAX_ADVICE}):\n${r.text}` : `ask_opus failed (exit ${r.code}): ${r.text.slice(0, 500)}` }],
				details: {},
			};
		},
	});
}
