// The model classifies each new task itself (semantics, not keyword regexes). Hooks act on the declaration:
// - pi.events "task:classified" → opus-director (spec → Opus leads the run; security → Opus 4.8 review)
// - the tool result tells the model the mandatory next steps (fullstack-plan, swarm, skills, docs-only for spec).
// Until the task is classified, writing files is blocked (reading and exploring is allowed).
// The working model's classification is checked by Sonnet 5.5 (medium thinking); Sonnet's verdict is final, except that
// `security` is true if either says so (fail safe). If Sonnet is unavailable, the model's classification stands.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const SKILLS = join(homedir(), ".pi", "agent", "skills");
const KINDS = ["question", "spec", "code", "debug", "review", "docs", "ops"] as const;
const VERIFIER = "anthropic/claude-sonnet-5-5";
const VERIFY_TIMEOUT_MS = 90_000;

export type TaskClass = {
	kind: (typeof KINDS)[number];
	fullstack: boolean;
	security: boolean;
	subtasks: number;
	use_skills: boolean;
	spec_mode: "materials" | "speckit" | "none";
	summary: string;
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_OPUS_CHILD === "1" || process.env.PI_DOCTOR === "1") return;
	let current: TaskClass | undefined;
	let userRequest = "";

	pi.on("input", async () => {
		current = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") userRequest = event.prompt;
		if (event.messageType !== "user" || current) return;
		return {
			message: {
				customType: "task-classifier",
				display: false,
				content: "[classify] Before changing anything, call classify_task once for this request (you may read/explore first).",
			},
		};
	});

	pi.registerTool({
		name: "classify_task",
		label: "Classify task",
		description:
			"Declare what the user's current request is, once per request, before writing any file. Judge by meaning, not keywords. Returns the mandatory next steps.",
		parameters: Type.Object({
			kind: Type.Union(KINDS.map((k) => Type.Literal(k)), {
				description:
					"question=answer only, no changes; spec=write/clarify requirements, specs, ТЗ, architecture, plans (speckit); code=implement a feature/change; debug=find and fix a bug; review=review existing code/PR; docs=documentation only; ops=git/CI/release/merge chores",
			}),
			fullstack: Type.Boolean({ description: "the change needs both backend and frontend work against a shared contract" }),
			security: Type.Boolean({ description: "touches auth, permissions/RBAC/IDOR, sessions, tokens, secrets, crypto, payments, PII or a vulnerability" }),
			subtasks: Type.Integer({ minimum: 0, description: "how many separable implementation subtasks you expect (0 for question/review)" }),
			use_skills: Type.Boolean({ description: "the user asked (in any wording) to pick/find/use skills for this task" }),
			spec_mode: Type.Union([Type.Literal("materials"), Type.Literal("speckit"), Type.Literal("none")], {
				description:
					"for kind=spec: materials = the user gave instructions/ТЗ/QA remarks/files/archive to turn into a spec; speckit = build the spec from an idea from scratch via spec-kit; none = not a spec task",
			}),
			summary: Type.String({ description: "one line: what the user wants" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const proposed = params as TaskClass;
			const verified = await verify(ctx.cwd, proposed);
			current = verified.result;
			pi.events.emit("task:classified", { ...current, verifier: verified.note });
			const steps: string[] = [];
			if (current.kind === "question") steps.push("Answer directly; do not change files.");
			if (current.kind === "spec") {
				steps.push("Opus now leads this request: produce or refine spec/plan documents only (specs/, docs/, .specify/, .pi/context/, *.md); no production code.");
				if (current.spec_mode === "materials")
					steps.push(
						"Spec from the user's materials: (1) inventory every source the user gave — pasted text, attached/linked files, archives (unpack into a temp dir), referenced docs — and read each fully; " +
							"(2) every requirement must trace to a source (file + section/quote); implement the materials literally, add nothing of your own; " +
							"(3) gaps and contradictions go to 'ASSUMPTION:' or 'QUESTION:' lines, never silently resolved; " +
							"(4) if the repo has .specify/, write it through /skill:speckit-specify with the materials as the feature description, then speckit-checklist; otherwise write specs/<slug>.md; " +
							"(5) end with a traceability table: requirement → source → status.",
					);
				if (current.spec_mode === "speckit")
					steps.push(
						"Spec from scratch via spec-kit: if the repo has no .specify/, stop and ask the user whether to run `specify init --here` (do not init on your own). " +
							"Otherwise run in order: /skill:speckit-specify (feature description = the user's idea) → /skill:speckit-clarify (ask the user the clarification questions — these are product decisions) → " +
							"/skill:speckit-plan → /skill:speckit-tasks → /skill:speckit-analyze; fix every CRITICAL/HIGH finding of analyze before handing off.",
					);
				steps.push("End with a hand-off for the implementer: spec path, open questions, next command.");
			}
			if (current.use_skills)
				steps.push("Call find_skills with 5-10 English keywords, pick at most 2 skills that directly fit, read their SKILL.md fully, name them, follow them.");
			if (current.fullstack && current.kind !== "spec")
				steps.push(`Contract first: read ${join(SKILLS, "fullstack-plan", "SKILL.md")} and follow it before writing code.`);
			if (current.subtasks > 3)
				steps.push("More than 3 subtasks: write the plan, then implement via subagents (superpowers subagent-driven-development, `subagent` tool). Writing code yourself is blocked until the first subagent call.");
			if (current.security) steps.push("Security-sensitive: object-level authorization and validation are mandatory; the final review is done by Opus 4.8.");
			if (steps.length === 0) steps.push("Proceed: small change → do it directly with TDD and verification.");
			const header = `Classified as ${current.kind}${verified.note ? ` (${verified.note})` : ""}.`;
			return { content: [{ type: "text", text: `${header} Next:\n- ${steps.join("\n- ")}` }], details: { ...current, verifier: verified.note } };
		},
	});

	const verify = async (cwd: string, proposed: TaskClass): Promise<{ result: TaskClass; note: string }> => {
		const prompt = [
			"You verify how a coding agent classified a user's request. Judge by meaning, not keywords.",
			"Definitions: kind = question (answer only, no changes) | spec (write/clarify requirements, specs, ТЗ, architecture, plans) | code (implement a feature/change) | debug (find and fix a bug) | review (review code/PR) | docs (documentation only) | ops (git/CI/release/merge chores).",
			"fullstack = needs both backend and frontend work against a shared contract. security = touches auth, permissions/RBAC/IDOR, sessions, tokens, secrets, crypto, payments, PII/medical data or a vulnerability.",
			"subtasks = separable implementation subtasks (0 for question/review). use_skills = the user asked to pick/find/use skills. spec_mode (only for spec) = materials (spec from instructions/files the user gave) | speckit (from scratch) | none.",
			`USER REQUEST:\n${userRequest.slice(0, 6000)}`,
			`PROPOSED:\n${JSON.stringify(proposed)}`,
			'Reply with ONLY one JSON object: {"agree":true|false,"kind":"...","fullstack":bool,"security":bool,"subtasks":int,"use_skills":bool,"spec_mode":"...","summary":"...","reason":"<one short line>"}',
		].join("\n\n");
		const r = await pi.exec(
			"env",
			["PI_OPUS_CHILD=1", "PI_SUBAGENT_CHILD=1", "PI_WATCHDOG_MAINTAINER=1", process.execPath, process.argv[1] ?? "pi", "-ne", "--no-session", "--no-tools", "-p", "--model", VERIFIER, "--thinking", "medium", prompt],
			{ cwd, timeout: VERIFY_TIMEOUT_MS },
		);
		const json = r.stdout.match(/\{[\s\S]*\}/)?.[0];
		if (r.code !== 0 || !json) return { result: proposed, note: `Sonnet check unavailable (exit ${r.code}); model's classification kept` };
		try {
			const v = JSON.parse(json) as Partial<TaskClass> & { agree?: boolean; reason?: string };
			const result: TaskClass = {
				kind: KINDS.includes(v.kind as TaskClass["kind"]) ? (v.kind as TaskClass["kind"]) : proposed.kind,
				fullstack: typeof v.fullstack === "boolean" ? v.fullstack : proposed.fullstack,
				security: Boolean(v.security) || proposed.security,
				subtasks: Number.isInteger(v.subtasks) ? (v.subtasks as number) : proposed.subtasks,
				use_skills: typeof v.use_skills === "boolean" ? v.use_skills : proposed.use_skills,
				spec_mode: v.spec_mode === "materials" || v.spec_mode === "speckit" || v.spec_mode === "none" ? v.spec_mode : proposed.spec_mode,
				summary: v.summary || proposed.summary,
			};
			const changed = (Object.keys(result) as Array<keyof TaskClass>).filter((k) => k !== "summary" && result[k] !== proposed[k]);
			return { result, note: changed.length ? `Sonnet corrected ${changed.join(", ")}: ${v.reason ?? ""}` : "confirmed by Sonnet" };
		} catch {
			return { result: proposed, note: "Sonnet reply unparsable; model's classification kept" };
		}
	};

	pi.on("tool_call", async (event) => {
		if (current || (event.toolName !== "write" && event.toolName !== "edit")) return;
		return { block: true, reason: "task-classifier: call classify_task for this request before writing files." };
	});
}
