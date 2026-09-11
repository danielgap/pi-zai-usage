// pi-zai-usage — Z.ai GLM Coding Plan usage meter as a standalone Pi extension.
//
// Decoupled from gentle-pi on purpose: while the official gentle-pi
// integration waits on its issue, this extension meters the same quota
// endpoint with the same battle-tested parser (lib/zai-usage.ts, lifted from
// gentle-pi's shell-usage). When gentle-pi ships the official integration,
// retire this package.
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	fetchZaiUsage,
	isZaiUsageProvider,
	renderWidgetLines,
	type UsageTheme,
} from "../lib/zai-usage.ts";

const WIDGET_ID = "zai-usage";
const REFRESH_MS = 5 * 60_000;

/** Only pi-documented color names are used. */
const PI_COLORS: Record<string, string> = {
	label: "muted",
	percent: "accent",
	warn: "warning",
	separator: "dim",
	muted: "dim",
};

function bindTheme(ctx: ExtensionContext): UsageTheme {
	const t = (ctx.ui as { theme?: { fg(color: string, text: string): string } })
		.theme;
	return {
		fg(color, text) {
			return t ? t.fg(PI_COLORS[color] ?? "dim", text) : text;
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

	function paint(ctx: ExtensionContext, now: number): void {
		if (!ctx.hasUI) return;
		if (hidden || !current) {
			(
				ctx.ui as { setWidget(id: string, lines: string[] | undefined): void }
			).setWidget(WIDGET_ID, undefined);
			return;
		}
		(
			ctx.ui as { setWidget(id: string, lines: string[] | undefined): void }
		).setWidget(WIDGET_ID, renderWidgetLines(current, bindTheme(ctx), now));
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
		paint(ctx, now);
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function follow(ctx: ExtensionContext): void {
		stopTimer();
		if (!isZaiUsageProvider(providerOf(ctx) ?? "")) {
			paint(ctx, Date.now()); // clears the widget when switching away
			return;
		}
		timer = setInterval(() => void refresh(ctx, false), REFRESH_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (providerOf(ctx) && isZaiUsageProvider(providerOf(ctx) ?? ""))
			await refresh(ctx, false);
	});

	pi.on("model_select", async (_event, ctx) => {
		current = undefined;
		fetchedAt = 0;
		await refresh(ctx, true);
		follow(ctx);
	});

	pi.on("session_shutdown", () => stopTimer());

	pi.registerCommand("zai:usage", {
		description: "Refresh the z.ai GLM Coding Plan usage meter (off hides it)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off") {
				hidden = true;
				paint(ctx, Date.now());
				ctx.ui.notify("z.ai usage widget hidden", "info");
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
			paint(ctx, Date.now());
			for (const line of renderWidgetLines(current, bindTheme(ctx), Date.now()))
				ctx.ui.notify(line, "info");
			follow(ctx);
		},
	});
}
