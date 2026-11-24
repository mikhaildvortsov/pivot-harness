---
name: ship-pr
description: Final delivery step for a finished, verified code task in a git repo with a remote — commit, rebase on fresh base, push the task branch, open a DRAFT PR, verify remote SHA, report CI status, then ASK the user whether to merge. Also the procedure for merging when the user explicitly asks.
---

# Ship as a draft PR, then ask about merging

Repo rules (`AGENTS.md`, `_RULES.md`) override this skill where they differ (base branch, remote, PR body format).

## Preconditions — stop and report instead of shipping if any fails
- All checks green in THIS state (typecheck/lint/tests); critic and Opus review have no open BLOCKER.
- The user did not ask to skip pushing/PR.
- `git status --short`: only changes that belong to this task. Pre-existing unrelated changes stay unstaged and untouched.

## Steps
1. **Remote and base.** `git remote -v`; use the remote that hosts the default branch (`git remote show <r> | grep 'HEAD branch'`), not a hard-coded `origin`. Base = repo rule, else that HEAD branch.
2. **Branch.** If on the base branch (main/master/develop), create a task branch first: `git switch -c <type>/<short-slug>` (type: feat/fix/chore/docs/refactor). Never commit to the base branch.
3. **Commit.** Stage explicit paths only (never `git add .` / `-A`). Conventional Commit message, imperative, no AI attribution or co-author trailers. Use the configured human git identity. Never `--no-verify`; if a hook fails, fix the cause.
4. **Rebase on fresh base.** `git fetch <remote> <base>` then `git rebase <remote>/<base>`. On conflicts: resolve only within this task's scope; if unclear, stop and report. If the rebase changed anything, re-run the checks and report both runs.
5. **Verify the commits.** `git log --format='%h %an <%ae> | %cn | %s' <remote>/<base>..HEAD` and full messages: human author/committer, no AI trailers.
6. **Push.** `git push -u <remote> HEAD` — no force, never the base branch.
7. **Draft PR.** Write the body to a temp file, then `gh pr create --draft --base <base> --head <branch> --title "<conventional title>" --body-file <file>`. If a PR for the branch exists, update it with `gh pr edit` instead. Body sections:
   - **Что сделано** — each requirement → status (done/open) → commit(s) → test(s).
   - **Проверки** — exact commands with exit codes and pass/fail counts.
   - **Ревью** — critic verdict, Opus verdict, findings fixed/rejected with reason.
   - **Не сделано / не проверено** — explicitly, with the reason (e.g. e2e not run).
8. **Verify remote state.** `gh pr view --json url,number,headRefOid,baseRefName,isDraft` — headRefOid must equal `git rev-parse HEAD`, base must be correct, `isDraft` true.
9. **CI.** `gh pr checks <number>` once and report the real status (pending/pass/fail with check names). Do not claim CI passed unless it did. If it fails on this change, fix it, re-run local checks, push again.
10. **Do not merge on your own.** While tasks are in progress all work stays in branches and PRs. A hook blocks `gh pr merge` and merging into the base branch unless the user's current message explicitly asks for it.
11. **End by asking**, as the last line of the final report, exactly in this form:
    `Мерджить PR #<n> (<branch> → <base>, head <short sha>, CI: <status>)?`

## Merging — only when the user explicitly asks ("смержи", "мерджи PR #n", "да" to the question above)
1. Re-check right before merging: `gh pr view <n> --json state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName` and `gh pr checks <n>`.
   - headRefOid must equal the SHA you showed the user; if it changed, show the new SHA and ask again.
   - All required checks must pass. If CI is pending, wait (`gh pr checks <n> --watch`); if it failed, do not merge — report.
   - Conflicts / not mergeable → do not merge; report what blocks it.
2. If the PR is a draft: `gh pr ready <n>`.
3. Merge with the repository's convention (look at recent merges in `git log --merges` / repo rules; default `gh pr merge <n> --merge`). Never `--admin`, never bypass branch protection, never force.
4. Verify: `gh pr view <n> --json state,mergeCommit` → MERGED; report the merge commit SHA. If the repo deploys from the base branch, say so.
5. Only merge the PRs the user named or confirmed; one confirmation = one PR.

## Final report (Russian)
PR URL and number, branch → base, head SHA (verified), commits list, checks with exit codes, review verdicts, CI status as observed, what was not done/verified — and the merge question as the last line.
