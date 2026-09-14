import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clipToWidth,
	fetchZaiUsage,
	formatReset,
	gaugeTone,
	isZaiUsageProvider,
	paintGauge,
	parseZaiUsage,
	plainTheme,
	renderGauge,
	renderUsageBar,
	renderUsagePanel,
	USAGE_EMPTY_MESSAGE,
	visibleWidth,
	windowLabel,
	ZAI_GLM_PROVIDER,
	ZAI_PENDING_NOTE,
	ZAI_PROVIDER,
	ZAI_USAGE_PROVIDERS,
	ZAI_USAGE_URL,
	type ProviderUsage,
} from "../lib/zai-usage.ts";
import { ZaiUsageView } from "../lib/zai-usage-view.ts";

const NOW = 1_789_000_000_000;

test("windowLabel renders the shared labels the widget shows", () => {
	assert.equal(windowLabel(18_000), "5h");
	assert.equal(windowLabel(604_800), "week");
	assert.equal(windowLabel(3_600), "1h");
	assert.equal(windowLabel(90), "2m");
});

test("formatReset stays quiet for unknown resets and humanizes the rest", () => {
	assert.equal(formatReset(null, NOW), "");
	assert.equal(formatReset(NOW + 30_000, NOW), "resets in 1m");
	assert.equal(formatReset(NOW + 7_200_000, NOW), "resets in 2h 0m");
	assert.equal(formatReset(NOW - 1, NOW), "resets now");
});

const ZAI_PAYLOAD = {
	code: 200,
	msg: "Operation successful",
	data: {
		limits: [
			{
				type: "TIME_LIMIT",
				unit: 5,
				number: 1,
				usage: 4000,
				currentValue: 0,
				remaining: 4000,
				percentage: 0,
				nextResetTime: 1789651429999,
				usageDetails: [{ modelCode: "search-prime", usage: 0 }],
			},
			{
				type: "TOKENS_LIMIT",
				unit: 3,
				number: 5,
				percentage: 5,
				nextResetTime: 1788824370973,
			},
			{
				type: "TOKENS_LIMIT",
				unit: 6,
				number: 1,
				percentage: 6,
				nextResetTime: 1789392229980,
			},
		],
		level: "max",
	},
	success: true,
};

test("parseZaiUsage keeps the plan and the two token windows, and drops the search counter", () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	assert.equal(usage.provider, "zai-glm");
	assert.equal(usage.plan, "max");
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(
		usage.limits.map((limit) => ({
			name: limit.name,
			limitReached: limit.limitReached,
			windows: limit.windows.map(
				(w) => `${w.label}:${w.usedPercent}:${w.windowSeconds}:${w.resetAt}`,
			),
		})),
		[
			{
				name: "zai",
				limitReached: false,
				windows: ["5h:5:18000:1788824370973", "week:6:604800:1789392229980"],
			},
		],
	);
});

