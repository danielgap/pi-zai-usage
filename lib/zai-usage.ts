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
// Rendering — ported from gentle-pi's lib/shell-usage.ts + lib/shell-gauge.ts
// so the standalone meter paints exactly what the Gentle Shell bar and the
// Subscriptions panel paint for Codex/Claude: one compact bar segment (first
// window gauged, the rest compact) and one detailed panel row per window.
// ---------------------------------------------------------------------------

/** Color surface pi's ctx.ui.theme provides; kept structural for tests. */
export interface UsageTheme {
	fg(color: string, text: string): string;
}

// Theme roles gentle-pi paints usage with; keys are pi theme colors.
const ROLE = {
	PROVIDER: "text",
	PLAN: "muted",
	LIMIT: "customMessageLabel",
	LABEL: "muted",
	PERCENT: "text",
	RESET: "dim",
	SEPARATOR: "muted",
} as const;

export const BAR_METER_CELLS = 8;
export const PANEL_METER_CELLS = 16;
const GAUGE_FILLED = "▰";
const GAUGE_EMPTY = "▱";
const GAUGE_EMPTY_ROLE = "border";
export const WARNING_THRESHOLD = 80;
export const ERROR_THRESHOLD = 95;

export function renderGauge(percent: number, cells: number = BAR_METER_CELLS): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(cells - filled);
}

export type GaugeTone = "accent" | "warning" | "error" | "dim";

export function gaugeTone(percent: number): GaugeTone {
	if (percent >= ERROR_THRESHOLD) return "error";
	if (percent >= WARNING_THRESHOLD) return "warning";
	return "accent";
}

export function paintGauge(percent: number, theme: UsageTheme, cells: number = BAR_METER_CELLS): string {
	const gauge = renderGauge(percent, cells);
	const filled = gauge.replace(new RegExp(`${GAUGE_EMPTY}+$`), "");
	return theme.fg(gaugeTone(percent), filled) + theme.fg(GAUGE_EMPTY_ROLE, gauge.slice(filled.length));
}

/** The Gentle Shell bar segment: first window gauged, the rest compact. */
export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme): string | undefined {
	const main = usage.limits[0];
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	const head = `${theme.fg(ROLE.LABEL, main.name)} ${theme.fg(ROLE.LABEL, first.label)} ${paintGauge(first.usedPercent, theme, BAR_METER_CELLS)} ${theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)}`;
	const tail = rest.map((window) => `${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.LABEL, window.label)} ${theme.fg(ROLE.PERCENT, `${Math.round(window.usedPercent)}%`)}`);
	return [head, ...tail].join(" ");
}

function updatedAgo(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "updated just now" : `updated ${minutes}m ago`;
}

export const ACTIVE_MARK = "✿";
export const ZAI_PENDING_NOTE = "no usage yet · r to fetch";
export const USAGE_EMPTY_MESSAGE = "No subscription usage yet. Usage arrives with the next response, or press r to fetch it.";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Visible width of an ANSI-painted string; every glyph used is width 1. */
export function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

/** Plain clip to a visible width with an ellipsis, ANSI sequences copied whole. */
export function clipToWidth(text: string, max: number): string {
	let clipped = "";
	let width = 0;
	let index = 0;
	while (index < text.length) {
		if (text[index] === "\x1b") {
			const sequence = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
			if (sequence) {
				clipped += sequence[0];
				index += sequence[0].length;
				continue;
			}
		}
		const char = text[index] ?? "";
		if (width + 1 > max - 1) break;
		clipped += char;
		width += 1;
		index += 1;
	}
	return width < visibleWidth(text) ? `${clipped}…` : clipped;
}

export interface ActiveProvider {
	provider: string;
}

export function zaiProviderNote(provider: string): string {
	return isZaiUsageProvider(provider) ? ZAI_PENDING_NOTE : "no subscription usage for this provider";
}

// The active provider line leads with the petal and explains itself when it
// has no data yet; every window then gets its own metered row.
export function renderUsagePanel(usages: ProviderUsage[], theme: UsageTheme, width: number, now: number, active?: ActiveProvider): string[] {
	const activeUsage = active ? usages.find((usage) => usage.provider === active.provider) : undefined;
	const others = usages.filter((usage) => usage !== activeUsage);
	if (!active && usages.length === 0) return [clipToWidth(USAGE_EMPTY_MESSAGE, width)];
	const lines: string[] = [];
	if (active && !activeUsage) {
		lines.push(`${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ${theme.fg(ROLE.PROVIDER, active.provider)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, zaiProviderNote(active.provider))}`);
	}
	for (const usage of [...(activeUsage ? [activeUsage] : []), ...others]) {
		const mark = usage === activeUsage ? `${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ` : "";
		const plan = usage.plan ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		lines.push(`${mark}${theme.fg(ROLE.PROVIDER, usage.provider)}${plan} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, updatedAgo(usage.fetchedAt, now))}`);
		for (const limit of usage.limits) {
			lines.push(`  ${theme.fg(ROLE.LIMIT, limit.name)}`);
			for (const window of limit.windows) {
				const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
				lines.push(`    ${theme.fg(ROLE.LABEL, window.label.padEnd(5))} ${paintGauge(window.usedPercent, theme, PANEL_METER_CELLS)} ${theme.fg(ROLE.PERCENT, percent)}  ${theme.fg(ROLE.RESET, formatReset(window.resetAt, now))}`);
			}
		}
	}
	return lines.map((line) => clipToWidth(line, width));
}

/** Plain ANSI-free theme (tests and non-TUI fallbacks). */
export const plainTheme: UsageTheme = { fg: (_color, text) => text };
