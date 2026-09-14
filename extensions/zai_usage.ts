// pi-zai-usage — Z.ai GLM Coding Plan usage meter as a Pi extension.
//
// Decoupled from gentle-pi on purpose: while the official gentle-pi
// integration waits on its issue, this extension meters the same quota
// endpoint with the same battle-tested parser (lib/zai-usage.ts, lifted from
// gentle-pi's shell-usage). When gentle-pi ships the official integration,
// retire this package.
//
// Surfaces, without touching gentle-pi: the bar segment travels through pi's
// public ctx.ui.setStatus contract — the same one gentle-pi's footer consumes
// (it renders it as the trailing segment of its status bar and in the
// sidebar's Integrations group; pi's native footer paints it with theme
// colors) — and /zai:usage opens the framed ✿ Subscriptions panel
// /gentle:usage opens. No gentle-pi internals are read or patched, so any
// gentle-pi update keeps this working.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ZaiUsageView } from "../lib/zai-usage-view.ts";
import {
	fetchZaiUsage,
	isZaiUsageProvider,
	plainTheme,
	renderUsageBar,
	type UsageTheme,
} from "../lib/zai-usage.ts";

const STATUS_KEY = "zai-usage";
const REFRESH_MS = 5 * 60_000;

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
		const bar = hidden || !current ? undefined : renderUsageBar(current, bindTheme(ctx));
		// A windowless payload has no segment; the footer stays quiet and the
		// panel carries the "no usage yet · r to fetch" note.
		ui.setStatus(STATUS_KEY, bar);
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

	function follow(ctx: ExtensionContext): void {
		stopTimer();
		if (!isZaiUsageProvider(providerOf(ctx) ?? "")) {
			paint(ctx); // clears the widget when switching away
			return;
		}
		timer = setInterval(() => void refresh(ctx, false), REFRESH_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (providerOf(ctx) && isZaiUsageProvider(providerOf(ctx) ?? ""))
			await refresh(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		current = undefined;
		fetchedAt = 0;
		await refresh(ctx, true);
		follow(ctx);
	});

	// gentle-pi refreshes its usage segment after every response; z.ai sends
	// no usage headers, so the same background refresh keeps the bar honest.
	pi.on("agent_end", (_event, ctx) => {
		void refresh(ctx, false);
	});

	pi.on("session_shutdown", () => stopTimer());

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
