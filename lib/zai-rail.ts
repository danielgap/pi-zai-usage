// Fullscreen sidebar rail decorator for gentle-pi's Status card.
//
// gentle-pi's fullscreen sidebar paints its Status card from a shared
// terminal-owned state object (`Symbol.for("gentle-pi.experimental-sidebar.state")`).
// The rail only renders four hardcoded part keys (footer, changes, agents,
// todo), and the "footer" part is the Status card itself. This module wraps
// that part in place: the card renders unchanged and the z.ai usage block is
// appended below it, so the meter travels in the sidebar next to the usage
// gentle-pi paints natively for Codex/Claude.
//
// Everything here degrades silently: when the state object, the footer part,
// or the expected shapes are missing (gentle-pi absent, older, or refactored),
// the decorator reports inactive and the caller keeps its fallback surface
// (the ctx.ui.setStatus segment). No gentle-pi module is imported or patched.

/** gentle-pi's cross-module sidebar state key (shell-sidebar.ts). */
export const RAIL_STATE_KEY = "gentle-pi.experimental-sidebar.state";
const RAIL_FOOTER_KEY = "footer";

/** Shape gentle-pi's rail parts implement (Component + optional digest). */
export interface RailPart {
	render(width: number): string[];
	invalidate?(): void;
	digest?(): string;
	handleMouse?(event: unknown): unknown;
	dispose?(): void;
}

export interface RailState {
	parts: Map<string, RailPart>;
	/** True while the fullscreen rail owns the sidebar (set by the layout). */
	active?: boolean;
}

/** The block appended below the Status card; empty lines mean "paint nothing". */
export interface RailDecoration {
	lines(width: number): string[];
	digest(): string;
}

export interface RailWrap {
	/** Idempotently (re)wrap the registered footer part; true when ours is installed. */
	ensure(): boolean;
	/** True while our wrapper is the registered footer part AND the rail is painting. */
	painting(): boolean;
	/** Ask the host for a render pass (no-op without a captured TUI). */
	requestRender(): void;
}

function readState(terminal: unknown): RailState | undefined {
	if (!terminal || typeof terminal !== "object") return undefined;
	const state = (terminal as Record<symbol, unknown>)[Symbol.for(RAIL_STATE_KEY)];
	if (!state || typeof state !== "object") return undefined;
	const parts = (state as { parts?: unknown }).parts;
	if (!(parts instanceof Map)) return undefined;
	return state as RailState;
}

/** Splice the decoration below the card: one blank separator, then the block. */
export function decorateFooterLines(base: string[], extra: string[]): string[] {
	return extra.length === 0 ? base : [...base, "", ...extra];
}

export function wrapFooterRail(
	terminal: unknown,
	requestRender: () => void,
	decoration: RailDecoration,
): RailWrap | undefined {
	const state = readState(terminal);
	if (!state) return undefined;
	let original: RailPart | undefined;
	let wrapped: RailPart | undefined;
	// Cached base height so a mouse hit over the card section can be forwarded
	// with a section-relative y even though our wrapper owns the section.
	let lastBaseLines = 0;

	const build = (target: RailPart): RailPart => {
		const part: RailPart = {
			render(width: number): string[] {
				const base = target.render(width);
				lastBaseLines = base.length;
				return decorateFooterLines(base, decoration.lines(width));
			},
			invalidate(): void {
				target.invalidate?.();
			},
			digest(): string {
				let base: string | undefined;
				try {
					base = target.digest?.();
				} catch {
					base = undefined;
				}
				let extra: string;
				try {
					extra = decoration.digest();
				} catch {
					extra = "unavailable";
				}
				return JSON.stringify([base, extra]);
			},
			dispose(): void {
				target.dispose?.();
			},
		};
		if (typeof target.handleMouse === "function") {
			part.handleMouse = (event: unknown) => {
				const mouse = event as { y?: unknown };
				const y = typeof mouse?.y === "number" ? mouse.y : -1;
				if (y < 0 || y >= lastBaseLines) return undefined;
				return target.handleMouse?.(event);
			};
		}
		return part;
	};

	const ensure = (): boolean => {
		const current = state.parts.get(RAIL_FOOTER_KEY);
		if (!current) return false;
		if (current === wrapped) return true;
		original = current;
		wrapped = build(current);
		try {
			state.parts.set(RAIL_FOOTER_KEY, wrapped);
		} catch {
			wrapped = undefined;
			return false;
		}
		return true;
	};

	return {
		ensure,
		painting(): boolean {
			return state.parts.get(RAIL_FOOTER_KEY) === wrapped && state.active === true;
		},
		requestRender,
	};
}
