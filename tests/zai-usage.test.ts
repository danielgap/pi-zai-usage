import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchZaiUsage,
	formatReset,
	isZaiUsageProvider,
	parseZaiUsage,
	renderPlainLines,
	windowLabel,
	ZAI_GLM_PROVIDER,
	ZAI_PROVIDER,
	ZAI_USAGE_PROVIDERS,
	ZAI_USAGE_URL,
} from "../lib/zai-usage.ts";

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

test("renderPlainLines draws one meter line per window with the reset note", () => {
	const usage = parseZaiUsage(ZAI_GLM_PROVIDER, ZAI_PAYLOAD, NOW);
	const lines = renderPlainLines(usage, NOW);
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /^z\.ai max 5h ▱▱▱▱▱▱▱▱ 5% /);
	assert.match(lines[1] ?? "", /^z\.ai max week /);
	assert.ok(
		(lines[1] ?? "").includes("resets in"),
		"the weekly window names its reset",
	);
});

test("renderPlainLines flags a reached limit and explains a windowless payload", () => {
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
	const lines = renderPlainLines(reached, NOW);
	assert.equal(lines.at(-1), "limit reached — window must reset");

	const empty = parseZaiUsage(ZAI_PROVIDER, { data: {} }, NOW);
	assert.deepEqual(renderPlainLines(empty, NOW).slice(1), [
		"no usage windows in the quota payload",
	]);
});
