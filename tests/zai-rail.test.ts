import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decorateFooterLines,
	RAIL_STATE_KEY,
	wrapFooterRail,
	type RailPart,
	type RailState,
} from "../lib/zai-rail.ts";

const STATE = Symbol.for(RAIL_STATE_KEY);

interface FakeTerminal {
	[STATE]: RailState;
}

function fakeTerminal(active = false): FakeTerminal {
	const terminal = { parts: new Map<string, RailPart>(), active } as RailState;
	return { [STATE]: terminal } as FakeTerminal;
}

function basePart(overrides: Partial<RailPart> = {}): RailPart {
	const calls: string[] = [];
	const part: RailPart & { calls: string[] } = {
		calls,
		render: () => ["card line 1", "card line 2"],
		invalidate: () => calls.push("invalidate"),
		digest: () => "base-digest",
		...overrides,
	};
	return part;
}

function decoration(lines = ["zai block"]) {
	return {
		lines: (width: number) => lines.map((line) => line.slice(0, Math.max(0, width))),
		digest: () => `deco:${lines.length}`,
	};
}

test("decorateFooterLines passes the card through when there is nothing to add", () => {
	assert.deepEqual(decorateFooterLines(["a", "b"], []), ["a", "b"]);
});

test("decorateFooterLines splices the block below the card with a blank separator", () => {
	assert.deepEqual(decorateFooterLines(["a", "b"], ["x", "y"]), ["a", "b", "", "x", "y"]);
});

test("wrapFooterRail returns undefined outside gentle-pi (no state symbol)", () => {
	assert.equal(wrapFooterRail({}, () => {}, decoration()), undefined);
	assert.equal(wrapFooterRail(undefined, () => {}, decoration()), undefined);
});

test("wrapFooterRail returns undefined when the state shape drifted", () => {
	const terminal = { [STATE]: { parts: [] } } as unknown as FakeTerminal;
	assert.equal(wrapFooterRail(terminal, () => {}, decoration()), undefined);
});

test("ensure stays false until gentle-pi registers its footer part", () => {
	const terminal = fakeTerminal();
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	assert.ok(rail);
	assert.equal(rail.ensure(), false);
	assert.equal(rail.painting(), false);
});

test("ensure wraps the registered footer part and appends the block below the card", () => {
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart());
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	assert.ok(rail);
	assert.equal(rail.ensure(), true);
	const wrapped = terminal[STATE].parts.get("footer");
	assert.notEqual(wrapped, undefined);
	assert.deepEqual(wrapped?.render(40), ["card line 1", "card line 2", "", "zai block"]);
});

test("ensure is idempotent: one wrapper, stable identity", () => {
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart());
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	assert.ok(rail);
	rail.ensure();
	const first = terminal[STATE].parts.get("footer");
	rail.ensure();
	assert.equal(terminal[STATE].parts.get("footer"), first);
});

test("digest combines the card digest with the decoration digest and survives a throwing card digest", () => {
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart({ digest: () => { throw new Error("boom"); } }));
	const rail = wrapFooterRail(terminal, () => {}, decoration(["x"]));
	assert.ok(rail);
	rail.ensure();
	const wrapped = terminal[STATE].parts.get("footer");
	assert.equal(wrapped?.digest?.(), JSON.stringify([undefined, "deco:1"]));

	const healthy = fakeTerminal();
	healthy[STATE].parts.set("footer", basePart());
	const rail2 = wrapFooterRail(healthy, () => {}, decoration(["x"]));
	assert.ok(rail2);
	rail2.ensure();
	assert.equal(healthy[STATE].parts.get("footer")?.digest?.(), JSON.stringify(["base-digest", "deco:1"]));
});

test("invalidate and dispose delegate to the wrapped card part", () => {
	const terminal = fakeTerminal();
	const part = basePart();
	terminal[STATE].parts.set("footer", part);
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	rail?.ensure();
	const wrapped = terminal[STATE].parts.get("footer");
	wrapped?.invalidate?.();
	wrapped?.dispose?.();
	assert.deepEqual((part as unknown as { calls: string[] }).calls, ["invalidate"]);
});

test("painting is true only while the wrapper is installed and the rail is active", () => {
	const terminal = fakeTerminal(false);
	terminal[STATE].parts.set("footer", basePart());
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	assert.ok(rail);
	rail.ensure();
	assert.equal(rail.painting(), false);
	terminal[STATE].active = true;
	assert.equal(rail.painting(), true);
});

test("a decoration with no lines keeps the card rendering untouched", () => {
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart());
	const rail = wrapFooterRail(terminal, () => {}, { lines: () => [], digest: () => "empty" });
	rail?.ensure();
	assert.deepEqual(terminal[STATE].parts.get("footer")?.render(40), ["card line 1", "card line 2"]);
});

test("ensure re-wraps when gentle-pi re-registers its footer part", () => {
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart());
	const rail = wrapFooterRail(terminal, () => {}, decoration());
	assert.ok(rail);
	rail.ensure();
	const replacement = basePart({ render: () => ["new card"] });
	terminal[STATE].parts.set("footer", replacement);
	assert.equal(rail.painting(), false);
	assert.equal(rail.ensure(), true);
	assert.deepEqual(terminal[STATE].parts.get("footer")?.render(40), ["new card", "", "zai block"]);
});

test("handleMouse forwards only hits that land inside the card lines", () => {
	const hits: number[] = [];
	const terminal = fakeTerminal();
	terminal[STATE].parts.set("footer", basePart({
		render: () => ["card 1", "card 2"],
		handleMouse: (event: unknown) => { hits.push((event as { y: number }).y); return true; },
	}));
	const rail = wrapFooterRail(terminal, () => {}, decoration(["zai"]));
	rail?.ensure();
	const wrapped = terminal[STATE].parts.get("footer");
	wrapped?.render?.(40);
	assert.equal(wrapped?.handleMouse?.({ y: 0 }), true);
	assert.equal(wrapped?.handleMouse?.({ y: 1 }), true);
	// The appended block is not interactive: a hit there is not forwarded.
	assert.equal(wrapped?.handleMouse?.({ y: 2 }), undefined);
	assert.deepEqual(hits, [0, 1]);
});
