/**
 * Panel-level focus routing.
 *
 * Routes key events based on which panel has focus (sidebar or chat).
 * When vim is enabled, keys pass through the vim engine first.
 * Chat manages its own inner focus (prompt/history) via chat.ts.
 * Sidebar manages its own keys via sidebar.ts.
 *
 * This is the top-level key routing — the only file main.ts calls
 * for key handling.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { Action } from "./keybinds";
import { resolveAction } from "./keybinds";
import {
  handleChatKey,
  scrollUp, scrollDown,
  scrollLineUp, scrollLineDown,
  scrollHalfUp, scrollHalfDown,
  scrollPageUp, scrollPageDown,
  scrollToTop, scrollToBottom,
} from "./chat";
import { handleSidebarKey, handleSidebarAction, moveSelection } from "./sidebar";
import { processKey, copyToClipboard, pasteFromClipboard, type VimContext } from "./vim";
import { clampNormal } from "./vim/buffer";
import * as hc from "./historycursor";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "new_conversation" };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  const action = resolveAction(key);

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
    case "sidebar_toggle":
      state.sidebar.open = !state.sidebar.open;
      state.panelFocus = state.sidebar.open ? "sidebar" : "chat";
      return { type: "handled" };
    case "focus_cycle":
      if (state.sidebar.open) {
        state.panelFocus = state.panelFocus === "sidebar" ? "chat" : "sidebar";
      }
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars
      const isPromptTyping = state.panelFocus === "chat" && state.chatFocus === "prompt"
        && state.vim.mode === "insert";
      if (isPromptTyping) break;
      if (!state.sidebar.open) state.sidebar.open = true;
      state.panelFocus = "sidebar";
      moveSelection(state.sidebar, action === "sidebar_next" ? 1 : -1);
      return { type: "handled" };
    }
    case "scroll_line_up":   handleScroll(state, scrollLineUp);   return { type: "handled" };
    case "scroll_line_down": handleScroll(state, scrollLineDown); return { type: "handled" };
    case "scroll_half_up":   handleScroll(state, scrollHalfUp);   return { type: "handled" };
    case "scroll_half_down": handleScroll(state, scrollHalfDown); return { type: "handled" };
    case "scroll_page_up":   handleScroll(state, scrollPageUp);   return { type: "handled" };
    case "scroll_page_down": handleScroll(state, scrollPageDown); return { type: "handled" };
    case "scroll_top":       handleScroll(state, scrollToTop);    return { type: "handled" };
    case "scroll_bottom":    handleScroll(state, scrollToBottom); return { type: "handled" };
    case "toggle_tool_output":
      state.showToolOutput = !state.showToolOutput;
      return { type: "handled" };
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (action === "abort" && state.panelFocus === "sidebar" && state.sidebar.pendingDeleteId) {
    state.sidebar.pendingDeleteId = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Vim processing ─────────────────────────────────────────────
  const vimResult = processVimKey(key, state);
  if (vimResult) return vimResult;

  // ── Abort (only when vim doesn't consume Esc) ──────────────────
  if (action === "abort") {
    return { type: "abort" };
  }

  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    return handleSidebarFocused(key, state);
  } else {
    return handleChatFocused(key, state);
  }
}

// ── Vim key processing ─────────────────────────────────────────────

/**
 * Run the key through the vim engine.
 * Returns a KeyResult if vim consumed the key, or null for passthrough.
 */
function processVimKey(key: KeyEvent, state: RenderState): KeyResult | null {
  const context = getVimContext(state);
  const result = processKey(key, state.vim, context, state.inputBuffer, state.cursorPos);

  switch (result.type) {
    case "passthrough":
      return null;

    case "noop":
    case "pending":
      return { type: "handled" };

    case "cursor_move":
      state.cursorPos = result.cursor;
      return { type: "handled" };

    case "buffer_edit":
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      if (result.mode) {
        state.vim.mode = result.mode;
      } else {
        // Staying in normal mode — clamp cursor to last char
        clampCursorNormal(state);
      }
      return { type: "handled" };

    case "yank":
      copyToClipboard(result.text);
      return { type: "handled" };

    case "paste":
      handlePaste(result.position, state);
      return { type: "handled" };

    case "mode_change":
      state.vim.mode = result.mode;
      if (result.cursor !== undefined) state.cursorPos = result.cursor;
      // If switching to insert from sidebar/history, also focus prompt
      if (result.mode === "insert" && state.chatFocus !== "prompt") {
        state.chatFocus = "prompt";
      }
      return { type: "handled" };

    case "action":
      return handleVimAction(result.action, state);
  }
}

/** Handle an action produced by the vim engine. */
function handleVimAction(action: string, state: RenderState): KeyResult {
  // History cursor actions
  if ((action as Action).startsWith("history_")) {
    return handleHistoryCursorAction(action as Action, state);
  }

  switch (action) {
    case "quit":
      return { type: "quit" };
    case "abort":
      return { type: "abort" };
    case "focus_prompt":
      // Vim i/a in sidebar/history → focus prompt + enter insert
      state.vim.mode = "insert";
      if (state.panelFocus === "sidebar") {
        state.panelFocus = "chat";
      }
      state.chatFocus = "prompt";
      return { type: "handled" };
    case "nav_up":
      return handleContextNavigation("up", state);
    case "nav_down":
      return handleContextNavigation("down", state);
    case "nav_select":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("nav_select", state.sidebar);
        if (result.type === "select") {
          return { type: "load_conversation", convId: result.convId };
        }
      }
      return { type: "handled" };
    case "delete":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("delete", state.sidebar);
        if (result.type === "delete_conversation") {
          return { type: "delete_conversation", convId: result.convId };
        }
      }
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
}

