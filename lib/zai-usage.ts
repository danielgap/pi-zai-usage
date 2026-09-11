// Z.ai GLM Coding Plan usage metering: pure parsing and rendering.
//
// Lifted verbatim from gentle-pi's lib/shell-usage.ts (branch
// feat/zai-usage-meter) so the gentle-pi integration and this standalone
// extension share one battle-tested parser. z.ai's quota endpoint is
// undocumented: the token windows arrive as integer percentages with
// epoch-millisecond resets (older plans labelled them CREDIT_LIMIT), so
// unknown shapes degrade to empty limits instead of failing.

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export const ZAI_PROVIDER = "zai";
export const ZAI_GLM_PROVIDER = "zai-glm";
export const ZAI_USAGE_PROVIDERS: readonly string[] = [
	ZAI_PROVIDER,
	ZAI_GLM_PROVIDER,
];
export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_MAIN_LIMIT = "zai";

// z.ai meters its GLM Coding Plan in token windows keyed by unit: 3 is the
// 5-hour rolling window, 6 the weekly one. The web-search counter rides the
// same array as TIME_LIMIT and stays out of the subscription view.
const ZAI_TOKEN_UNITS: ReadonlyMap<number, number> = new Map([
	[3, 18_000],
	[6, 604_800],
]);

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function isZaiUsageProvider(provider: string): boolean {
	return ZAI_USAGE_PROVIDERS.includes(provider);
}

export function windowLabel(seconds: number): string {
	if (seconds === WEEK) return "week";
	if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
	if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
	return `${Math.round(seconds / MINUTE)}m`;
}

export function formatReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "resets now";
	if (seconds < HOUR)
		return `resets in ${Math.max(1, Math.round(seconds / MINUTE))}m`;
	if (seconds < DAY)
		return `resets in ${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
	return `resets in ${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

interface RawZaiLimit {
	type?: string;
	unit?: number;
	percentage?: number;
	nextResetTime?: number;
}

interface RawZaiUsage {
	data?: { limits?: RawZaiLimit[]; level?: string } | null;
}

// One limits entry becomes one window when it names a known token-window
// unit, a token/credit limit type, and a finite percentage; everything else
// is skipped. Percentages outside 0-100 are clamped so a stray server value
// can never render a broken bar.
function zaiWindow(entry: RawZaiLimit): UsageWindow | undefined {
	const windowSeconds =
		typeof entry.unit === "number" ? ZAI_TOKEN_UNITS.get(entry.unit) : undefined;
	if (windowSeconds === undefined) return undefined;
	if (entry.type !== "TOKENS_LIMIT" && entry.type !== "CREDIT_LIMIT")
		return undefined;
	if (typeof entry.percentage !== "number" || !Number.isFinite(entry.percentage))
		return undefined;
	const usedPercent = Math.min(100, Math.max(0, entry.percentage));
	return {
		label: windowLabel(windowSeconds),
		usedPercent,
		windowSeconds,
		resetAt: typeof entry.nextResetTime === "number" ? entry.nextResetTime : null,
	};
}

export function parseZaiUsage(
	provider: string,
	payload: unknown,
	now: number,
): ProviderUsage {
	const raw = (payload ?? {}) as RawZaiUsage;
	const entries = Array.isArray(raw.data?.limits) ? raw.data.limits : [];
	const windows = entries
		.map((entry) => zaiWindow((entry ?? {}) as RawZaiLimit))
		.filter((window): window is UsageWindow => window !== undefined);
	const limitReached = windows.some((window) => window.usedPercent >= 100);
	const limits =
		windows.length > 0 ? [{ name: ZAI_MAIN_LIMIT, windows, limitReached }] : [];
	return {
		provider,
		plan: typeof raw.data?.level === "string" ? raw.data.level : undefined,
		limits,
		fetchedAt: now,
	};
}

// The quota endpoint is undocumented; the API key pi already holds is the
// only thing it needs, and unknown shapes degrade to "no usage yet". A
// bounded timeout keeps a hung request from pinning the refresh cycle.
export const ZAI_FETCH_TIMEOUT_MS = 10_000;

export async function fetchZaiUsage(
	provider: string,
	key: string | undefined,
	fetchFn: typeof fetch,
	now: number,
): Promise<ProviderUsage | undefined> {
	if (!key) return undefined;
	try {
		const response = await fetchFn(ZAI_USAGE_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(ZAI_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		return parseZaiUsage(provider, await response.json(), now);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Widget rendering — the standalone replacement for gentle-pi's shell bar.
// ---------------------------------------------------------------------------

/** Minimal color surface pi's ctx.ui.theme provides; kept structural for tests. */
export interface UsageTheme {
	fg(color: UsageColor, text: string): string;
}
export type UsageColor = "label" | "percent" | "separator" | "warn" | "muted";

export function paintGauge(percent: number, cells: number): string {
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells);
	return `${"▰".repeat(filled)}${"▱".repeat(Math.max(0, cells - filled))}`;
}

/** One widget line per usage window: `z.ai max 5h ▰▰▱▱▱▱▱▱ 42% · resets in 2h 13m`. */
export function renderWidgetLines(
	usage: ProviderUsage,
	theme: UsageTheme,
	now: number,
): string[] {
	const head = theme.fg("label", `z.ai${usage.plan ? ` ${usage.plan}` : ""}`);
	const main = usage.limits[0];
	if (!main)
		return [head, theme.fg("muted", "no usage windows in the quota payload")];
	const lines = main.windows.map((window) => {
		const meter = theme.fg(
			window.usedPercent >= 80 ? "warn" : "label",
			paintGauge(window.usedPercent, 8),
		);
		const percent = theme.fg(
			window.usedPercent >= 80 ? "warn" : "percent",
			`${Math.round(window.usedPercent)}%`,
		);
		const reset =
			window.resetAt === null
				? ""
				: ` ${theme.fg("muted", formatReset(window.resetAt, now))}`;
		return `${head} ${theme.fg("label", window.label)} ${meter} ${percent}${reset}`;
	});
	if (main.limitReached)
		lines.push(theme.fg("warn", "limit reached — window must reset"));
	return lines;
}

/** Plain ANSI-free lines (tests and non-TUI fallbacks). */
export function renderPlainLines(usage: ProviderUsage, now: number): string[] {
	return renderWidgetLines(usage, plainTheme, now);
}

const plainTheme: UsageTheme = { fg: (_color, text) => text };
