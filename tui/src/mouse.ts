/**
 * Mouse interaction helpers.
 *
 * Pure functions for screen↔history coordinate mapping, drag
 * selection text extraction, and the auto-scroll timer that runs
 * while dragging past the message area edges.
 *
 * No focus routing or KeyResult types — those stay in focus.ts.
 */

import type { RenderState, MouseSelection, SelectionRange } from "./state";
import { normalizeSelection, viewStart, MSG_AREA_START } from "./state";
import { stripAnsi } from "./historycursor";

// ── Coordinate mapping ──────────────────────────────────────────────

/**
 * Convert a screen position (1-based row/col) in the message area to
 * a history line index and visible column. Returns null if the
 * coordinates don't map to a valid history line.
 */
export function screenToHistoryPos(
  screenRow: number,
  screenCol: number,
  state: RenderState,
): { lineIdx: number; visCol: number } | null {
  const L = state.layout;
  const totalLines = state.historyLines.length;
  const areaHeight = L.sepAbove - MSG_AREA_START;

  const i = screenRow - MSG_AREA_START;
  if (i < 0 || i >= areaHeight) return null;

  const lineIdx = viewStart(totalLines, areaHeight, state.scrollOffset) + i;
  if (lineIdx >= totalLines) return null;

  const visCol = Math.max(0, screenCol - L.chatCol);
  return { lineIdx, visCol };
}

// ── Selection text extraction ───────────────────────────────────────

/**
 * Extract plain text from a mouse selection, stripping ANSI.
 * Word-wrap continuations are joined with spaces.
 */
export function getMouseSelectionText(sel: MouseSelection, state: RenderState): string {
  const { startRow, startCol, endRow, endCol } = normalizeSelection(sel);
  const lines = state.historyLines;
  const wrapCont = state.historyWrapContinuation;

  if (startRow === endRow) {
    return stripAnsi(lines[startRow] ?? "").slice(startCol, endCol + 1);
  }

  const result: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const plain = stripAnsi(lines[r] ?? "");
    let text: string;
    if (r === startRow) {
      text = plain.slice(startCol).trimEnd();
    } else if (r === endRow) {
      text = plain.slice(0, endCol + 1).trimEnd();
    } else {
      text = plain.trim();
    }

    // Word-wrap continuations join with space instead of newline
    if (r !== startRow && wrapCont[r]) {
      result[result.length - 1] += (text ? " " + text : "");
    } else {
      result.push(text);
    }
  }
  return result.join("\n");
}

// ── Word boundary detection ─────────────────────────────────────────

/**
 * Find the word boundaries around a column in a plain text string.
 * Returns [start, end] inclusive. Used for right-click word-copy.
 */
export function wordBoundsAt(text: string, col: number): [number, number] {
  if (col >= text.length) return [col, col];
  if (/\s/.test(text[col])) return [col, col];

  let start = col;
  let end = col;
  const wordChar = (ch: string) => /\w/.test(ch);
  const startIsWord = wordChar(text[col]);
  const charMatches = (ch: string) =>
    startIsWord ? wordChar(ch) : (!wordChar(ch) && !/\s/.test(ch));

  while (start > 0 && charMatches(text[start - 1])) start--;
  while (end < text.length - 1 && charMatches(text[end + 1])) end++;
  return [start, end];
}

// ── Drag auto-scroll ────────────────────────────────────────────────
//
// When dragging past the top/bottom of the message area, a repeating
// timer scrolls the viewport and extends the selection. The timer
// fires even while the mouse is held still at the edge.

const DRAG_SCROLL_INTERVAL = 60; // ms between scroll ticks
const DRAG_SCROLL_LINES = 2;     // lines per tick

const drag = {
  timer: null as ReturnType<typeof setInterval> | null,
  renderFn: null as (() => void) | null,
  state: null as RenderState | null,
  dir: 1 as 1 | -1,
  col: 0, // screen column for extending selection
};

/**
 * Register the render callback. Called once from main.ts so the
 * auto-scroll timer can trigger re-renders.
 */
export function setDragScrollRender(fn: () => void): void {
  drag.renderFn = fn;
}

export function startDragScroll(dir: 1 | -1, state: RenderState, screenCol: number): void {
  drag.dir = dir;
  drag.state = state;
  drag.col = screenCol;
  if (drag.timer) return; // already running
  drag.timer = setInterval(dragScrollTick, DRAG_SCROLL_INTERVAL);
}

export function stopDragScroll(): void {
  if (drag.timer) {
    clearInterval(drag.timer);
    drag.timer = null;
  }
  drag.state = null;
}

function dragScrollTick(): void {
  const state = drag.state;
  if (!state || !state.mouseSelection || state.mouseSelection.finalized) {
    stopDragScroll();
    return;
  }

  const L = state.layout;
  const areaHeight = L.sepAbove - MSG_AREA_START;
  const totalLines = state.historyLines.length;
  if (totalLines <= areaHeight) { stopDragScroll(); return; }

  // Scroll viewport
  const maxScroll = Math.max(0, totalLines - areaHeight);
  state.scrollOffset = Math.max(0, Math.min(
    state.scrollOffset + drag.dir * DRAG_SCROLL_LINES,
    maxScroll,
  ));

  // Extend selection to the edge row now visible
  const vs = viewStart(totalLines, areaHeight, state.scrollOffset);
  const edgeLineIdx = drag.dir > 0
    ? vs                                         // scrolling up → top visible line
    : Math.min(vs + areaHeight - 1, totalLines - 1); // scrolling down → bottom

  state.mouseSelection.endRow = edgeLineIdx;
  state.mouseSelection.endCol = Math.max(0, drag.col - L.chatCol);

  if (drag.renderFn) drag.renderFn();
}
