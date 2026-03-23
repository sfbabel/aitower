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
import { isStreaming, MSG_AREA_START } from "./state";
import type { Action } from "./keybinds";
import { resolveAction } from "./keybinds";
import {
  handleChatKey,
  scrollBy,
  scrollUp, scrollDown,
  scrollLineUp, scrollLineDown,
  scrollHalfUp, scrollHalfDown,
  scrollPageUp, scrollPageDown,
  scrollToTop, scrollToBottom,
} from "./chat";
import { handleSidebarKey, handleSidebarAction, handleSidebarMark, moveSelection, syncSelectedIndex, sidebarHitTest, handleSearchKey, openSearch, closeSearch, type SidebarKeyResult } from "./sidebar";
import { processKey, copyToClipboard, pasteFromClipboard, type VimContext } from "./vim";
import { clampNormal } from "./vim/buffer";
import { pushUndo, markInsertEntry, commitInsertSession, undo as undoFn, redo as redoFn } from "./undo";
import {
  stripAnsi, ensureCursorVisible, placeAtVisibleBottom,
  handleHistoryFind as historyFindHandler,
  handleHistoryTextObject as historyTextObjectHandler,
  handleHistoryCursorAction,
  joinLogicalLines, logicalLineRange,
  scrollHalfPageWithCursor, scrollFullPageWithCursor, scrollLineWithStickyCursor,
} from "./historycursor";
import { handleMessageTextObject } from "./vim/message";
import { dismissAutocomplete } from "./autocomplete";
import { handleQueuePromptKey } from "./queue";
import { handleEditMessageKey, openEditMessageModal } from "./editmessage";
import { handleContextMenuKey, buildSidebarMenu, buildMessageMenu, clampMenuPosition } from "./contextmenu";
import { PROMPT_PREFIX_LEN } from "./render";
import { readClipboardImage } from "./clipboard";
import { screenToHistoryPos, getMouseSelectionText, wordBoundsAt, startDragScroll, stopDragScroll } from "./mouse";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "noop" }    // nothing changed — skip re-render
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "clone_conversation"; convId: string }
  | { type: "new_conversation" }
  | { type: "queue_confirm" }
  | { type: "queue_cancel" }
  | { type: "edit_message_confirm" }
  | { type: "edit_message_cancel" };

// ── Shared helpers ─────────────────────────────────────────────────

/** Switch focus to chat in normal mode (for reading). */
function focusChat(state: RenderState): void {
  state.panelFocus = "chat";
  state.chatFocus = "prompt";
  state.sidebar.open = false;
  state.vim.mode = "normal";
  if (state.sidebar.searchActive) closeSearch(state.sidebar);
}

/** Toggle sidebar open/close, sync focus and selection. */
function toggleSidebar(state: RenderState): void {
  state.sidebar.open = !state.sidebar.open;
  state.panelFocus = state.sidebar.open ? "sidebar" : "chat";
  if (state.panelFocus === "sidebar") {
    state.vim.mode = "normal";
    if (state.convId) {
      state.sidebar.selectedId = state.convId;
      syncSelectedIndex(state.sidebar);
    }
  } else {
    if (state.sidebar.searchActive) closeSearch(state.sidebar);
  }
}

// ── Mouse routing ──────────────────────────────────────────────────

// Re-export setDragScrollRender so main.ts can import from this file
export { setDragScrollRender } from "./mouse";

