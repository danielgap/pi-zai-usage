# Scoped Gentle Shell Z.ai package

Objective: Publish under `@danielgap/gentle-shell-zai-usage` rather than the already-owned unscoped npm name, and make the Gentle Shell relationship and Gentle AI attribution easy to find.

Problem: `pi-zai-usage` is owned by another npm maintainer; the v0.4.0 workflow passed checks but npm rejected publication with E403. The existing README explains native Gentle Shell integration but its install command and release instructions use the unavailable name.

Scope: npm manifest/version, lockfile metadata if needed, release workflow, README. No extension behavior changes, upstream Gentle Shell edits, push, tagging, or publishing.

Constraints: Keep the existing GitHub repository URL; `v0.4.0` already exists, so prepare the next release as `0.4.1`. Use public scoped npm publication. Preserve standalone fallback truthfully. Add the requested `https://github.com/Gentleman-Programming/gentle-ai#built-with-gentle-ai` README link. Technical artifacts in English.

Delivery: ask-on-risk; forecast under 150 authored changed lines. Branch: `feat/scoped-gentle-shell-zai-release`; base `5732768`. TDD: not configured/unknown; runner `pnpm test` and `pnpm typecheck` for ordinary verification.

## Tasks

- [ ] T1 — Rename npm identity and make release workflow refer to the scoped package. Route: delegated writer (multi-file manifest/workflow/lockfile edit). Check: pack metadata and workflow references match `@danielgap/gentle-shell-zai-usage@0.4.1`; `pnpm test`, `pnpm typecheck`. Commit: pending.
- [ ] T2 — Update README install/release guidance, clarify Gentle Shell-first behavior with fallback, and link Built with Gentle AI. Route: inline mechanical doc edit or delegated if scope expands. Check: links/install instructions agree with manifest and release workflow; focused readback. Commit: pending.

## Progress and evidence

- Name selected explicitly by user; registry lookup returned not found for the new scoped name; npm account locally reports `danielgap`. Scope availability is not a reservation.
- First task in progress. No source edits or release delivery yet.
- Engram mirror pending: this Pi session is bound to the parent `gentleman` project, and a write to `pi-zai-usage` was rejected. Preserve this local recovery copy until a Pi session rooted in the target project can mirror it.

## Next step

Delegate T1 with bounded edit surfaces, verify and commit it; then complete T2 and its checks/commit. Do not publish without separate authorization.
