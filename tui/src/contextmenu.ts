/**
 * Right-click context menu.
 *
 * Handles key/mouse events and rendering for the dropdown
 * that appears when right-clicking sidebar conversations or
 * the message area.
 */

import type { KeyEvent } from "./input";
import type { RenderState, ContextMenuState, ContextMenuItem } from "./state";
import type { ConversationSummary } from "./messages";
import { theme } from "./theme";

// ── Menu builders ───────────────────────────────────────────────────

/** Build menu items for a sidebar conversation. */
export function buildSidebarMenu(conv: ConversationSummary): ContextMenuItem[] {
  if (!conv) return [];

  return [
    { label: conv.pinned ? "Unpin" : "Pin", action: "pin" },
    { label: conv.marked ? "Unstar" : "Star", action: "mark" },
    { label: "Clone", action: "clone" },
    { label: "Delete", action: "delete" },
  ];
}

/** Build menu items for a right-click in the message area. */
export function buildMessageMenu(hasSelection: boolean): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (hasSelection) {
    items.push({ label: "Copy selection", action: "copy_selection" });
  }
  items.push({ label: "Copy word", action: "copy_word" });
  items.push({ label: "Copy line", action: "copy_line" });
  items.push({ label: "Copy message", action: "copy_message" });
  return items;
}

/**
 * Clamp menu anchor position so the box fits on screen.
 * Call this when creating a ContextMenuState to ensure the
 * hit-test coordinates match the rendered position.
 */
export function clampMenuPosition(
  menu: ContextMenuState,
  rows: number,
  cols: number,
): void {
  const innerWidth = Math.max(...menu.items.map(i => i.label.length)) + 4;
  const boxWidth = innerWidth + 2;
  const boxHeight = menu.items.length + 2;
  if (menu.row + boxHeight > rows) menu.row = Math.max(1, rows - boxHeight);
  if (menu.col + boxWidth > cols) menu.col = Math.max(1, cols - boxWidth);
}

// ── Key handling ────────────────────────────────────────────────────

export type ContextMenuResult =
  | { type: "handled" }
  | { type: "confirm"; action: string }
  | { type: "cancel" };

export function handleContextMenuKey(key: KeyEvent, state: RenderState): ContextMenuResult {
  const menu = state.contextMenu!;

  // Mouse click on a menu item
  if (key.type === "mouse_down" && key.row && key.col) {
    const itemRow = key.row - (menu.row + 1); // +1 for top border
    if (itemRow >= 0 && itemRow < menu.items.length) {
      // Check if click is within the menu box width
      const menuWidth = Math.max(...menu.items.map(i => i.label.length)) + 6;
      if (key.col >= menu.col && key.col < menu.col + menuWidth) {
        menu.selection = itemRow;
        return { type: "confirm", action: menu.items[itemRow].action };
      }
    }
    // Click outside menu → cancel
    return { type: "cancel" };
  }

  // Mouse hover → highlight menu items
  if (key.type === "mouse_move" && key.row && key.col) {
    const menuWidth = Math.max(...menu.items.map(i => i.label.length)) + 6;
    const itemRow = key.row - (menu.row + 1);
    if (itemRow >= 0 && itemRow < menu.items.length
        && key.col >= menu.col && key.col < menu.col + menuWidth) {
      menu.selection = itemRow;
    }
    return { type: "handled" };
  }

  // Mouse release/scroll → ignore
  if (key.type === "mouse_up" || key.type === "mouse_scroll_up" || key.type === "mouse_scroll_down") {
    return { type: "handled" };
  }

  switch (key.type) {
    case "char":
      if (key.char === "j") {
        if (menu.selection < menu.items.length - 1) menu.selection++;
      } else if (key.char === "k") {
        if (menu.selection > 0) menu.selection--;
      }
      return { type: "handled" };
    case "down":
      if (menu.selection < menu.items.length - 1) menu.selection++;
      return { type: "handled" };
    case "up":
      if (menu.selection > 0) menu.selection--;
      return { type: "handled" };
    case "enter":
      return { type: "confirm", action: menu.items[menu.selection].action };
    case "escape":
    case "ctrl-c":
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

// ── Rendering ───────────────────────────────────────────────────────

const ESC = "\x1b[";
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

export function renderContextMenu(menu: ContextMenuState, rows: number, cols: number): string {
  const items = menu.items;
  if (items.length === 0) return "";

  const innerWidth = Math.max(...items.map(i => i.label.length)) + 4; // padding
  const boxWidth = innerWidth + 2; // borders

  // Position: anchor at click point, extend downward
  let boxTop = menu.row;
  let boxLeft = menu.col;

  // Clamp: don't extend beyond screen edges
  const boxHeight = items.length + 2; // items + top/bottom border
  if (boxTop + boxHeight > rows) boxTop = Math.max(1, rows - boxHeight);
  if (boxLeft + boxWidth > cols) boxLeft = Math.max(1, cols - boxWidth);

  let out = "";

  // Top border
  out += move_to(boxTop, boxLeft);
  out += `${theme.sidebarBg}${theme.accent}┌${"─".repeat(innerWidth)}┐${theme.reset}`;

  // Items
  for (let i = 0; i < items.length; i++) {
    const row = boxTop + 1 + i;
    const isSelected = i === menu.selection;
    const marker = isSelected ? "▸ " : "  ";
    const label = items[i].label;
    const padRight = Math.max(0, innerWidth - marker.length - label.length);

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = items[i].action === "delete"
      ? (isSelected ? theme.error : theme.muted)
      : (isSelected ? theme.accent : theme.text);

    out += move_to(row, boxLeft);
    out += `${theme.sidebarBg}${theme.accent}│${bg}${fg}`;
    out += `${marker}${label}${" ".repeat(padRight)}`;
    out += `${theme.reset}${theme.sidebarBg}${theme.accent}│${theme.reset}`;
  }

  // Bottom border
  const bottomRow = boxTop + 1 + items.length;
  out += move_to(bottomRow, boxLeft);
  out += `${theme.sidebarBg}${theme.accent}└${"─".repeat(innerWidth)}┘${theme.reset}`;

  return out;
}