function handleMouse(key: KeyEvent, state: RenderState): KeyResult {
  const { row, col, button } = key;
  if (!row || !col) return { type: "handled" };

  const L = state.layout;
  const inSidebar = state.sidebar.open && col <= L.sidebarWidth;
  const inMessages = !inSidebar && row >= MSG_AREA_START && row < L.sepAbove;
  const inPrompt = !inSidebar && row >= L.firstInputRow && row < L.sepBelow;

  // ── Mouse move → drag selection or sidebar hover ───────────────
  if (key.type === "mouse_move") {
    // Active drag selection
    if (state.mouseSelection && !state.mouseSelection.finalized) {
      const pos = screenToHistoryPos(row, col, state);
      if (pos) {
        // Inside message area — update selection, stop auto-scroll
        stopDragScroll();
        state.mouseSelection.endRow = pos.lineIdx;
        state.mouseSelection.endCol = pos.visCol;
      } else if (row < MSG_AREA_START) {
        // Above message area → auto-scroll up
        startDragScroll(1, state, col);
      } else if (row >= L.sepAbove) {
        // Below message area → auto-scroll down
        startDragScroll(-1, state, col);
      }
      return { type: "handled" };
    }

    const prevHover = state.sidebar.hoveredIndex;
    if (inSidebar) {
      state.sidebar.hoveredIndex = sidebarHitTest(row, state.sidebar);
    } else {
      state.sidebar.hoveredIndex = null;
    }
    // Only re-render if hover state actually changed
    return state.sidebar.hoveredIndex !== prevHover ? { type: "handled" } : { type: "noop" };
  }

  // ── Mouse release → finalize drag selection ─────────────────────
  if (key.type === "mouse_up") {
    if (state.mouseSelection && !state.mouseSelection.finalized && button === 0) {
      stopDragScroll();
      const pos = screenToHistoryPos(row, col, state);
      if (pos) {
        state.mouseSelection.endRow = pos.lineIdx;
        state.mouseSelection.endCol = pos.visCol;
      }
      // Only keep selection if it spans at least one character
      const s = state.mouseSelection;
      if (s.anchorRow === s.endRow && s.anchorCol === s.endCol) {
        state.mouseSelection = null;
      } else {
        state.mouseSelection.finalized = true;
      }
      return { type: "handled" };
    }
    return { type: "handled" };
  }

  // ── Scroll wheel ────────────────────────────────────────────────
  if (key.type === "mouse_scroll_up" || key.type === "mouse_scroll_down") {
    const delta = key.type === "mouse_scroll_up" ? 3 : -3;
    if (inSidebar) {
      moveSelection(state.sidebar, key.type === "mouse_scroll_up" ? -1 : 1);
    } else {
      scrollBy(state, delta);
    }
    return { type: "handled" };
  }

  // Only handle press events beyond this point
  if (key.type !== "mouse_down") return { type: "handled" };

  // ── Topbar buttons (row 1) ─────────────────────────────────────
  // Layout: ≡ + Cerberus — ...
  //         ^chatCol  ^chatCol+2

  // ── `+` button → new conversation
  if (row === 1 && button === 0 && col >= L.chatCol + 2 && col <= L.chatCol + 2) {
    return { type: "new_conversation" };
  }

  // ── Hamburger icon → toggle sidebar
  if (row === 1 && col >= L.chatCol && col <= L.chatCol + 1 && button === 0) {
    toggleSidebar(state);
    return { type: "handled" };
  }

  // Clear hover on any click (tooltip shouldn't linger)
  state.sidebar.hoveredIndex = null;

  // ── Sidebar clicks ──────────────────────────────────────────────
  if (inSidebar) {
    // Click on search bar (last row of sidebar) → activate search
    if (row >= state.rows - 1 && button === 0) {
      state.panelFocus = "sidebar";
      if (!state.sidebar.searchActive) openSearch(state.sidebar);
      return { type: "handled" };
    }

    const convIdx = sidebarHitTest(row, state.sidebar);
    if (convIdx === null) return { type: "handled" };

    const conv = state.sidebar.conversations[convIdx];
    if (!conv) return { type: "handled" };

    // Right-click → open context menu
    if (button === 2) {
      state.sidebar.selectedIndex = convIdx;
      state.sidebar.selectedId = conv.id;
      state.contextMenu = {
        items: buildSidebarMenu(conv),
        selection: 0,
        row, col,
        source: "sidebar",
        convId: conv.id,
        convIdx,
      };
      clampMenuPosition(state.contextMenu, state.rows, state.cols);
      return { type: "handled" };
    }

    // Left-click → select, load, and switch to chat
    state.sidebar.selectedIndex = convIdx;
    state.sidebar.selectedId = conv.id;
    focusChat(state);
    return { type: "load_conversation", convId: conv.id };
  }

  // ── Message area interactions ──────────────────────────────────
  if (inMessages) {
    const pos = screenToHistoryPos(row, col, state);

    // Right-click → open context menu
    if (button === 2) {
      const hasSelection = state.mouseSelection !== null;
      state.contextMenu = {
        items: buildMessageMenu(hasSelection),
        selection: 0,
        row, col,
        source: "message",
        lineIdx: pos?.lineIdx ?? 0,
        visCol: pos?.visCol ?? 0,
      };
      clampMenuPosition(state.contextMenu, state.rows, state.cols);
      return { type: "handled" };
    }

    // Left-click → start drag selection
    if (button === 0 && pos) {
      state.mouseSelection = {
        anchorRow: pos.lineIdx,
        anchorCol: pos.visCol,
        endRow: pos.lineIdx,
        endCol: pos.visCol,
        finalized: false,
      };
      return { type: "handled" };
    }

    return { type: "handled" };
  }

  // ── Prompt click → focus prompt + place cursor ─────────────────
  if (inPrompt) {
    state.mouseSelection = null; // clear any message-area selection
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    if (state.vim.mode !== "insert") state.vim.mode = "insert";

    // Approximate cursor placement from click position
    const maxWidth = (state.cols - L.sidebarWidth) - PROMPT_PREFIX_LEN;
    if (maxWidth > 0) {
      const clickedLine = (row - L.firstInputRow) + state.promptScrollOffset;
      const clickedCol = Math.max(0, col - L.chatCol - PROMPT_PREFIX_LEN);
      const charPos = clickedLine * maxWidth + clickedCol;
      state.cursorPos = Math.min(Math.max(0, charPos), state.inputBuffer.length);
    }
    return { type: "handled" };
  }

  // ── Status bar click during streaming → abort ─────────────────
  if (row > L.sepBelow && isStreaming(state) && button === 0) {
    return { type: "abort" };
  }

  return { type: "handled" };
}

