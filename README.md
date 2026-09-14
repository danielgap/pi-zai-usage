# pi-zai-usage

[![pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://github.com/danielgap/pi-zai-usage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/danielgap/pi-zai-usage?style=flat&color=yellow)](https://github.com/danielgap/pi-zai-usage/stargazers)
[![tests](https://img.shields.io/badge/tests-15%2F15-brightgreen)](#development)
[![parser provenance](https://img.shields.io/badge/parser-gentle--pi%20branch-ff69b4)](#relationship-to-gentle-pi)

**Meter your Z.ai GLM Coding Plan usage in pi, without guessing when the window resets.**

`pi-zai-usage` adds a usage meter for the Z.ai GLM Coding Plan to [pi](https://shittycodingagent.ai): a status-bar segment with the 5-hour and weekly token windows, a `/zai:usage` command that opens the `✿ Subscriptions` panel, and automatic refresh — every 5 minutes and after each response — while a Z.ai provider is active.

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
| **Status-bar segment** | The Gentle Shell bar segment: `zai 5h ▰▰▱▱▱▱▱▱ 42% · week 71%` — first window gauged, the rest compact — delivered through pi's public `ctx.ui.setStatus` contract |
| **`/zai:usage` command** | Opens the `✿ Subscriptions` panel gentle-pi's `/gentle:usage` opens: 16-cell meters, reset countdowns, plan, `updated Xm ago`; `r` refetches, `esc` closes |
| **`/zai:usage off` / `on`** | Hides or restores the status segment without uninstalling |
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
3. The segment appears in the status bar — as the trailing segment of gentle-pi's bottom bar (and in the sidebar's Integrations group), or themed in pi's native footer when gentle-pi is not installed:

```text
 zai 5h ▰▰▰▱▱▱▱▱ 34% · week 11%
 zai 5h ▰▰▰▱▱▱▱▱ 34% · week 11%
```

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
| `/zai:usage off` | Hide the status segment |
| `/zai:usage on` | Restore the status segment and refresh |

## How the meter reads the endpoint

The quota endpoint (`https://api.z.ai/api/monitor/usage/quota/limit`) is undocumented; the contract below is what the parser enforces, and what the tests pin:

- The payload carries a `data.limits` array. One entry becomes one window when it names a **known token-window unit** — `3` maps to the 5-hour rolling window (18,000s), `6` to the weekly one (604,800s) — **and** a `TOKENS_LIMIT` or `CREDIT_LIMIT` type, **and** a finite `percentage`.
- Everything else is skipped: the web-search counter (`TIME_LIMIT`) rides the same array and intentionally stays out of the subscription view; unknown units, mystery types, non-numeric percentages, and `null` entries degrade to empty limits instead of errors.
- Percentages outside 0-100 are clamped, so a stray server value can never render a broken bar. A window at 100% marks the limit reached.
- Resets arrive as epoch milliseconds; the panel renders them as `resets in 2h 13m` style notes, quiet when unknown.
- The key is sent as a bearer token, requests time out in 10 seconds, and any failure — missing key, non-OK response, parse miss — is silent on background refreshes and announced on user-triggered ones.

## Relationship to gentle-pi

This package is the decoupled home of the usage meter while the official gentle-pi integration waits on its upstream issue. Keeping a feature branch alive against a fast-moving main is its own tax; a standalone extension meters the same quota today, with the same code the integration would ship.

- `lib/zai-usage.ts` is lifted verbatim from gentle-pi's `lib/shell-usage.ts` (branch `feat/zai-usage-meter`), including its parser tests. When gentle-pi ships the official integration, both stay in sync by shared provenance, and this package retires.
- The rendering is a port, not a lookalike: the status paints `renderUsageBar`'s exact bar segment (8-cell gauge with accent/warning/error tones and border-dimmed empty cells) and `lib/zai-usage-view.ts` ports gentle-pi's `UsageView` frame — same `✿ Subscriptions` title, same 16-cell panel meters, same `r refresh · esc close` keys — through pi's public `setStatus`/`ui.custom` contracts only. gentle-pi is never read or patched: it renders the status through the same `getExtensionStatuses()` footer contract pi documents, so any gentle-pi update keeps this working. No pi-tui dependency, no forked UI.

## Development

```bash
pnpm install
pnpm test        # node --test over the parser, fetch, and rendering (no network)
pnpm typecheck   # tsc --noEmit against @earendil-works/pi-coding-agent types
```

The parser and renderer are pure; tests cover the documented payload shape, the legacy `CREDIT_LIMIT` plans, hostile inputs (wrong units, string percentages, over-range values, `null` entries), the fetch contract (bearer key, timeout, no key → no request), the gauge tones, the bar segment, the panel rows, and the overlay view's `r`/`esc` handling.

## Principles

- **Same parser, one truth.** The parsing contract is gentle-pi's; this package carries it verbatim rather than improvising a second one.
- **Degrade, never break.** An undocumented endpoint gets defensive parsing: unknown shapes cost the meter, not your session.
- **Quiet when background, loud when asked.** Automatic refreshes never interrupt; user-triggered commands always answer, including with bad news.
- **Zero footprint.** No runtime dependencies, no configuration surface, no data leaving the machine except the quota request itself.

## License

MIT — see [LICENSE](LICENSE).
