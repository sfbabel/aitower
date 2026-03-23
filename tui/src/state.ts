/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import type { ModelId, EffortLevel, UsageData, ToolDisplayInfo, ImageAttachment } from "./messages";
import { DEFAULT_EFFORT } from "./messages";
import type { Message, AIMessage, SystemMessage } from "./messages";
import type { MessageBound } from "./conversation";
import type { PanelFocus } from "./focus";
import type { ChatFocus } from "./chat";
import type { SidebarState } from "./sidebar";
import { createSidebarState } from "./sidebar";
import type { VimState } from "./vim";
import { createVimState } from "./vim";
import type { HistoryCursor } from "./historycursor";
import { createHistoryCursor } from "./historycursor";
import type { UndoState } from "./undo";
import { createUndoState, markInsertEntry } from "./undo";
import type { AutocompleteState } from "./autocomplete";
import type { QueueTiming } from "./protocol";

// ── Queue types ────────────────────────────────────────────────────

export type { QueueTiming } from "./protocol";

export interface QueuedMessage {
  convId: string;
  text: string;
  timing: QueueTiming;
}

export interface QueuePromptState {
  text: string;            // the message text being queued
  selection: QueueTiming;  // which option is highlighted
}

// ── Edit message modal types ──────────────────────────────────────

export interface EditMessageItem {
  /** Index counting only user messages (0-based). -1 for queued messages. */
  userMessageIndex: number;
  text: string;
  isQueued: boolean;
  images?: ImageAttachment[];
}

export interface EditMessageState {
  items: EditMessageItem[];
  selection: number;        // index into items[]
  scrollOffset: number;     // for scrolling long lists
}

// ── Context menu types ──────────────────────────────────────────────

export interface ContextMenuItem {
  label: string;
  action: string;
}

/** Shared fields for all context menus. */
interface ContextMenuBase {
  items: ContextMenuItem[];
  selection: number;
  row: number;        // screen anchor (1-based, pre-clamped)
  col: number;        // screen anchor (1-based, pre-clamped)
}

/** Right-click on a sidebar conversation. */
export interface SidebarMenuState extends ContextMenuBase {
  source: "sidebar";
  convId: string;
  convIdx: number;
}

/** Right-click in the message area. */
export interface MessageMenuState extends ContextMenuBase {
  source: "message";
  lineIdx: number;    // history line index where right-click occurred
  visCol: number;     // visible column where right-click occurred
}

export type ContextMenuState = SidebarMenuState | MessageMenuState;

// ── Mouse selection types ───────────────────────────────────────────

/** Mouse drag selection in the message area. */
export interface MouseSelection {
  /** History line index where drag started. */
  anchorRow: number;
  /** Visible column where drag started. */
  anchorCol: number;
  /** History line index of current drag end. */
  endRow: number;
  /** Visible column of current drag end. */
  endCol: number;
  /** Whether the selection is finalized (mouse released). */
  finalized: boolean;
}

/** Normalized selection range (start ≤ end). */
export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Normalize a MouseSelection so start ≤ end. */
export function normalizeSelection(sel: MouseSelection): SelectionRange {
  if (sel.anchorRow < sel.endRow || (sel.anchorRow === sel.endRow && sel.anchorCol <= sel.endCol)) {
    return { startRow: sel.anchorRow, startCol: sel.anchorCol, endRow: sel.endRow, endCol: sel.endCol };
  }
  return { startRow: sel.endRow, startCol: sel.endCol, endRow: sel.anchorRow, endCol: sel.anchorCol };
}

// ── Layout cache ────────────────────────────────────────────────────

/** First row of the message area (1-based). Topbar=1, sep=2, messages start at 3. */
export const MSG_AREA_START = 3;

/** Cached layout values — set by the renderer, read by scroll and mouse functions. */
export interface LayoutCache {
  totalLines: number;      // total rendered message lines
  messageAreaHeight: number; // visible rows for messages
  // Mouse targeting (1-based row/col)
  sidebarWidth: number;    // 0 when sidebar is closed
  chatCol: number;         // first column of chat area
  sepAbove: number;        // separator row above input
  firstInputRow: number;   // first row of prompt input
  sepBelow: number;        // separator row below input
}

/**
 * Compute the first history-line index visible in the viewport.
 * Pure function — no state mutation.
 */
