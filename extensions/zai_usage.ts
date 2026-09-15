// pi-zai-usage — Z.ai GLM Coding Plan usage meter as a Pi extension.
//
// Decoupled from gentle-pi on purpose: while the official gentle-pi
// integration waits on its issue (gentle-pi#687), this extension meters the
// same quota endpoint with the same battle-tested parser (lib/zai-usage.ts,
// lifted from gentle-pi's shell-usage). When gentle-pi ships the official
// integration, retire this package.
//
// Surfaces, without patching gentle-pi:
// 1. Fullscreen sidebar rail: when gentle-pi's terminal-owned sidebar state is
//    present, the "footer" part (the Status card) is wrapped in place and the
//    z.ai usage block is appended right below it — the same sidebar that
//    carries gentle-pi's native Codex/Claude usage. The decorator only touches
//    the documented shared-state symbol; if gentle-pi is absent or refactored,
//    it reports inactive and the fallback surface carries the meter.
// 2. Fallback: the bar segment travels through pi's public ctx.ui.setStatus
//    contract — gentle-pi's footer renders it as the trailing segment of its
//    narrow status bar and in the sidebar's Integrations group. While the rail
//    decoration is painting, the setStatus segment is cleared so the meter
//    never shows twice.
// 3. /zai:usage opens the framed ✿ Subscriptions panel /gentle:usage opens.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	fetchZaiUsage,
	isZaiUsageProvider,
	plainTheme,
	renderUsageBar,
	renderUsagePanel,
	type UsageTheme,
} from "../lib/zai-usage.ts";
import { wrapFooterRail, type RailWrap } from "../lib/zai-rail.ts";
import { ZaiUsageView } from "../lib/zai-usage-view.ts";

const STATUS_KEY = "zai-usage";
const RAIL_WIDGET_KEY = "zai-usage-rail";
const REFRESH_MS = 5 * 60_000;
// gentle-pi registers its footer rail part from inside its own session_start
// wiring, which may run after this extension's; a few idempotent retries (plus
// an ensure() on every later refresh) close the race without coupling.
const RAIL_ENSURE_DELAYS_MS = [0, 250, 1_000, 3_000, 8_000] as const;

function bindTheme(ctx: ExtensionContext): UsageTheme {
	const theme = (ctx.ui as { theme?: { fg(color: string, text: string): string } })
		.theme;
	// Role names are pi theme colors (text, muted, dim, border, accent,
	// warning, error, customMessageLabel), the same ones gentle-pi paints with.
	return {
		fg(color, text) {
			return theme
				? theme.fg(color as Parameters<typeof theme.fg>[0], text)
				: text;
		},
	};
}

function apiKeyFromEnv(): string | undefined {
	return process.env.ZAI_GLM_API_KEY ?? process.env.ZAI_API_KEY;
}

