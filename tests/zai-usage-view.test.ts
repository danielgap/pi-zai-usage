import assert from "node:assert/strict";
import { test } from "node:test";
import { ZaiUsageView } from "../lib/zai-usage-view.ts";

// Closing must match every encoding pi-tui's matchesKey(Key.escape) accepts,
// because terminals with the Kitty keyboard protocol or xterm modifyOtherKeys
// active never send a bare 0x1b for the escape key. The view delegates to the
// same matcher gentle-pi's /gentle:usage panel uses, so parity is the contract.
function makeView() {
	const closed: string[] = [];
	const state = { refreshes: 0 };
	const view = new ZaiUsageView({
		theme: { fg: (_color, text) => text },
		now: () => 1_789_000_000_000,
		usage: () => undefined,
		active: () => ({ provider: "zai" }),
		onRefresh: async () => {
			state.refreshes += 1;
		},
		onClose: () => closed.push("closed"),
		requestRender: () => {},
	});
	return { view, closed, state };
}

test("bare escape byte closes the panel", () => {
	const { view, closed } = makeView();
	view.handleInput("\x1b");
	assert.deepEqual(closed, ["closed"]);
});

test("kitty CSI-u escape sequences close the panel", () => {
	const { view, closed } = makeView();
	view.handleInput("\x1b[27u");
	view.handleInput("\x1b[27;1u");
	view.handleInput("\x1b[27;1:1u");
	assert.equal(closed.length, 3);
});

test("xterm modifyOtherKeys escape sequence closes the panel", () => {
	const { view, closed } = makeView();
	view.handleInput("\x1b[27;1;27~");
	assert.deepEqual(closed, ["closed"]);
});

test("q closes the panel", () => {
	const { view, closed } = makeView();
	view.handleInput("q");
	assert.deepEqual(closed, ["closed"]);
});

test("r refreshes instead of closing", () => {
	const { view, closed, state } = makeView();
	view.handleInput("r");
	assert.deepEqual(closed, []);
	assert.equal(state.refreshes, 1);
});

test("arrow keys and other sequences do not close the panel", () => {
	const { view, closed } = makeView();
	view.handleInput("\x1b[A"); // up arrow (kitty-legacy mixed input)
	view.handleInput("\x1b[27;2u"); // shift+esc, not plain esc
	assert.deepEqual(closed, []);
});
