---
name: fullstack-plan
description: Contract-first planning for a feature that spans backend and frontend. Use before coding any cross-layer change; studies affected modules read-only and writes the contract plus a step plan to .pi/context/plan.md.
---

# Fullstack plan (contract first)

Read-only phase: do NOT edit source code. The only file you write is `.pi/context/plan.md`.

## Steps
1. **Restate the task** in 2–4 lines. List explicit requirements verbatim from the user; mark every assumption as `ASSUMPTION:`.
2. **Map affected code** with `grep`/`find`/`read` (targeted ranges only):
   - backend: routes/controllers, services, entities/migrations, guards/policies, existing tests;
   - frontend: pages/components, API client/hooks, state, existing tests;
   - shared types/schemas if any. Record `file:line` for each anchor.
3. **Write the contract** — the single source of truth for both sides:
   - endpoints: method, path, auth requirement;
   - request/response DTOs with exact field names, types, required/optional, nullable;
   - error cases: HTTP status + error code + when it happens (validation, 401, 403 not owner, 404, 409, ...);
   - authorization: who may read/write which object (object-level ownership = IDOR rule, roles = RBAC);
   - data changes: migrations, transactions (which writes must be atomic), idempotency;
   - frontend states per view: loading, error (per error code), empty, success.
4. **Step plan**: ordered, small steps; each step = files to touch + the test that proves it (write the test first). Backend before frontend unless the contract is already implemented.
5. **Checks**: exact lint/typecheck/test commands per package that must pass at the end.
6. Save everything to `.pi/context/plan.md` (create the directory if missing) with sections: `Task`, `Assumptions`, `Code map`, `Contract`, `Plan`, `Checks`, `Open questions`.

## Rules
- No placeholders in the plan ("handle errors appropriately" is not a contract — name the codes).
- Open questions only for decisions you cannot make from code or the request; otherwise choose and record the assumption.
- After writing the file, reply with a 5-line summary and the path; then implement step by step (TDD) unless the user asked for planning only.
