// pi-zai-usage — Z.ai GLM Coding Plan usage meter as a Pi extension.
//
// Surfaces, without patching gentle-pi:
// 1. Native Gentle Shell usage: gentle-pi documents a third-party usage-source
//    event ("gentle-pi:usage-source/v1", payload schema
//    "gentle-pi.usage-source/v1"). Both z.ai providers are registered on it
//    from session_start — not only the active one — so the shell's native
//    usage store meters z.ai exactly like its built-in Codex/Claude sources.
//    gentle-shell subscribes when its extension factory runs, before any
//    session_start fires, so this registration is load-order independent; it
//    resolves the provider-specific API key itself and hands it to the source,
//    which falls back to the environment when the consumer supplies none.
// 2. Standalone fallback: the bar segment travels through pi's public
//    ctx.ui.setStatus contract — gentle-pi's footer renders it as the trailing
//    segment of its narrow status bar and in the sidebar's Integrations group,
//    and pi's native footer renders it when gentle-pi is absent. Event
//    delivery has no acknowledgement, so the extension cannot know whether
//    gentle-pi consumed the registration: the standalone segment stays.
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
	type UsageTheme,
	ZAI_PENDING_NOTE,
	ZAI_USAGE_PROVIDERS,
} from "../lib/zai-usage.ts";
import { ZaiUsageView } from "../lib/zai-usage-view.ts";

const STATUS_KEY = "zai-usage";
const REFRESH_MS = 5 * 60_000;

// gentle-pi's third-party usage-source contract (lib/shell-usage.ts). The
// versioned constants are mirrored verbatim: the payload crosses the event
// bus, where gentle-shell validates the shape and ignores anything else.
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

/** The slice of pi's EventBus the usage-source registration needs. */
export interface UsageSourceBus {
	emit(channel: string, payload: unknown): void;
}

// Register both z.ai providers as gentle-shell usage sources. The shell only
// fetches the source of the *active* provider, but knowing both up front means
// switching models later finds the source already registered. Re-registration
// replaces the previous source per provider, so a repeated session_start is a
// no-op in effect, not an accumulation. Nothing here fetches or touches the
// network: the shell decides when (and for which provider) to call fetch.
export function registerUsageSources(bus: UsageSourceBus): void {
	for (const provider of ZAI_USAGE_PROVIDERS) {
		bus.emit(USAGE_SOURCE_EVENT, {
			schema: USAGE_SOURCE_SCHEMA,
			provider,
			pendingNote: ZAI_PENDING_NOTE,
			// The consumer resolves the provider-specific key from pi's model
			// registry and supplies it here; the environment is only the fallback
			// for consumers that pass no key.
			fetch: (apiKey: string | undefined, fetchFn: typeof fetch, now: number) =>
				fetchZaiUsage(provider, apiKey ?? apiKeyFromEnv(), fetchFn, now),
		});
	}
}

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
		ui.setStatus(
			STATUS_KEY,
			hidden || !current ? undefined : renderUsageBar(current, bindTheme(ctx)),
		);
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
		// Both providers, every session: gentle-shell listens from its factory
		// (before any session_start) and replaces per provider, so this is
		// load-order independent and idempotent. Registering only the active
		// provider would leave the shell blind after a model switch.
		registerUsageSources(pi.events);
		if (providerOf(ctx) && isZaiUsageProvider(providerOf(ctx) ?? "")) {
			await refresh(ctx, true);
			follow(ctx);
		}
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

	pi.on("session_shutdown", () => {
		stopTimer();
	});

	pi.registerCommand("zai:usage", {
		description: "Show the Z.ai subscription usage panel. Press r to refetch.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off") {
				// Standalone-only: this hides the setStatus segment, never the
				// native usage gentle-shell already records from the event.
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