export default function zaiUsageExtension(pi: ExtensionAPI): void {
	let current: Awaited<ReturnType<typeof fetchZaiUsage>>;
	let fetchedAt = 0;
	let hidden = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let rail: RailWrap | undefined;
	let railTheme: UsageTheme | undefined;
	let retryTimers: ReturnType<typeof setTimeout>[] = [];
	let lastCtx: ExtensionContext | undefined;

	const providerOf = (ctx: ExtensionContext): string | undefined =>
		ctx.model?.provider;

	async function resolveKey(
		ctx: ExtensionContext,
		provider: string,
	): Promise<string | undefined> {
		const fromRegistry = await ctx.modelRegistry
			.getApiKeyForProvider(provider)
			.catch(() => undefined);
		return fromRegistry ?? apiKeyFromEnv();
	}

	function paint(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as { setStatus(key: string, text: string | undefined): void };
		void rail?.ensure();
		// While the sidebar rail is painting our block, the trailing status
		// segment is cleared so the meter never appears twice.
		const bar = rail?.painting()
			? undefined
			: hidden || !current
				? undefined
				: renderUsageBar(current, bindTheme(ctx));
		ui.setStatus(STATUS_KEY, bar);
		rail?.requestRender();
	}

	// The rail block is the ✿ Subscriptions panel content: active provider,
	// plan, updated-ago note and one metered row per window.
	function railLines(width: number): string[] {
		if (!current || hidden) return [];
		return renderUsagePanel(
			[current],
			railTheme ?? plainTheme,
			width,
			Date.now(),
			{ provider: current.provider },
		);
	}

	// gentle-pi's sidebar state lives on the terminal and is shared through a
	// well-known symbol; the widget factory is the public hook that hands us
	// the TUI (and its theme) without opening an overlay.
	function captureRail(ctx: ExtensionContext): void {
		if (!ctx.hasUI || rail) return;
		const ui = ctx.ui as {
			setWidget(
				key: string,
				content:
					| string[]
					| ((
							tui: unknown,
							theme: { fg(color: string, text: string): string },
					  ) => { render(width: number): string[]; invalidate?(): void }),
				options?: unknown,
			): void;
		};
		try {
			ui.setWidget(RAIL_WIDGET_KEY, (tui, theme) => {
				if (!rail) {
					railTheme = { fg: (color, text) => theme.fg(color, text) };
					const terminal = (tui as { terminal?: unknown }).terminal;
					const requestRender = () =>
						void (tui as { requestRender?: () => void }).requestRender?.();
					rail = wrapFooterRail(terminal, requestRender, {
						lines: railLines,
						digest: () =>
							JSON.stringify([
								current?.fetchedAt ?? 0,
								current?.limits.map((limit) =>
									limit.windows.map((window) => [window.label, window.usedPercent, window.resetAt]),
								) ?? null,
								hidden,
							]),
					});
					scheduleRailEnsure();
				}
				return { render: () => [] };
			});
		} catch {
			// The widget surface is optional; the fallback segment still works.
		}
	}

	function scheduleRailEnsure(): void {
		for (const delay of RAIL_ENSURE_DELAYS_MS) {
			retryTimers.push(
				setTimeout(() => {
					// A successful late wrap must also repaint the status segment:
					// otherwise the fallback line in Integrations lingers until the
					// next refresh even though the rail now carries the meter.
					void rail?.ensure();
					rail?.requestRender();
					if (lastCtx) paint(lastCtx);
				}, delay),
			);
		}
	}

	async function refresh(
		ctx: ExtensionContext,
		force: boolean,
		announce = false,
	): Promise<void> {
		const provider = providerOf(ctx);
		if (!provider || !isZaiUsageProvider(provider)) return;
		const now = Date.now();
		if (!force && current && now - fetchedAt < REFRESH_MS) return;
		const key = await resolveKey(ctx, provider);
		const fetched = await fetchZaiUsage(provider, key, fetch, now);
		if (!fetched) {
			// Background refreshes stay quiet, but a user-triggered refresh
			// deserves an answer: "no usage yet" and "the quota request
			// failed" are different situations.
			if (announce)
				ctx.ui.notify(
					`${provider} usage unavailable: the quota request failed or the payload had no windows`,
					"warning",
				);
			return;
		}
		current = fetched;
		fetchedAt = now;
		paint(ctx);
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function stopRetries(): void {
		for (const handle of retryTimers) clearTimeout(handle);
		retryTimers = [];
	}

	function follow(ctx: ExtensionContext): void {
		stopTimer();
		if (!isZaiUsageProvider(providerOf(ctx) ?? "")) {
			paint(ctx); // clears the widget when switching away
			return;
		}
		timer = setInterval(() => void refresh(ctx, false), REFRESH_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		captureRail(ctx);
		if (providerOf(ctx) && isZaiUsageProvider(providerOf(ctx) ?? "")) {
			await refresh(ctx, true);
			follow(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		lastCtx = ctx;
		current = undefined;
		fetchedAt = 0;
		await refresh(ctx, true);
		follow(ctx);
	});

	// gentle-pi refreshes its usage segment after every response; z.ai sends
	// no usage headers, so the same background refresh keeps the bar honest.
	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		captureRail(ctx);
		void refresh(ctx, false);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		stopRetries();
	});

	pi.registerCommand("zai:usage", {
		description: "Show the Z.ai subscription usage panel. Press r to refetch.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off") {
				hidden = true;
				paint(ctx);
				ctx.ui.notify("z.ai usage status hidden", "info");
				return;
			}
			if (arg === "on") hidden = false;
			const provider = providerOf(ctx);
			if (!provider || !isZaiUsageProvider(provider)) {
				ctx.ui.notify(
					`z.ai usage needs an active z.ai provider (current: ${provider ?? "none"})`,
					"warning",
				);
				return;
			}
			await refresh(ctx, true, true);
			if (!current) return; // refresh() already announced the failure
			paint(ctx);
			if (!ctx.hasUI) {
				// No TUI (RPC/print mode): plain segment instead of the overlay.
				ctx.ui.notify(renderUsageBar(current, plainTheme) ?? "no usage windows", "info");
				follow(ctx);
				return;
			}
			const refreshFromPanel = async () => {
				await refresh(ctx, true);
				paint(ctx);
			};
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) =>
					new ZaiUsageView({
						theme,
						now: () => Date.now(),
						usage: () => current,
						active: () => ({ provider: providerOf(ctx) ?? provider }),
						onRefresh: refreshFromPanel,
						onClose: () => done(null),
						requestRender: () => tui.requestRender(),
					}),
				// Same overlay frame /gentle:usage opens in gentle-pi.
				{ overlay: true, overlayOptions: { width: "70%", minWidth: 60, anchor: "center" } },
			);
			follow(ctx);
		},
	});
}