test("parseZaiUsage accepts CREDIT_LIMIT windows and degrades to empty limits without throwing", () => {
	const credit = parseZaiUsage(
		ZAI_PROVIDER,
		{
			data: {
				limits: [
					{
						type: "CREDIT_LIMIT",
						unit: 3,
						percentage: 41,
						nextResetTime: 1788824370973,
					},
				],
				level: "lite",
			},
		},
		NOW,
	);
	assert.deepEqual(
		credit.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}`),
		["5h:41"],
	);
	assert.equal(credit.plan, "lite");

	const missingReset = parseZaiUsage(
		ZAI_PROVIDER,
		{ data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 3 }] } },
		NOW,
	);
	assert.deepEqual(
		missingReset.limits[0].windows.map((w) => w.resetAt),
		[null],
	);

	const unusable = parseZaiUsage(
		ZAI_PROVIDER,
		{
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, percentage: "5" },
					{ type: "TOKENS_LIMIT", unit: 9, percentage: 7 },
					{ type: "MYSTERY_LIMIT", unit: 6, percentage: 7 },
					null,
				],
			},
		},
		NOW,
	);
	assert.deepEqual(unusable.limits, []);
	assert.equal(unusable.plan, undefined);

	assert.deepEqual(parseZaiUsage(ZAI_PROVIDER, null, NOW).limits, []);
	assert.deepEqual(parseZaiUsage(ZAI_PROVIDER, undefined, NOW).limits, []);
});

test("parseZaiUsage clamps percentages into 0-100 and marks the limit reached at 100", () => {
	const payload = {
		data: {
			limits: [
				{
					type: "TOKENS_LIMIT",
					unit: 3,
					percentage: 137,
					nextResetTime: 1788824370973,
				},
				{
					type: "TOKENS_LIMIT",
					unit: 6,
					percentage: -7,
					nextResetTime: 1789392229980,
				},
			],
			level: "max",
		},
	};
	const usage = parseZaiUsage(ZAI_PROVIDER, payload, NOW);
	const windows = usage.limits[0]?.windows ?? [];
	assert.equal(
		windows[0]?.usedPercent,
		100,
		"an over-range percentage is clamped down to 100",
	);
	assert.equal(
		windows[1]?.usedPercent,
		0,
		"a negative percentage is clamped up to 0",
	);
	assert.equal(usage.limits[0]?.limitReached, true);
});

test("the zai providers are the supported ones", () => {
	assert.deepEqual(ZAI_USAGE_PROVIDERS, ["zai", "zai-glm"]);
	assert.equal(isZaiUsageProvider("zai"), true);
	assert.equal(isZaiUsageProvider("zai-glm"), true);
	assert.equal(isZaiUsageProvider("openai-codex"), false);
});

function fakeZaiFetch(payload: unknown = ZAI_PAYLOAD, ok = true) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return { ok, json: async () => payload } as Response;
	}) as typeof fetch;
	return { fetchFn, calls };
}

test("fetchZaiUsage sends the bearer key and parses the quota payload", async () => {
	const { fetchFn, calls } = fakeZaiFetch();
	const usage = await fetchZaiUsage(ZAI_GLM_PROVIDER, "zai-key", fetchFn, NOW);
	assert.equal(usage?.provider, "zai-glm");
	assert.equal(usage?.plan, "max");
	assert.equal(calls[0].url, ZAI_USAGE_URL);
	assert.equal(calls[0].headers.Authorization, "Bearer zai-key");

	const silent = fakeZaiFetch();
	assert.equal(
		await fetchZaiUsage(ZAI_PROVIDER, undefined, silent.fetchFn, NOW),
		undefined,
	);
	assert.equal(
		silent.calls.length,
		0,
		"without a key nothing must be sent anywhere",
	);
	assert.equal(
		await fetchZaiUsage(
			ZAI_PROVIDER,
			"zai-key",
			fakeZaiFetch({}, false).fetchFn,
			NOW,
		),
		undefined,
	);
});

test("the gauge mirrors gentle-pi's shell-gauge: cells, clamps, and tones", () => {
	assert.equal(renderGauge(50, 8), "▰▰▰▰▱▱▱▱");
	assert.equal(renderGauge(0), "▱▱▱▱▱▱▱▱");
	assert.equal(renderGauge(100, 16), "▰".repeat(16));
	assert.equal(renderGauge(137, 8), "▰".repeat(8), "over-range clamps to full");
	assert.equal(gaugeTone(0), "accent");
	assert.equal(gaugeTone(79.9), "accent");
	assert.equal(gaugeTone(80), "warning");
	assert.equal(gaugeTone(94.9), "warning");
	assert.equal(gaugeTone(95), "error");
});

test("paintGauge splits tones: filled by threshold, empty cells in border", () => {
	const recorded: Array<[string, string]> = [];
	const theme = {
		fg(color: string, text: string) {
			recorded.push([color, text]);
			return `[${color}]${text}`;
		},
	};
	assert.equal(paintGauge(50, theme, 4), "[accent]▰▰[border]▱▱");
	assert.deepEqual(recorded, [
		["accent", "▰▰"],
		["border", "▱▱"],
	]);
});

test("visibleWidth ignores ANSI codes and clipToWidth cuts with an ellipsis", () => {
	const painted = "\x1b[31mabc\x1b[0mdef";
	assert.equal(visibleWidth(painted), 6);
	assert.equal(visibleWidth("▰▰▱▱"), 4);
	assert.equal(clipToWidth("abcdef", 5), "abcd…");
	assert.equal(clipToWidth("abc", 5), "abc");
	assert.equal(visibleWidth(clipToWidth(painted, 4)), 4);
});

test("renderUsageBar draws the Gentle Shell bar segment: first window gauged, rest compact", () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	assert.equal(renderUsageBar(usage, plainTheme), "zai 5h ▱▱▱▱▱▱▱▱ 5% · week 6%");

	const hot = parseZaiUsage(
		ZAI_PROVIDER,
		{
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 3, percentage: 85, nextResetTime: NOW + 3_600_000 },
					{ type: "TOKENS_LIMIT", unit: 6, percentage: 42, nextResetTime: NOW + 3_600_000 },
				],
			},
		},
		NOW,
	);
	assert.equal(renderUsageBar(hot, plainTheme), "zai 5h ▰▰▰▰▰▰▰▱ 85% · week 42%");
});

test("renderUsageBar stays quiet for windowless and reached-limit payloads", () => {
	const empty = parseZaiUsage(ZAI_PROVIDER, { data: {} }, NOW);
	assert.equal(renderUsageBar(empty, plainTheme), undefined);
	const reached = parseZaiUsage(
		ZAI_PROVIDER,
		{
			data: {
				limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 100 }],
				level: "max",
			},
		},
		NOW,
	);
	assert.equal(renderUsageBar(reached, plainTheme), "zai 5h ▰▰▰▰▰▰▰▰ 100%");
});

test("renderUsagePanel lays out rows exactly like gentle-pi's Subscriptions panel", () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	const lines = renderUsagePanel([usage], plainTheme, 64, NOW, { provider: ZAI_GLM_PROVIDER });
	assert.deepEqual(lines, [
		"✿ zai-glm · max · updated just now",
		"  zai",
		`    5h    ▰${"▱".repeat(15)}   5%  resets now`,
		`    week  ▰${"▱".repeat(15)}   6%  resets in 4d 12h`,
	]);

	const later = renderUsagePanel([usage], plainTheme, 64, NOW + 3 * 60_000, { provider: ZAI_GLM_PROVIDER });
	assert.equal(later[0], "✿ zai-glm · max · updated 3m ago");
});

test("renderUsagePanel explains a dataless active provider and stays quiet without one", () => {
	assert.deepEqual(renderUsagePanel([], plainTheme, 64, NOW, { provider: ZAI_PROVIDER }), [
		`✿ zai · ${ZAI_PENDING_NOTE}`,
	]);
	assert.deepEqual(renderUsagePanel([], plainTheme, 120, NOW), [USAGE_EMPTY_MESSAGE]);
});

test("ZaiUsageView frames the panel and answers r/esc/q like /gentle:usage", async () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	let closed = 0;
	let refreshes = 0;
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const view = new ZaiUsageView({
		theme: plainTheme,
		now: () => NOW,
		usage: () => usage as ProviderUsage,
		active: () => ({ provider: ZAI_GLM_PROVIDER }),
		onRefresh: () => {
			refreshes += 1;
			return pending;
		},
		onClose: () => {
			closed += 1;
		},
		requestRender: () => {},
	});

	const lines = view.render(64);
	assert.equal(lines.length, 7, "top + 4 rows + keys + bottom");
	assert.equal(lines[0], `╭─ ✿ Subscriptions ${"─".repeat(44)}╮`);
	assert.equal(lines[1], `│ ✿ zai-glm · max · updated just now${" ".repeat(26)} │`);
	assert.equal(lines.at(-2), `│ r refresh   esc close${" ".repeat(39)} │`);
	assert.equal(lines.at(-1), `╰${"─".repeat(62)}╯`);

	view.handleInput("r");
	assert.equal(refreshes, 1);
	assert.match(view.render(64)[0] ?? "", /refreshing…/);
	view.handleInput("r");
	assert.equal(refreshes, 1, "a refresh in flight swallows the next r");
	release();
	await pending.then(() => {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(view.render(64)[0] ?? "", /refreshing…/);

	view.handleInput("\x1b");
	view.handleInput("q");
	assert.equal(closed, 2, "esc and q both close");
});