// ── History cursor actions ────────────────────────────────────────

function handleHistoryCursorAction(action: Action, state: RenderState): KeyResult {
  const lines = state.historyLines;
  const cur = state.historyCursor;

  if (lines.length === 0) return { type: "handled" };

  const lineLen = hc.stripAnsi(lines[cur.row] ?? "").length;

  switch (action) {
    case "history_left":    state.historyCursor = hc.charLeft(cur); break;
    case "history_right":   state.historyCursor = hc.charRight(cur, lineLen); break;
    case "history_up":      state.historyCursor = hc.lineUp(cur, lines); break;
    case "history_down":    state.historyCursor = hc.lineDown(cur, lines); break;
    case "history_w":       state.historyCursor = hc.wordForward(cur, lines); break;
    case "history_b":       state.historyCursor = hc.wordBackward(cur, lines); break;
    case "history_e":       state.historyCursor = hc.wordEnd(cur, lines); break;
    case "history_W":       state.historyCursor = hc.wordForwardBig(cur, lines); break;
    case "history_B":       state.historyCursor = hc.wordBackwardBig(cur, lines); break;
    case "history_E":       state.historyCursor = hc.wordEndBig(cur, lines); break;
    case "history_0":       state.historyCursor = hc.lineStart(cur); break;
    case "history_dollar":  state.historyCursor = hc.lineEnd(cur, lineLen); break;
    case "history_gg":      state.historyCursor = hc.bufferStart(); break;
    case "history_G":       state.historyCursor = hc.bufferEnd(lines); break;
    case "history_yy": {
      const plain = hc.stripAnsi(lines[cur.row] ?? "");
      if (plain) copyToClipboard(plain);
      break;
    }
  }

  // Auto-scroll to keep cursor visible
  ensureCursorVisible(state);

  return { type: "handled" };
}

/** Adjust scrollOffset so the cursor row is within the visible message area. */
function ensureCursorVisible(state: RenderState): void {
  const { totalLines, messageAreaHeight } = state.layout;
  if (totalLines <= messageAreaHeight) {
    state.scrollOffset = 0;
    return;
  }

  const cursorRow = state.historyCursor.row;

  // viewStart = totalLines - messageAreaHeight - scrollOffset
  // visible range: [viewStart, viewStart + messageAreaHeight)
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
  const viewEnd = viewStart + messageAreaHeight;

  if (cursorRow < viewStart) {
    // Cursor above visible area — scroll up
    state.scrollOffset = totalLines - messageAreaHeight - cursorRow;
  } else if (cursorRow >= viewEnd) {
    // Cursor below visible area — scroll down
    state.scrollOffset = totalLines - messageAreaHeight - (cursorRow - messageAreaHeight + 1);
  }

  // Clamp
  const maxScroll = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
}

/** Handle j/k vim actions in sidebar or history context. */
function handleContextNavigation(dir: "up" | "down", state: RenderState): KeyResult {
  if (state.panelFocus === "sidebar") {
    const result = handleSidebarAction(dir === "up" ? "nav_up" : "nav_down", state.sidebar);
    if (result.type === "select") {
      return { type: "load_conversation", convId: result.convId };
    }
    return { type: "handled" };
  }
  // History scroll
  if (state.chatFocus === "history") {
    if (dir === "up") scrollUp(state);
    else scrollDown(state);
  }
  return { type: "handled" };
}

// ── Paste handling ─────────────────────────────────────────────────

/** Async paste from clipboard. Reads clipboard, inserts into buffer. */
function handlePaste(position: "after" | "before", state: RenderState): void {
  pasteFromClipboard().then((text) => {
    if (!text) return;

    const buf = state.inputBuffer;
    const cursor = state.cursorPos;
    const insertAt = position === "after" ? cursor + 1 : cursor;
    const pos = Math.min(insertAt, buf.length);

    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = clampNormal(state.inputBuffer, pos + text.length - 1);
  });
}

// ── Normal mode cursor clamp ───────────────────────────────────────

function clampCursorNormal(state: RenderState): void {
  state.cursorPos = clampNormal(state.inputBuffer, state.cursorPos);
}

// ── Scroll dispatch ────────────────────────────────────────────────

/** Route scroll to the focused scrollable. */
function handleScroll(state: RenderState, scrollFn: (state: RenderState) => void): void {
  if (state.panelFocus === "sidebar") {
    // TODO: scroll sidebar selection when needed
    scrollFn(state); // falls through to chat history for now
  } else {
    scrollFn(state);
  }
}

// ── Context resolver ───────────────────────────────────────────────

function getVimContext(state: RenderState): VimContext {
  if (state.panelFocus === "sidebar") return "sidebar";
  return state.chatFocus === "prompt" ? "prompt" : "history";
}

// ── Sidebar panel (non-vim path) ───────────────────────────────────

function handleSidebarFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleSidebarKey(key, state.sidebar);

  switch (result.type) {
    case "handled":
      return { type: "handled" };
    case "select":
      return { type: "load_conversation", convId: result.convId };
    case "delete_conversation":
      return { type: "delete_conversation", convId: result.convId };
    case "unhandled":
      // focus_prompt comes back as unhandled from sidebar (i/a)
      state.panelFocus = "chat";
      return { type: "handled" };
  }
}

// ── Chat panel (non-vim path) ──────────────────────────────────────

function handleChatFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleChatKey(key, state);

  switch (result.type) {
    case "submit":
      return { type: "submit" };
    case "handled":
      return { type: "handled" };
    case "unhandled":
      return { type: "handled" };
  }
}
