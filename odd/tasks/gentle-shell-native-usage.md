# Gentle Shell native Z.ai usage

Objective: display Z.ai quota in Gentle Shell's native usage header/bar and `/gentle:usage` panel, like Codex, while retaining a usable plain-Pi fallback.

Problem: this package currently decorates the experimental sidebar Status card and sends a `setStatus` segment; Gentle Shell's native usage store never receives Z.ai data. Its official `gentle-pi:usage-source/v1` event supports third-party providers.

Scope: pi-zai-usage extension registration, obsolete rail integration, focused tests, and README. No Gentle Shell source edits, endpoint changes, publishing, or upstream integration.

Constraints: register both `zai` and `zai-glm` at session start (ordering-independent with Gentle Shell), use the provider-specific key supplied by the consumer with environment fallback, keep standalone status and `/zai:usage`, and avoid the undocumented sidebar rail. Event delivery has no acknowledgement; standalone status may remain in Integrations when Gentle Shell is active. `/zai:usage off` affects only standalone status, not Shell's native usage.

TDD: not explicitly configured in this repository/session; standard verification. Runner: `pnpm test`, `pnpm typecheck`; focused runner: `node --experimental-strip-types --test tests/*.test.ts`.

Route: delegated exploration (4+ files needed); delegated writer for multiple non-trivial files. Forecast: ~200 authored changed lines, ask-on-risk delivery strategy. No commit without explicit user request.

- [x] ZU-1: Bridge provider usage to Gentle Shell via its usage-source event; remove experimental rail decoration while preserving standalone fallback. Implementation observed; writer and independent verifier both ran `pnpm test` 22/22 and `pnpm typecheck` exit 0; live TUI confirmed: header usage segment renders z.ai after restart (user-verified 2026-09-24).
- [x] ZU-2: Document native Shell and standalone behavior accurately. README updated (badge 22/22, native-vs-standalone surfaces, `/zai:usage off` scope); readback clean.

Engram mirror: pending in target project (current Pi session is bound to `gentleman`, and Engram rejects `pi-zai-usage` writes). Local file is the recovery copy until a session in the target project synchronizes it.

Progress: complete. Work-unit commit on main (user-authorized commit and push, 2026-09-24). Files: `extensions/zai_usage.ts` (source registration), deleted `lib/zai-rail.ts` + `tests/zai-rail.test.ts`, new `tests/zai-usage-source.test.ts`, README, this document. Verification: writer + independent `gentle-ai-verify` + parent spot check all green (22/22, typecheck clean, `git diff --check` clean); user confirmed live header rendering after restart. Native review assess over the committed range pending as the candidate boundary. Next: user decides release tag (publish workflow runs from annotated version tags on origin/main).