export function viewStart(totalLines: number, areaHeight: number, scrollOffset: number): number {
  return Math.max(0, totalLines - areaHeight - scrollOffset);
}

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  model: ModelId;
  effort: EffortLevel;
  convId: string | null;
  inputBuffer: string;
  cursorPos: number;
  cols: number;
  rows: number;
  scrollOffset: number;
  /** Rate-limit usage data from the daemon. Null until first update. */
  usage: UsageData | null;
  /** Input tokens from the latest API round. Null until first context_update. */
  contextTokens: number | null;
  /** Which panel has focus — sidebar or chat. */
  panelFocus: PanelFocus;
  /** Which sub-panel within chat has focus — prompt or history. */
  chatFocus: ChatFocus;
  /** Conversations sidebar state. */
  sidebar: SidebarState;
  /** Vim keybind engine state. */
  vim: VimState;
  /** Cached layout values — updated each render, read by scroll functions. */
  layout: LayoutCache;
  /** Pending message to send after conversation is created. */
  pendingSend: { active: boolean; text: string; images?: ImageAttachment[] };
  /** System messages buffered during streaming — flushed after AI message completes. */
  systemMessageBuffer: SystemMessage[];
  /** Available tools reported by the daemon on connect. */
  toolRegistry: ToolDisplayInfo[];
  /** Whether tool result output is visible. Toggled with Ctrl+O. */
  showToolOutput: boolean;
  /** Cursor position in chat history (active when chatFocus === "history"). */
  historyCursor: HistoryCursor;
  /** Visual mode anchor in chat history (row, col). Set when entering visual. */
  historyVisualAnchor: HistoryCursor;
  /** Cached rendered lines for history cursor navigation (ANSI included). */
  historyLines: string[];
  /** true for visual lines that are word-wrap continuations of the previous logical line. */
  historyWrapContinuation: boolean[];
  /** Per-message row ranges into historyLines (set by renderer). */
  historyMessageBounds: MessageBound[];
  /** Undo/redo state for the prompt line. */
  undo: UndoState;
  /** Autocomplete popup state (command or path completion). */
  autocomplete: AutocompleteState | null;
  /** Scroll offset for the prompt input area (vim-style: only scrolls when cursor leaves viewport). */
  promptScrollOffset: number;
  /** Queue prompt overlay — non-null when the modal is showing. */
  queuePrompt: QueuePromptState | null;
  /** Messages queued for delivery at a specific timing. */
  queuedMessages: QueuedMessage[];
  /** Edit message modal — non-null when the modal is showing. */
  editMessagePrompt: EditMessageState | null;
  /** Right-click context menu — non-null when visible. */
  contextMenu: ContextMenuState | null;
  /** Mouse drag selection in the message area (null when inactive). */
  mouseSelection: MouseSelection | null;
  /** Number of pendingAI blocks already finalized into split AI messages
   *  (from next-turn queued message injection during streaming). */
  pendingAISplitOffset: number;
  /** Images pasted from clipboard, waiting to be sent with the next message. */
  pendingImages: ImageAttachment[];
}

/** Streaming state is derived from pendingAI — no separate boolean. */
export function isStreaming(state: RenderState): boolean {
  return state.pendingAI !== null;
}

/** Clear pending AI state — always use this instead of setting pendingAI = null directly. */
export function clearPendingAI(state: RenderState): void {
  state.pendingAI = null;
  state.pendingAISplitOffset = 0;
}

export function createInitialState(): RenderState {
  const s: RenderState = {
    messages: [],
    pendingAI: null,
    model: "opus",
    effort: DEFAULT_EFFORT,
    convId: null,
    inputBuffer: "",
    cursorPos: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
    usage: null,
    contextTokens: null,
    panelFocus: "chat",
    chatFocus: "prompt",
    sidebar: createSidebarState(),
    vim: createVimState(),
    layout: { totalLines: 0, messageAreaHeight: 0, sidebarWidth: 0, chatCol: 1, sepAbove: 0, firstInputRow: 0, sepBelow: 0 },
    pendingSend: { active: false, text: "" },
    systemMessageBuffer: [],
    toolRegistry: [],
    showToolOutput: false,
    historyCursor: createHistoryCursor(),
    historyVisualAnchor: createHistoryCursor(),
    historyLines: [],
    historyWrapContinuation: [],
    historyMessageBounds: [],
    undo: createUndoState(),
    autocomplete: null,
    promptScrollOffset: 0,
    queuePrompt: null,
    queuedMessages: [],
    editMessagePrompt: null,
    contextMenu: null,
    mouseSelection: null,
    pendingAISplitOffset: 0,
    pendingImages: [],
  };
  // App starts in insert mode — mark entry so first Esc commits the session
  markInsertEntry(s.undo, s.inputBuffer, s.cursorPos);
  return s;
}