// ── Context menu action execution ─────────────────────────────────

function executeContextMenuAction(action: string, state: RenderState): KeyResult {
  const menu = state.contextMenu!;
  state.contextMenu = null; // close menu

  // ── Sidebar context menu actions ──────────────────────────────
  if (menu.source === "sidebar") {
    const convId = menu.convId;
    const convIdx = menu.convIdx;
    state.sidebar.selectedIndex = convIdx;
    state.sidebar.selectedId = convId;

    switch (action) {
      case "pin":
        return mapSidebarResult(handleSidebarAction("pin", state.sidebar), state);
      case "mark":
        return mapSidebarResult(handleSidebarAction("mark", state.sidebar), state);
      case "clone":
        return { type: "clone_conversation", convId };
      case "delete":
        return { type: "delete_conversation", convId };
      default:
        return { type: "handled" };
    }
  }

  // ── Message area context menu actions ─────────────────────────
  if (menu.source !== "message") return { type: "handled" };
  const { lineIdx, visCol } = menu;
  const lines = state.historyLines;
  const wrapCont = state.historyWrapContinuation;

  switch (action) {
    case "copy_selection": {
      if (state.mouseSelection) {
        const text = getMouseSelectionText(state.mouseSelection, state);
        if (text.trim()) copyToClipboard(text);
        state.mouseSelection = null;
      }
      return { type: "handled" };
    }
    case "copy_word": {
      const plain = stripAnsi(lines[lineIdx] ?? "");
      const [wStart, wEnd] = wordBoundsAt(plain, visCol);
      const word = plain.slice(wStart, wEnd + 1).trim();
      if (word) copyToClipboard(word);
      return { type: "handled" };
    }
    case "copy_line": {
      // Copy the full logical line (joining wrap continuations)
      const { first, last } = logicalLineRange(lineIdx, wrapCont);
      const text = joinLogicalLines(lines, wrapCont, first, last);
      if (text.trim()) copyToClipboard(text);
      return { type: "handled" };
    }
    case "copy_message": {
      // Find which message block this line belongs to
      const bounds = state.historyMessageBounds;
      const msgBound = bounds.find(b => lineIdx >= b.start && lineIdx < b.end);
      if (msgBound) {
        const text = joinLogicalLines(lines, wrapCont, msgBound.start, msgBound.contentEnd - 1);
        if (text.trim()) copyToClipboard(text);
      }
      return { type: "handled" };
    }
    default:
      return { type: "handled" };
  }
}

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  // ── Context menu — intercept ALL input (mouse + keyboard) ─────
  if (state.contextMenu) {
    const cr = handleContextMenuKey(key, state);
    if (cr.type === "cancel") {
      state.contextMenu = null;
      return { type: "handled" };
    }
    if (cr.type === "confirm") {
      return executeContextMenuAction(cr.action, state);
    }
    return { type: "handled" };
  }

  // ── Mouse events — route by screen position ─────────────────────
  if (key.type === "mouse_down" || key.type === "mouse_up" || key.type === "mouse_move"
    || key.type === "mouse_scroll_up" || key.type === "mouse_scroll_down") {
    return handleMouse(key, state);
  }

  // Any keyboard input clears mouse drag selection
  if (state.mouseSelection) {
    stopDragScroll();
    state.mouseSelection = null;
  }

  // ── Sidebar search — intercept keys while search input is active ──
  if (state.sidebar.searchActive && state.panelFocus === "sidebar") {
    const sr = handleSearchKey(key, state.sidebar);
    if (sr.type === "select") {
      focusChat(state);
      return { type: "load_conversation", convId: sr.convId };
    }
    return { type: "handled" };
  }

  // ── Queue prompt modal — intercept all keys when showing ──────
  if (state.queuePrompt) {
    const qr = handleQueuePromptKey(key, state);
    if (qr.type === "confirm") return { type: "queue_confirm" };
    if (qr.type === "cancel")  return { type: "queue_cancel" };
    return { type: "handled" };
  }

  // ── Edit message modal — intercept all keys when showing ─────
  if (state.editMessagePrompt) {
    const er = handleEditMessageKey(key, state);
    if (er.type === "confirm") return { type: "edit_message_confirm" };
    if (er.type === "cancel")  return { type: "edit_message_cancel" };
    return { type: "handled" };
  }

  // Bracketed paste — insert directly into prompt buffer, newlines preserved
  if (key.type === "paste" && key.text) {
    // Normalize line endings: \r\n → \n, stray \r → \n
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const pos = state.cursorPos;
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
    state.autocomplete = null;
    // Ensure prompt is focused and in insert mode
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    if (state.vim.mode !== "insert") state.vim.mode = "insert";
    return { type: "handled" };
  }

  const action = resolveAction(key);

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
    case "sidebar_toggle":
      toggleSidebar(state);
      return { type: "handled" };
    case "focus_cycle":
      if (state.sidebar.open) {
        state.panelFocus = state.panelFocus === "sidebar" ? "chat" : "sidebar";
        if (state.panelFocus === "sidebar") state.vim.mode = "normal";
      }
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "edit_message":
      openEditMessageModal(state);
      return { type: "handled" };
    case "focus_history":
      // Toggle: if already in history → back to prompt, otherwise → history
      if (state.panelFocus === "chat" && state.chatFocus === "history") {
        state.chatFocus = "prompt";
        state.vim.mode = "insert";
      } else {
        state.panelFocus = "chat";
        state.chatFocus = "history";
        state.vim.mode = "normal";
        state.historyCursor = placeAtVisibleBottom(state);
      }
      return { type: "handled" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars
      const isPromptTyping = state.panelFocus === "chat" && state.chatFocus === "prompt"
        && state.vim.mode === "insert";
      if (isPromptTyping) break;
      if (!state.sidebar.open) {
        state.sidebar.open = true;
        // Default cursor to the current conversation before moving
        if (state.convId) {
          state.sidebar.selectedId = state.convId;
          syncSelectedIndex(state.sidebar);
        }
      }
      state.panelFocus = "sidebar";
      state.vim.mode = "normal";
      moveSelection(state.sidebar, action === "sidebar_next" ? 1 : -1);
      return { type: "handled" };
    }
    case "scroll_line_up":
    case "scroll_line_down":
    case "scroll_half_up":
    case "scroll_half_down":
    case "scroll_page_up":
    case "scroll_page_down":
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action, state);
      return { type: "handled" };
    case "toggle_tool_output":
      state.showToolOutput = !state.showToolOutput;
      return { type: "handled" };
    case "paste_image": {
      const img = readClipboardImage();
      if (img) {
        state.pendingImages.push(img);
        // Force focus to prompt in insert mode so user can type a caption
        state.panelFocus = "chat";
        state.chatFocus = "prompt";
        if (state.vim.mode !== "insert") state.vim.mode = "insert";
      }
      return { type: "handled" };
    }
  }

  // ── Abort (Ctrl+Q) — always fires, regardless of focus or vim mode ─
  if (action === "abort") {
    return { type: "abort" };
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (key.type === "escape" && state.panelFocus === "sidebar" && state.sidebar.pendingDeleteId) {
    state.sidebar.pendingDeleteId = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Autocomplete dismiss on Escape ─────────────────────────────
  // Must happen before vim so the buffer is restored before vim
  // computes the normal-mode cursor position.
  if (key.type === "escape" && state.autocomplete) {
    dismissAutocomplete(state);
  }

  // ── Sidebar marks (digit keys) — intercept before vim count prefix ──
  // Digits 1-9 would be consumed as vim count prefixes, so we handle
  // them here for the sidebar where they toggle emoji marks on titles.
  if (state.panelFocus === "sidebar" && state.sidebar.open
      && state.vim.mode === "normal"
      && key.type === "char" && key.char && /^[0-9]$/.test(key.char)) {
    return mapSidebarResult(handleSidebarMark(state.sidebar, parseInt(key.char, 10)), state);
  }

  // ── Vim processing ─────────────────────────────────────────────
  const vimResult = processVimKey(key, state);
  if (vimResult) return vimResult;

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

  // History-specific find handling: f/F/;/, operate on history lines, not prompt buffer
  if (context === "history" && state.vim.mode !== "insert") {
    if (historyFindHandler(key, state)) return { type: "handled" };
  }

  // Message text object (im/am) — intercept before engine for all contexts
  const msgResult = handleMessageTextObject(key, state, context);
  if (msgResult) return msgResult;

  // History text objects (iw, aw, i", a", vi(, etc.) — resolve against
  // history lines instead of the prompt buffer the engine receives
  if (context === "history" && state.vim.pendingTextObjectModifier) {
    const htResult = historyTextObjectHandler(key, state);
    if (htResult) return htResult;
  }

  const prevMode = state.vim.mode;
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
      if (result.mode === "insert") {
        // Commands that edit + enter insert (o, O, c, C, cc):
        // Mark insert entry with state BEFORE the edit — the entire
        // edit + insert session is one undo unit (like vim).
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      } else {
        // Pure normal-mode edit (dd, x, D, etc) — standalone undo unit
        pushUndo(state.undo, state.inputBuffer, state.cursorPos);
      }
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      if (result.mode) {
        state.vim.mode = result.mode;
      } else {
        clampCursorNormal(state);
      }
      return { type: "handled" };

    case "yank":
      copyToClipboard(result.text);
      return { type: "handled" };

    case "paste":
      handlePaste(result.position, state);
      return { type: "handled" };

    case "visual_edit":
      if (result.mode === "insert") {
        // visual c — edit + insert is one undo unit
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      } else {
        // visual d — standalone undo unit
        pushUndo(state.undo, state.inputBuffer, state.cursorPos);
      }
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      state.vim.mode = result.mode;
      return { type: "handled" };

    case "undo": {
      const snap = undoFn(state.undo, state.inputBuffer, state.cursorPos);
      if (snap) {
        state.inputBuffer = snap.buffer;
        state.cursorPos = clampNormal(snap.buffer, snap.cursor);
      }
      return { type: "handled" };
    }

    case "redo": {
      const snap = redoFn(state.undo, state.inputBuffer, state.cursorPos);
      if (snap) {
        state.inputBuffer = snap.buffer;
        state.cursorPos = clampNormal(snap.buffer, snap.cursor);
      }
      return { type: "handled" };
    }

    case "mode_change":
      // Commit insert session when leaving insert mode
      // (prevMode needed because engine mutates vim.mode before returning)
      if (prevMode === "insert" && result.mode !== "insert") {
        commitInsertSession(state.undo, state.inputBuffer);
      }
      state.vim.mode = result.mode;
      if (result.cursor !== undefined) state.cursorPos = result.cursor;
      // Mark insert entry when entering insert mode
      if (result.mode === "insert") {
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      }
      // Set visual anchor for history when entering visual mode
      if ((result.mode === "visual" || result.mode === "visual-line")
          && state.chatFocus === "history") {
        state.historyVisualAnchor = { ...state.historyCursor };
      }
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
  // History cursor actions (including visual yank)
  if ((action as Action).startsWith("history_")) {
    return handleHistoryCursorAction(action as Action, state);
  }

  switch (action) {
    case "quit":
      return { type: "quit" };
    case "abort":
      return { type: "abort" };
    case "sidebar_toggle":
      toggleSidebar(state);
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "search":
      if (state.panelFocus === "sidebar") {
        openSearch(state.sidebar);
      }
      return { type: "handled" };
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
    case "delete":
    case "undo_delete":
    case "mark":
    case "pin":
    case "move_up":
    case "move_down":
    case "clone":
      return trySidebarAction(action, state);
    case "scroll_up":
      scrollUp(state);
      return { type: "handled" };
    case "scroll_down":
      scrollDown(state);
      return { type: "handled" };
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action as Action, state);
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
}

// ── Sidebar result mapping ────────────────────────────────────────

/**
 * Dispatch an action to the sidebar if focused, mapping the result
 * to a KeyResult. Returns "handled" if sidebar isn't focused.
 */
function trySidebarAction(action: string, state: RenderState): KeyResult {
  if (state.panelFocus !== "sidebar") return { type: "handled" };
  return mapSidebarResult(handleSidebarAction(action, state.sidebar), state);
}

/** Map a SidebarKeyResult to a KeyResult. */
function mapSidebarResult(result: SidebarKeyResult, state: RenderState): KeyResult {
  switch (result.type) {
    case "select":
      focusChat(state);
      return { type: "load_conversation", convId: result.convId };
    case "handled":
    case "unhandled":
      return { type: "handled" };
    default:
      // Remaining variants (delete_conversation, undo_delete, mark_conversation,
      // rename_conversation, pin_conversation, move_conversation,
      // clone_conversation) are directly valid KeyResult types — forward as-is.
      return result;
  }
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

    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
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

/**
 * Route scroll actions. When history cursor is active, uses vim-style
 * cursor-aware scrolling. Otherwise falls back to viewport-only scroll.
 */
function handleScrollAction(action: Action, state: RenderState): void {
  const inHistory = state.panelFocus === "chat" && state.chatFocus === "history";

  if (inHistory) {
    // Vim-style: cursor moves with scroll
    switch (action) {
      case "scroll_line_up":   scrollLineWithStickyCursor(state, 1);  return;
      case "scroll_line_down": scrollLineWithStickyCursor(state, -1); return;
      case "scroll_half_up":   scrollHalfPageWithCursor(state, 1);    return;
      case "scroll_half_down": scrollHalfPageWithCursor(state, -1);   return;
      case "scroll_page_up":   scrollFullPageWithCursor(state, 1);    return;
      case "scroll_page_down": scrollFullPageWithCursor(state, -1);   return;
      case "scroll_top":       scrollToTop(state); ensureCursorVisible(state); return;
      case "scroll_bottom":    scrollToBottom(state); ensureCursorVisible(state); return;
    }
  }

  // Viewport-only (prompt focused, sidebar, etc.)
  switch (action) {
    case "scroll_line_up":   scrollLineUp(state);   break;
    case "scroll_line_down": scrollLineDown(state);  break;
    case "scroll_half_up":   scrollHalfUp(state);    break;
    case "scroll_half_down": scrollHalfDown(state);  break;
    case "scroll_page_up":   scrollPageUp(state);    break;
    case "scroll_page_down": scrollPageDown(state);  break;
    case "scroll_top":       scrollToTop(state);     break;
    case "scroll_bottom":    scrollToBottom(state);  break;
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

  if (result.type === "unhandled") {
    // focus_prompt comes back as unhandled from sidebar (i/a)
    state.panelFocus = "chat";
    return { type: "handled" };
  }

  return mapSidebarResult(result, state);
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
