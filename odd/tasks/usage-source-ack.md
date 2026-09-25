# Yield standalone segment to native metering

Objective: make the standalone status segment respect gentle-shell's configuration automatically — when gentle-shell acknowledges a usage-source registration, the extension retires its own segment; without an acknowledgement (no shell, older shell, malformed payload) the standalone fallback keeps working exactly as today.

Problem: `gentle-pi:usage-source/v1` delivery has no acknowledgement, so this extension always paints its fallback segment. Next to the shell's native usage it duplicates the meter, and it survives `visibility.usageCost=false` and `statusPlacement=hidden`, contradicting the user's `/gentle:customize` choices.

Design: gentle-shell (producer side, separate repo, same feature name) now emits `gentle-pi:usage-source-ack/v1` with `{ schema: "gentle-pi.usage-source-ack/v1", provider }` for every accepted registration. This extension mirrors the constants verbatim, subscribes at factory time, defensively validates the payload (schema + provider ∈ `ZAI_USAGE_PROVIDERS`), records the provider in a `nativeMetered` set, and repaints — which clears the standalone segment when the active provider is natively metered. `/zai:usage off|on` keeps its explicit-hiding role; `on` explains when native metering owns the display. Limitation: no un-ack when the shell unloads mid-session (documented).

Scope: `extensions/zai_usage.ts` (constants, factory subscription, paint suppression, `on` notification, header comment), tests mirroring the existing fake-bus style, README truthfulness updates. No parser, panel, or version changes; no publishing.

Delivery: feature branch `feat/usage-source-ack` from `13b2828`. Checks: `pnpm test` + `pnpm typecheck`.

## Tasks

- [x] T1 — Subscribe to the ack and yield the standalone segment. Mirror ack constants, add `nativeMetered` set + factory-time listener with defensive parse, suppress the segment in `paint()` for natively-metered active providers, adjust `/zai:usage on` messaging, update the header comment. Tests: ack clears the segment; no ack keeps it; foreign-provider ack ignored; malformed ignored; replay idempotent; ack-before-first-fetch; `on` under native metering notifies and still opens the panel. Route: delegated writer + orchestrator refinement (panel fall-through restored). Check: `npm test` 30/30, `npm run typecheck` clean. Commit: this work unit.
- [x] T2 — README truthfulness: standalone row, "Both worlds" bullet, command table, and "Relationship to gentle-pi" describe the ack retirement and its fallback semantics without claiming a released gentle-shell version. Route: delegated writer. Check: independent verify readback PASS. Commit: this work unit.
- [x] T3 — Verify the suite and commit the work unit. Route: delegated verify (`gentle-ai-verify`) + orchestrator commit. Check: verdict PASS — scope exact, constants byte-identical to gentle-shell 36637079, no plain-pi regression, no timer leak, README matches behavior, badge 30/30. Commit: this work unit (`feat: yield the standalone segment to gentle-shell native metering`).

## Progress and evidence

- Branch `feat/usage-source-ack` created from `13b2828` (v0.4.1 tip).
- Producer contract implemented in gentle-shell under `odd/tasks/usage-source-ack.md` (commit 36637079).
- Writer: TDD RED (missing export) → GREEN 30/30; orchestrator refined `/zai:usage on` to keep the documented refresh-and-panel fall-through under native metering; independent verify: PASS.
- Engram mirror: `odd/usage-source-ack/tasks` (project `gentleman`; this Pi session is bound to the parent project).

## Next step

RDD preflight (`gentle-ai review mode status` reads on globally), then push/PR/publish remain the user's decisions.
