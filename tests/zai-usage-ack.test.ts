import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import zaiUsageExtension, {
	USAGE_SOURCE_ACK_EVENT,
	USAGE_SOURCE_ACK_SCHEMA,
} from "../extensions/zai_usage.ts";
import { ZAI_PROVIDER } from "../lib/zai-usage.ts";

const NOW = 1_789_000_000_000;
// The setStatus key is the segment's public contract (pi's status bar), not an
// export; it is spelled out here so a silent rename breaks loudly.
const STATUS_KEY = "zai-usage";
const ACK = { schema: USAGE_SOURCE_ACK_SCHEMA, provider: ZAI_PROVIDER };
const PAYLOAD = {
	data: {
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, percentage: 42, nextResetTime: NOW + 3_600_000 },
			{ type: "TOKENS_LIMIT", unit: 6, percentage: 7, nextResetTime: NOW + 604_800_000 },
		],
		level: "max",
	},
};

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string | undefined, ctx: ExtensionContext) => unknown;
type StatusCall = { key: string; text: string | undefined };

// A minimal ExtensionAPI double: the factory only registers lifecycle
// handlers, one command, and bus listeners. Bus emits from this side land
// nowhere — the shell is the consumer — and tests ack through harness.emit,
// the way gentle-shell emits USAGE_SOURCE_ACK_EVENT back.
function fakePi() {
	const lifecycle = new Map<string, LifecycleHandler>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const busListeners = new Map<string, Array<(data: unknown) => void>>();
	const api = {
		on(event: string, handler: LifecycleHandler) {
			lifecycle.set(event, handler);
			return () => {};
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = busListeners.get(channel) ?? [];
				list.push(handler);
				busListeners.set(channel, list);
				return () => {};
			},
			emit() {},
		},
	};
	return {
		pi: api as unknown as ExtensionAPI,
		lifecycle,
		commands,
		emit(channel: string, payload: unknown) {
			for (const listener of busListeners.get(channel) ?? []) listener(payload);
		},
	};
}

function fakeZaiCtx(provider: string = ZAI_PROVIDER) {
	const statusCalls: StatusCall[] = [];
	const notifications: string[] = [];
	const customCalls: string[] = [];
	const ctx = {
		hasUI: true,
		model: { provider },
		modelRegistry: {
			getApiKeyForProvider: (name: string) => Promise.resolve(`key-for-${name}`),
		},
		ui: {
			setStatus(key: string, text: string | undefined) {
				statusCalls.push({ key, text });
		},
			notify(message: string, _level?: string) {
				notifications.push(message);
			},
			async custom(_factory: unknown, options: unknown) {
				customCalls.push(String((options as { overlay?: boolean })?.overlay ?? false));
				return null;
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext, statusCalls, notifications, customCalls };
}

function segment(statusCalls: StatusCall[]): string | undefined {
	return statusCalls.findLast((call) => call.key === STATUS_KEY)?.text;
}

// The extension fetches through the global fetch; the stub answers with the
// quota payload and restores the original afterwards.
async function withQuotaPayload(payload: unknown, run: () => Promise<void>): Promise<void> {
	const saved = globalThis.fetch;
	globalThis.fetch = (async () => {
		return { ok: true, json: async () => payload } as Response;
	}) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = saved;
	}
}

// session_start starts the refresh interval, so every test shuts the session
// down again or the timer holds the test runner open.
async function withSession(
	harness: ReturnType<typeof fakePi>,
	ctx: ExtensionContext,
	run: () => Promise<void>,
): Promise<void> {
	await harness.lifecycle.get("session_start")?.(undefined, ctx);
	try {
		await run();
	} finally {
		await harness.lifecycle.get("session_shutdown")?.(undefined, ctx);
	}
}

test("the mirrored ack constants are exactly gentle-shell's versioned contract", () => {
	assert.equal(USAGE_SOURCE_ACK_EVENT, "gentle-pi:usage-source-ack/v1");
	assert.equal(USAGE_SOURCE_ACK_SCHEMA, "gentle-pi.usage-source-ack/v1");
});

test("an ack for the active provider retires the rendered standalone segment", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			assert.match(segment(statusCalls) ?? "", /42%/, "the segment renders before any ack");
			harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
			assert.equal(segment(statusCalls), undefined, "the ack repaints the segment away");
		}),
	);
});

test("an ack that arrives before the first fetch keeps the segment from ever rendering", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			assert.ok(statusCalls.length > 0, "paint still runs, it just has nothing to show");
			for (const call of statusCalls) assert.equal(call.text, undefined);
		}),
	);
});

test("without an ack the standalone segment still renders after a successful fetch", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			assert.match(segment(statusCalls) ?? "", /42%/);
		}),
	);
});

test("an ack for a foreign provider is ignored", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			harness.emit(USAGE_SOURCE_ACK_EVENT, {
				schema: USAGE_SOURCE_ACK_SCHEMA,
				provider: "acme-cloud",
			});
			assert.match(segment(statusCalls) ?? "", /42%/, "a foreign ack must not retire the z.ai segment");
		}),
	);
});

test("malformed ack payloads are ignored without throwing", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			for (const payload of [
				undefined,
				null,
				"ack",
				7,
				{},
				{ schema: USAGE_SOURCE_ACK_SCHEMA },
				{ provider: ZAI_PROVIDER },
				{ schema: "gentle-pi.usage-source/v1", provider: ZAI_PROVIDER },
			]) {
				harness.emit(USAGE_SOURCE_ACK_EVENT, payload);
			}
			assert.match(segment(statusCalls) ?? "", /42%/, "none of those is an ack for z.ai");
		}),
	);
});

test("a repeated ack is idempotent: the segment stays retired and nothing throws", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			assert.match(segment(statusCalls) ?? "", /42%/);
			const afterFetch = statusCalls.length;
			harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
			harness.emit(USAGE_SOURCE_ACK_EVENT, { schema: USAGE_SOURCE_ACK_SCHEMA, provider: ZAI_PROVIDER });
			const repaints = statusCalls.slice(afterFetch);
			assert.ok(repaints.length > 0, "each ack repaints once");
			for (const call of repaints) {
				assert.equal(call.key, STATUS_KEY);
				assert.equal(call.text, undefined, "no repaint ever brings the segment back");
			}
			assert.equal(segment(statusCalls), undefined);
		}),
	);
});

test("/zai:usage on under a natively metered provider notifies, keeps the segment retired, and still opens the panel", async () => {
	const harness = fakePi();
	const { ctx, statusCalls, notifications, customCalls } = fakeZaiCtx();
	zaiUsageExtension(harness.pi);
	harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
	await withQuotaPayload(PAYLOAD, () =>
		withSession(harness, ctx, async () => {
			await harness.commands.get("zai:usage")?.handler("on", ctx);
			assert.equal(segment(statusCalls), undefined, "the segment stays retired");
			assert.equal(notifications.length, 1);
			assert.match(notifications[0], /gentle-shell meters zai.*natively/);
			assert.equal(customCalls.length, 1, "the documented refresh-and-panel contract still runs");
			assert.equal(customCalls[0], "true", "the panel opens as an overlay");
		}),
	);
});
