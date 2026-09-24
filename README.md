# pi-zai-usage

[![pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://github.com/danielgap/pi-zai-usage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/danielgap/pi-zai-usage?style=flat&color=yellow)](https://github.com/danielgap/pi-zai-usage/stargazers)
[![tests](https://img.shields.io/badge/tests-22%2F22-brightgreen)](#development)
[![parser provenance](https://img.shields.io/badge/parser-gentle--pi%20branch-ff69b4)](#relationship-to-gentle-pi)

**Meter your Z.ai GLM Coding Plan usage in pi, without guessing when the window resets.**

`pi-zai-usage` adds a usage meter for the Z.ai GLM Coding Plan to [pi](https://shittycodingagent.ai). When Gentle Shell (gentle-pi) is installed, the meter travels through its official third-party usage-source event into the shell's native usage surfaces, exactly like its built-in Codex/Claude sources. Everywhere else the standalone fallback carries it: a status-bar segment with the 5-hour and weekly token windows, a `/zai:usage` command that opens the `✿ Subscriptions` panel, and automatic refresh — every 5 minutes and after each response — while a Z.ai provider is active.

Z.ai meters the GLM Coding Plan through an undocumented quota endpoint. This package turns that endpoint into visible windows — plan level, used percentage per window, and when each one resets — and stays out of your way the moment you switch to another provider.

## The problem

Coding against a metered plan fails quietly, not loudly:

- the 5-hour window empties mid-session and you only learn it from failed calls;
- the weekly ceiling is invisible, so a productive Friday sabotages Monday;
- the quota endpoint is undocumented, so every meter is a reverse-engineered guess;
- nothing in pi shows subscription usage for Z.ai providers.

`pi-zai-usage` fixes the visibility. You bring the API key you already configured for the provider; it brings the parsing, the meter, and the discipline.

## What it adds

| Capability | What it does |
| --- | --- |
| **Native Gentle Shell usage** | Registers **both** `zai` and `zai-glm` as usage sources through gentle-pi's official `gentle-pi:usage-source/v1` event at `session_start`, so the shell's native usage store meters Z.ai like its own Codex/Claude sources — its refresh cadence (5 minutes, after each response, forced once on registration when a Z.ai model is active) and its `/gentle:usage` panel |
| **Status-bar segment (standalone fallback)** | `zai 5h ▰▰▱▱▱▱▱▱ 42% · week 71%` — first window gauged, the rest compact — delivered through pi's public `ctx.ui.setStatus` contract: trailing segment of gentle-pi's narrow footer, a line in its sidebar Integrations group, or pi's native footer without gentle-pi |
| **`/zai:usage` command** | Opens the `✿ Subscriptions` panel gentle-pi's `/gentle:usage` opens: 16-cell meters, reset countdowns, plan, `updated Xm ago`; `r` refetches, `esc` closes |
| **`/zai:usage off` / `on`** | Hides or restores the standalone status segment — never the native usage Gentle Shell already recorded from the event |
| **Automatic refresh** | Polls every 5 minutes and after every response while a `zai` / `zai-glm` model is active |
| **Provider-aware lifecycle** | The status appears on Z.ai providers and clears itself when you switch away |
| **Defensive parsing** | Unknown payload shapes degrade to empty limits; percentages clamp to 0-100; a hung request times out in 10s |
| **Zero runtime dependencies** | Type-only imports; the extension runs entirely on pi's extension API |
| **Provenance-locked parser** | `lib/zai-usage.ts` is lifted verbatim from gentle-pi's `shell-usage`, so the standalone meter and the official integration share one battle-tested contract |

## Install

```bash
pi install npm:pi-zai-usage
```

From a local checkout (before the npm release):

```bash
pi install /path/to/pi-zai-usage
```

Then restart pi, pick a Z.ai model (`zai` / `zai-glm` provider), and the meter arrives with the first fetch. `/zai:usage` forces one immediately.

## Quick start

1. Have a Z.ai API key configured — the extension resolves it through pi's model registry (`getApiKeyForProvider`) and falls back to `ZAI_GLM_API_KEY` or `ZAI_API_KEY` in the environment.
2. Switch to a Z.ai provider model (`/model`, or Ctrl+P cycling).
3. The meter appears:
	- **Gentle Shell installed**: Z.ai rides the shell's native usage surfaces — the same store, header, and `/gentle:usage` panel its built-in Codex/Claude sources feed. Registration is load-order independent (the shell subscribes before any `session_start` fires) and forces one refresh when a Z.ai model is already active, so the first windows show up without waiting for the shell's 5-minute cycle.
	- **No gentle-pi**: the compact segment `zai 5h ▰▰▰▱▱▱▱▱ 34% · week 11%` rides pi's native footer as the trailing status segment.
	- **Both worlds**: event delivery has no acknowledgement, so the extension cannot tell whether gentle-pi consumed the registration — the standalone segment keeps rendering (in gentle-pi's footer or its sidebar Integrations group). `/zai:usage off` hides that segment only.

4. `/zai:usage` opens the subscriptions panel (same frame and keys as gentle-pi's `/gentle:usage`):

```text
 ╭─ ✿ Subscriptions ──────────────────────────────────────╮
 │ ✿ zai · max · updated just now                          │
 │   zai                                                   │
 │     5h    ▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  34%  resets in 3h 12m       │
 │     week  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  11%  resets in 5d 9h        │
 │ r refresh   esc close                                   │
 ╰─────────────────────────────────────────────────────────╯
```

## Commands

| Command | Effect |
| --- | --- |
| `/zai:usage` | Force-refresh and open the `✿ Subscriptions` panel (a failed quota request is announced; in RPC mode the windows are notified as plain lines) |
| `/zai:usage off` | Hide the **standalone** status segment only — the native usage Gentle Shell already recorded from the event is untouched |
| `/zai:usage on` | Restore the status segment and refresh |

## How the meter reads the endpoint

The quota endpoint (`https://api.z.ai/api/monitor/usage/quota/limit`) is undocumented; the contract below is what the parser enforces, and what the tests pin:

- The payload carries a `data.limits` array. One entry becomes one window when it names a **known token-window unit** — `3` maps to the 5-hour rolling window (18,000s), `6` to the weekly one (604,800s) — **and** a `TOKENS_LIMIT` or `CREDIT_LIMIT` type, **and** a finite `percentage`.
- Everything else is skipped: the web-search counter (`TIME_LIMIT`) rides the same array and intentionally stays out of the subscription view; unknown units, mystery types, non-numeric percentages, and `null` entries degrade to empty limits instead of errors.
- Percentages outside 0-100 are clamped, so a stray server value can never render a broken bar. A window at 100% marks the limit reached.
- Resets arrive as epoch milliseconds; the panel renders them as `resets in 2h 13m` style notes, quiet when unknown.
- The key is sent as a bearer token, requests time out in 10 seconds, and any failure — missing key, non-OK response, parse miss — is silent on background refreshes and announced on user-triggered ones.

## Relationship to gentle-pi

Gentle Shell's official third-party usage-source event is the native path, and this package registers on it while keeping a standalone meter that works with or without the shell.

- `lib/zai-usage.ts` is lifted verbatim from gentle-pi's `lib/shell-usage.ts` (branch `feat/zai-usage-meter`), including its parser tests. The standalone parser and the shell's own stay in sync by shared provenance.
- The rendering is a port, not a lookalike: the status paints `renderUsageBar`'s exact bar segment (8-cell gauge with accent/warning/error tones and border-dimmed empty cells) and `lib/zai-usage-view.ts` ports gentle-pi's `UsageView` frame — same `✿ Subscriptions` title, same 16-cell panel meters, same `r refresh · esc close` keys — through pi's public `setStatus`/`ui.custom` contracts only. No pi-tui dependency, no forked UI.
- The native integration is gentle-pi's documented door: the shell emits nothing, it listens. It subscribes to `gentle-pi:usage-source/v1` (payload schema `gentle-pi.usage-source/v1`) when its extension factory runs — before any `session_start` fires, so registration from this side is load-order independent. The shell validates the payload field by field, replaces the previous source per provider instead of accumulating, resolves the provider-specific API key from pi's model registry and supplies it to the source, and falls back to nothing: this package's own environment fallback (`ZAI_GLM_API_KEY` / `ZAI_API_KEY`) covers consumers that pass no key. No gentle-pi file is read, imported, or patched.
- The earlier experimental sidebar decoration is gone on purpose: it wrapped an undocumented shared-state symbol (`gentle-pi.experimental-sidebar.state`), exactly the kind of surface a shell update could silently break. The usage-source event is the supported contract for the same job.

## Releasing

Releases publish automatically from version tags through [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. Bump `package.json` to the next version, commit, and push to `main`.
2. Tag the release on the freshly fetched `origin/main` commit — the workflow verifies the tag is annotated, matches `package.json`'s version, and points to a commit reachable from `main`:

   ```bash
   git fetch origin main --tags
   git tag -a vX.Y.Z "$(git rev-parse 'origin/main^{commit}')" -m "pi-zai-usage vX.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

3. CI installs, tests, typechecks, packs, publishes to npm with provenance, creates the GitHub Release if it is missing, and verifies the registry.

First-time setup: add an `NPM_TOKEN` secret (automation or granular token with publish rights for `pi-zai-usage`) under **Settings → Secrets and variables → Actions**. A run that failed for publication-only reasons can be retried without moving the tag: dispatch the workflow with the existing tag (`gh workflow run publish.yml -f tag=vX.Y.Z`).

## Development

```bash
pnpm install
pnpm test        # node --test over the parser, fetch, and rendering (no network)
pnpm typecheck   # tsc --noEmit against @earendil-works/pi-coding-agent types
```

The parser and renderer are pure; tests cover the documented payload shape, the legacy `CREDIT_LIMIT` plans, hostile inputs (wrong units, string percentages, over-range values, `null` entries), the fetch contract (bearer key, timeout, no key → no request), the gauge tones, the bar segment, the panel rows, the overlay view's `r`/`esc` handling, and the usage-source registration (both providers on the shell's event channel, consumer-supplied key preferred with environment fallback, nothing sent without a key). No test touches the network.

## Principles

- **Same parser, one truth.** The parsing contract is gentle-pi's; this package carries it verbatim rather than improvising a second one.
- **Degrade, never break.** An undocumented endpoint gets defensive parsing: unknown shapes cost the meter, not your session.
- **Quiet when background, loud when asked.** Automatic refreshes never interrupt; user-triggered commands always answer, including with bad news.
- **Zero footprint.** No runtime dependencies, no configuration surface, no data leaving the machine except the quota request itself.

## License

MIT — see [LICENSE](LICENSE).
