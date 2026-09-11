# pi-zai-usage

[![pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://github.com/danielgap/pi-zai-usage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/danielgap/pi-zai-usage?style=flat&color=yellow)](https://github.com/danielgap/pi-zai-usage/stargazers)
[![tests](https://img.shields.io/badge/tests-9%2F9-brightgreen)](#development)
[![parser provenance](https://img.shields.io/badge/parser-gentle--pi%20branch-ff69b4)](#relationship-to-gentle-pi)

**Meter your Z.ai GLM Coding Plan usage in pi, without guessing when the window resets.**

`pi-zai-usage` adds a standalone usage meter for the Z.ai GLM Coding Plan to [pi](https://shittycodingagent.ai): a widget above the editor with the 5-hour and weekly token windows, a `/zai:usage` command for on-demand refresh, and automatic 5-minute polling while a Z.ai provider is active.

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
| **Usage widget** | One line per token window above the editor: `z.ai max 5h ▰▰▱▱▱▱▱▱ 42% resets in 2h 13m` |
| **`/zai:usage` command** | Forces a fresh fetch and reports every window; failures are announced, never silent |
| **`/zai:usage off` / `on`** | Hides or restores the widget without uninstalling |
| **Automatic refresh** | Polls every 5 minutes while a `zai` / `zai-glm` model is active |
| **Provider-aware lifecycle** | The widget appears on Z.ai providers and clears itself when you switch away |
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
3. The widget appears above the editor:

```text
 z.ai max 5h ▰▰▰▱▱▱▱▱ 34% resets in 3h 12m
 z.ai max week ▰▱▱▱▱▱▱▱ 11% resets in 5d 9h
```

1. `/zai:usage` refreshes on demand and echoes every window as a notification.

## Commands

| Command | Effect |
| --- | --- |
| `/zai:usage` | Force-refresh and show every window (a failed quota request is announced) |
| `/zai:usage off` | Hide the widget |
| `/zai:usage on` | Restore the widget and refresh |

## How the meter reads the endpoint

The quota endpoint (`https://api.z.ai/api/monitor/usage/quota/limit`) is undocumented; the contract below is what the parser enforces, and what the tests pin:

- The payload carries a `data.limits` array. One entry becomes one window when it names a **known token-window unit** — `3` maps to the 5-hour rolling window (18,000s), `6` to the weekly one (604,800s) — **and** a `TOKENS_LIMIT` or `CREDIT_LIMIT` type, **and** a finite `percentage`.
- Everything else is skipped: the web-search counter (`TIME_LIMIT`) rides the same array and intentionally stays out of the subscription view; unknown units, mystery types, non-numeric percentages, and `null` entries degrade to empty limits instead of errors.
- Percentages outside 0-100 are clamped, so a stray server value can never render a broken bar. A window at 100% marks the limit reached.
- Resets arrive as epoch milliseconds; the widget renders them as `resets in 2h 13m` style notes, quiet when unknown.
- The key is sent as a bearer token, requests time out in 10 seconds, and any failure — missing key, non-OK response, parse miss — is silent on background refreshes and announced on user-triggered ones.

## Relationship to gentle-pi

This package is the decoupled home of the usage meter while the official gentle-pi integration waits on its upstream issue. Keeping a feature branch alive against a fast-moving main is its own tax; a standalone extension meters the same quota today, with the same code the integration would ship.

- `lib/zai-usage.ts` is lifted verbatim from gentle-pi's `lib/shell-usage.ts` (branch `feat/zai-usage-meter`), including its parser tests. When gentle-pi ships the official integration, both stay in sync by shared provenance, and this package retires.
- The extension side is intentionally thin: where gentle-pi renders through the Gentle Shell bar and panel, this package uses pi's public `setWidget` API — no gentle-pi internals, no forked UI.

## Development

```bash
pnpm install
pnpm test        # node --test over the parser, fetch, and widget rendering (no network)
pnpm typecheck   # tsc --noEmit against @earendil-works/pi-coding-agent types
```

The parser and renderer are pure; tests cover the documented payload shape, the legacy `CREDIT_LIMIT` plans, hostile inputs (wrong units, string percentages, over-range values, `null` entries), the fetch contract (bearer key, timeout, no key → no request), and the widget lines.

## Principles

- **Same parser, one truth.** The parsing contract is gentle-pi's; this package carries it verbatim rather than improvising a second one.
- **Degrade, never break.** An undocumented endpoint gets defensive parsing: unknown shapes cost the meter, not your session.
- **Quiet when background, loud when asked.** Automatic refreshes never interrupt; user-triggered commands always answer, including with bad news.
- **Zero footprint.** No runtime dependencies, no configuration surface, no data leaving the machine except the quota request itself.

## License

MIT — see [LICENSE](LICENSE).
