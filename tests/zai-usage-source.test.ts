import assert from "node:assert/strict";
import { test } from "node:test";
import {
	registerUsageSources,
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
	type UsageSourceBus,
} from "../extensions/zai_usage.ts";
import {
	type ProviderUsage,
	ZAI_GLM_PROVIDER,
	ZAI_PENDING_NOTE,
	ZAI_PROVIDER,
	ZAI_USAGE_PROVIDERS,
	ZAI_USAGE_URL,
} from "../lib/zai-usage.ts";

const NOW = 1_789_000_000_000;
const PAYLOAD = {
	data: {
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, percentage: 42, nextResetTime: NOW + 3_600_000 },
			{ type: "TOKENS_LIMIT", unit: 6, percentage: 7, nextResetTime: NOW + 604_800_000 },
		],
		level: "max",
	},
};

// gentle-pi validates every usage-source payload field by field before it
// trusts one (lib/shell-usage.ts, parseUsageSource); these tests pin the same
// contract from the producer side so a drift breaks here first.
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface UsageSourceShape {
	schema: string;
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<unknown>;
}

function asUsageSource(value: unknown): UsageSourceShape | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schema !== USAGE_SOURCE_SCHEMA) return undefined;
	if (typeof raw.provider !== "string" || !PROVIDER_PATTERN.test(raw.provider)) return undefined;
	if (typeof raw.fetch !== "function") return undefined;
	if (raw.pendingNote !== undefined && typeof raw.pendingNote !== "string") return undefined;
	return raw as unknown as UsageSourceShape;
}

function capturingBus() {
	const listeners: Array<(payload: unknown) => void> = [];
	const received: Array<{ channel: string; payload: unknown }> = [];
	const bus: UsageSourceBus = {
		emit(channel, payload) {
			received.push({ channel, payload });
			for (const listener of listeners) listener(payload);
		},
	};
	return { bus, listeners, received };
}

function fakeZaiFetch(payload: unknown = PAYLOAD) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return { ok: true, json: async () => payload } as Response;
	}) as typeof fetch;
	return { fetchFn, calls };
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		await run();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

function sourceFor(capture: ReturnType<typeof capturingBus>, provider: string): UsageSourceShape {
	const source = asUsageSource(
		capture.received.find((entry) => asUsageSource(entry.payload)?.provider === provider)?.payload,
	);
	assert.ok(source, `no usage source was registered for ${provider}`);
	return source;
}

test("the mirrored event constants are exactly gentle-pi's versioned contract", () => {
	assert.equal(USAGE_SOURCE_EVENT, "gentle-pi:usage-source/v1");
	assert.equal(USAGE_SOURCE_SCHEMA, "gentle-pi.usage-source/v1");
});

test("registration emits one well-formed source per z.ai provider, not only the active one", () => {
	const { bus, received } = capturingBus();
	registerUsageSources(bus);

	assert.equal(received.length, ZAI_USAGE_PROVIDERS.length);
	assert.deepEqual(
		received.map((entry) => asUsageSource(entry.payload)?.provider),
		[ZAI_PROVIDER, ZAI_GLM_PROVIDER],
	);
	for (const entry of received) {
		assert.equal(entry.channel, USAGE_SOURCE_EVENT);
		const source = asUsageSource(entry.payload);
		assert.ok(source);
		assert.equal(source.pendingNote, ZAI_PENDING_NOTE);
	}
});

test("a consumer subscribed before registration hears every provider", () => {
	// gentle-shell subscribes at factory time and the registration happens in
	// session_start, so the listener exists before the first emit regardless
	// of which extension loads first.
	const { bus, listeners } = capturingBus();
	const heard: string[] = [];
	listeners.push((payload) => {
		const source = asUsageSource(payload);
		if (source) heard.push(source.provider);
	});
	registerUsageSources(bus);

	assert.deepEqual(heard, [ZAI_PROVIDER, ZAI_GLM_PROVIDER]);
});

test("a store-like consumer replaces sources per provider instead of accumulating", () => {
	const { bus } = capturingBus();
	const store = new Map<string, UsageSourceShape>();
	bus.emit = ((channel: string, payload: unknown) => {
		const source = asUsageSource(payload);
		if (channel === USAGE_SOURCE_EVENT && source) store.set(source.provider, source);
	}) as UsageSourceBus["emit"];

	registerUsageSources(bus);
	registerUsageSources(bus);

	assert.deepEqual([...store.keys()], [ZAI_PROVIDER, ZAI_GLM_PROVIDER]);
});

test("a source fetch prefers the provider-specific key the consumer supplies", async () => {
	const capture = capturingBus();
	registerUsageSources(capture.bus);
	const { fetchFn, calls } = fakeZaiFetch();

	const usage = (await sourceFor(capture, ZAI_GLM_PROVIDER).fetch("supplied-key", fetchFn, NOW)) as
		| ProviderUsage
		| undefined;

	assert.equal(usage?.provider, ZAI_GLM_PROVIDER);
	assert.equal(usage?.plan, "max");
	assert.equal(calls[0].url, ZAI_USAGE_URL);
	assert.equal(calls[0].headers.Authorization, "Bearer supplied-key");

	const other = fakeZaiFetch();
	const zaiUsage = (await sourceFor(capture, ZAI_PROVIDER).fetch("zai-key", other.fetchFn, NOW)) as
		| ProviderUsage
		| undefined;
	assert.equal(zaiUsage?.provider, ZAI_PROVIDER);
	assert.equal(other.calls[0].headers.Authorization, "Bearer zai-key");
});

test("a source fetch falls back to the environment when the consumer supplies no key", async () => {
	const capture = capturingBus();
	registerUsageSources(capture.bus);

	await withEnv("ZAI_GLM_API_KEY", "env-glm", async () => {
		const { fetchFn, calls } = fakeZaiFetch();
		await sourceFor(capture, ZAI_GLM_PROVIDER).fetch(undefined, fetchFn, NOW);
		assert.equal(calls[0].headers.Authorization, "Bearer env-glm");
	});

	await withEnv("ZAI_API_KEY", "env-zai", async () => {
		const { fetchFn, calls } = fakeZaiFetch();
		await sourceFor(capture, ZAI_PROVIDER).fetch(undefined, fetchFn, NOW);
		assert.equal(calls[0].headers.Authorization, "Bearer env-zai");
	});

	await withEnv("ZAI_GLM_API_KEY", "env-glm", () =>
		withEnv("ZAI_API_KEY", "env-zai", async () => {
			const { fetchFn, calls } = fakeZaiFetch();
			await sourceFor(capture, ZAI_GLM_PROVIDER).fetch(undefined, fetchFn, NOW);
			assert.equal(calls[0].headers.Authorization, "Bearer env-glm");
		}),
	);
});

test("a source fetch with neither a supplied nor an environment key sends nothing", async () => {
	const capture = capturingBus();
	registerUsageSources(capture.bus);

	await withEnv("ZAI_GLM_API_KEY", undefined, () =>
		withEnv("ZAI_API_KEY", undefined, async () => {
			const { fetchFn, calls } = fakeZaiFetch();
			assert.equal(await sourceFor(capture, ZAI_GLM_PROVIDER).fetch(undefined, fetchFn, NOW), undefined);
			assert.equal(calls.length, 0, "without a key nothing must be sent anywhere");
		}),
	);
});
