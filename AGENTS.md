# Global agent rules (pi harness)

NanoGPT: use only DeepSeek and GLM. Preserve Anthropic/OpenAI subscription routing.

## 0. Local overlays — highest priority
Before any work, check `./AGENTS.local.md` (repo root) and `~/.pi/agent/local/AGENTS.local.md`. If either exists, read it with the read tool and apply it; on conflict it overrides this file. Repo `AGENTS.md` overrides this file too.

Reply in the user's language (Russian if the user writes in Russian), including questions, reports and spec texts; code, identifiers and commit messages stay in English.

## 1. Mode: decide yourself, do not ask
- First, for every new request: call `classify_task` (judge by meaning). Hooks route by your declaration: `spec` → Opus leads (`spec_mode`: `materials` = spec strictly from the instructions/files the user gave, `speckit` = from scratch through spec-kit); `security` → Opus 4.8 review; `fullstack` → contract first; `subtasks` > 3 → swarm; `use_skills` → skill search. Follow the next steps it returns.
- Small, single-concern change (≈1–3 files, no auth/data/migration): do it directly.
- Multi-step feature, cross-layer (backend ↔ frontend), auth/security/data change, or unclear scope: follow the superpowers process — brainstorming → writing-plans (or the `fullstack-plan` skill for backend↔frontend) → test-driven-development → verification-before-completion → `critic` skill → finishing-a-development-branch.
- Ask the user only for irreversible, security, billing, or genuinely ambiguous product decisions. Otherwise state your assumption in one line and proceed.
- Never ask permission to run a command, edit a file, install a dev dependency or start a subagent: just do it. The harness gates (git-guard, config-guard, safety-net) block what is not allowed; a block is information, not a question for the user.

## 1b. Swarm mode (subagents) — decide yourself
The `subagent` tool (pi-subagents) runs subagents with a fresh context; superpowers maps "dispatch a subagent" to it.
- MANDATORY when the plan has more than 3 subtasks: implement them through subagents (a hook blocks writing code yourself until the first `subagent` call). Dependent subtasks go one after another, still via subagents.
- Optional for 2–3 subtasks: use the swarm if the work spans separate areas (e.g. backend and frontend after the contract is fixed) or a fresh-context review is needed. Otherwise work alone — one agent is cheaper.
- Plan files the hook reads: `.pi/context/plan.md`, `docs/superpowers/plans/*.md`, `docs/plans/*.md` (subtasks = `### Task N` headings or numbered items under `## Plan`).
- Flow: write the plan/contract first (writing-plans or `fullstack-plan`) to `.pi/context/plan.md`, then follow superpowers `subagent-driven-development`: one `worker` per subtask, a `reviewer` after each.
- Brief each subagent like a peer who knows nothing: the exact subtask text, the plan/contract path, files it owns, the checks to run, and what to return. Never pass the whole conversation.
- Run subtasks that touch the same files sequentially; parallel (`tasks: [...]`) only for disjoint files. Max 4 in parallel. Items in `tasks` take only `agent` and `task` (no `label`).
- Do not trust subagent reports: after they finish, check `git diff` and run the checks yourself before reporting done.

## 1a. Skill library on demand
The aas (agentic-awesome-skills) and ecc skill libraries (~2600 skills, newest installed Claude plugin versions) are NOT listed in this prompt. Every subagent must pick and read 2 of them at the start of its subtask (enforced by a hook). Whenever the user asks — in any wording or language ("подбери скиллы", "используй подходящие навыки", "what skills fit here") — to pick, find or use skills for the task: call `find_skills` with 5–10 English keywords describing the task, choose at most 2 that directly fit, read their `SKILL.md` fully, name them in one line with the reason, then follow them. Never claim to use a skill you have not read.

## 2. No stubs, no corner cutting
Forbidden in code you write: `TODO`, `FIXME`, `XXX`, `NotImplementedError`, bare `pass` as a placeholder, empty `catch {}` / `except: pass`, `as any`, `@ts-ignore`, `@ts-expect-error`. Implement fully or report the exact blocker. Never weaken, skip, or delete tests/lint/type checks to make them pass.

## 3. Output budget: 16384 tokens per response
- Change code with targeted `edit` calls. Do not rewrite long files with `write` unless creating them or the change touches most of the file.
- Read only the needed file ranges. Keep tool output short (`| tail -n 60`, `--quiet`).
- Every model turn waits in a provider queue, so minimize turns: issue independent `read`/`grep`/`find`/`bash` calls together in one turn, and chain related checks in one command (`npm run -s typecheck && npm run -s lint && npm test -- <file>`).
- Large work: split into steps across turns; never truncate code mid-file.

## 4. Fullstack protocol (backend ↔ frontend)
1. Contract first, before coding: DTO/request/response schemas, field types, nullable/optional fields, error codes and HTTP statuses, pagination. Write it to `.pi/context/plan.md`.
2. Backend: object-level authorization on every read/write (IDOR) and role checks (RBAC); validate input at the boundary; multi-write operations in a transaction; no secrets or PII in logs.
3. Frontend: every data view handles loading, error, empty and success states; user-facing errors are specific and actionable.
4. Both sides must match the contract exactly; update the contract first if it must change.

## 5. Verification before finishing (mandatory)
Before saying a task is done:
1. Run the relevant linter, type checker and tests via bash. Report the exact commands and exit codes.
2. Run `git status --short` and `git diff` and audit your own diff: unrelated changes, debug leftovers, stubs, missing tests, broken contract.
3. "Done" means verified. If a check was not run or fails, say so explicitly with the reason — never imply success.
4. When you find a gap in your own work, fix it now instead of only mentioning it.

## 6. Git and safety
Stage explicit paths only (no `git add .`). Never `--no-verify`, never force-push, never push `main`/`master`, never merge on your own: all work stays in branches and draft PRs; after delivery ask "Мерджить PR #N (…)?" and merge only when the user explicitly asks (the `ship-pr` skill has the merge procedure). No AI attribution or co-author trailers in commits. Never read or print `.env*` or secrets.

## 7. Browser (DevTools)
Tools `mcp__devtools__*` drive a headless, isolated Chrome (`navigate_page`, `new_page`, `click`, `fill`, `take_snapshot`, `take_screenshot`, `list_console_messages` are always available; `tool_search` finds the rest: network, emulation, Lighthouse, ...).
1. To walk through a UI: `new_page`/`navigate_page`, then `take_snapshot` (cheap text tree) to find and drive elements; use `take_screenshot` (needs `pageId` from `list_pages`) only when the look matters (layout, colors, overlap, responsive).
2. A screenshot is read by the vision model (GLM Flash) for that one step and the turn then returns to the text model, so write down what you saw (element, state, defect) in plain text right after each screenshot.
3. Only local, dev and staging URLs. Never prod, never a page showing real patient data or secrets; use fabricated fixtures. Do not type credentials taken from files.
4. After a UI change: reload, check console errors, screenshot at desktop and mobile width (`emulate`/`resize_page`), and state the result. Close pages you opened.
