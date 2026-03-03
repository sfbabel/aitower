/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
import { theme } from "./theme";

// ── Constants ───────────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 28;

// ── State ───────────────────────────────────────────────────────────

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  selectedIndex: number;
  scrollOffset: number;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    selectedIndex: 0,
    scrollOffset: 0,
  };
}

// ── Key handling ────────────────────────────────────────────────────

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "unhandled" };

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  switch (key.type) {
    case "char":
      if (key.char === "j" || key.char === "J") {
        moveSelection(sidebar, 1);
        return { type: "handled" };
      }
      if (key.char === "k" || key.char === "K") {
        moveSelection(sidebar, -1);
        return { type: "handled" };
      }
      if (key.char === "i" || key.char === "a") {
        return { type: "unhandled" };
      }
      return { type: "handled" };

    case "up":
      moveSelection(sidebar, -1);
      return { type: "handled" };

    case "down":
      moveSelection(sidebar, 1);
      return { type: "handled" };

    case "enter":
      if (sidebar.conversations.length > 0) {
        return { type: "select", convId: sidebar.conversations[sidebar.selectedIndex].id };
      }
      return { type: "handled" };

    default:
      return { type: "handled" };
  }
}

function moveSelection(sidebar: SidebarState, delta: number): void {
  sidebar.selectedIndex = Math.max(0, Math.min(
    sidebar.selectedIndex + delta,
    sidebar.conversations.length - 1,
  ));
}

// ── State updates ───────────────────────────────────────────────────

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[]): void {
  sidebar.conversations = conversations;
  if (sidebar.selectedIndex >= conversations.length) {
    sidebar.selectedIndex = Math.max(0, conversations.length - 1);
  }
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary): void {
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    sidebar.conversations.unshift(summary);
  }
  sidebar.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Pad or truncate a string to exactly `width` visible characters. */
function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

// ── Rendering ───────────────────────────────────────────────────────

export function renderSidebar(
  sidebar: SidebarState,
  totalRows: number,
  focused: boolean,
  currentConvId: string | null,
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;

  // Row 1: header
  const header = " Conversations";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold +
    pad(header, innerWidth) +
    theme.reset + borderFg + "│" + theme.reset,
  );

  // Row 2: separator with ┤ junction
  rows.push(
    borderFg +
    "─".repeat(innerWidth) + "┤" + theme.reset,
  );

  // Remaining rows: conversation list
  const listRows = totalRows - 2;
  const convs = sidebar.conversations;

  // Scroll to keep selection visible
  let scrollOffset = sidebar.scrollOffset;
  if (sidebar.selectedIndex < scrollOffset) {
    scrollOffset = sidebar.selectedIndex;
  } else if (sidebar.selectedIndex >= scrollOffset + listRows) {
    scrollOffset = sidebar.selectedIndex - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, convs.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const ci = scrollOffset + i;

    if (ci >= convs.length) {
      // Empty row
      rows.push(
        theme.sidebarBg +
        " ".repeat(innerWidth) +
        theme.reset + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const conv = convs[ci];
    const isSelected = ci === sidebar.selectedIndex;
    const isCurrent = conv.id === currentConvId;

    // Build entry
    const prefix = isSelected ? "▸ " : "  ";
    const maxTitle = innerWidth - prefix.length;
    let title = conv.preview || "(empty)";
    // Take first line only
    const nlIdx = title.indexOf("\n");
    if (nlIdx !== -1) title = title.slice(0, nlIdx);
    if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + "…";

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = (isSelected || isCurrent) ? theme.text : theme.muted;
    const titleText = isCurrent ? theme.bold + title + theme.boldOff : title;
    const plainLen = prefix.length + title.length;
    const padding = Math.max(0, innerWidth - plainLen);

    rows.push(
      bg + fg +
      prefix + titleText + " ".repeat(padding) +
      theme.reset + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}
