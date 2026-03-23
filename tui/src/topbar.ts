/**
 * Top bar renderer.
 *
 * Renders the top bar: app name, conversation title/preview, model.
 * This is the only file that knows how to render the top bar.
 */

import type { RenderState } from "./state";
import { isStreaming } from "./state";
import { convDisplayName } from "./messages";
import { theme } from "./theme";

/** Max visible length for a conversation preview used as label. */
const PREVIEW_MAX = 30;

/** Resolve a display label for the current conversation from the sidebar list. */
function convLabel(state: RenderState): string {
  if (!state.convId) return "";
  const conv = state.sidebar.conversations.find(c => c.id === state.convId);
  if (!conv) return "";
  const name = convDisplayName(conv);
  if (name.length > PREVIEW_MAX) return name.slice(0, PREVIEW_MAX) + "…";
  return name;
}

export function renderTopbar(state: RenderState, width?: number): string {
  const w = width ?? state.cols;

  const hamburger = `${theme.muted}≡${theme.reset}${theme.topbarBg}`;
  const newBtn = ` ${theme.accent}+${theme.reset}${theme.topbarBg}`;
  const title = `${theme.bold} Cerberus${theme.reset}${theme.topbarBg}`;
  const modelLabel = state.model.charAt(0).toUpperCase() + state.model.slice(1);
  const label = convLabel(state);
  const separator = label ? " — " : "";

  // Mode badge: shows what state you're in
  const modeBadge = isStreaming(state) ? `${theme.warning}● streaming`
    : state.panelFocus === "sidebar" ? `${theme.accent}● sidebar`
    : state.vim.mode === "insert" ? `${theme.vimInsert}● typing`
    : (state.vim.mode === "visual" || state.vim.mode === "visual-line") ? `${theme.vimVisual}● visual`
    : `${theme.vimNormal}● ready`;
  const modeBadgeVisible = isStreaming(state) ? "● streaming"
    : state.panelFocus === "sidebar" ? "● sidebar"
    : state.vim.mode === "insert" ? "● typing"
    : (state.vim.mode === "visual" || state.vim.mode === "visual-line") ? "● visual"
    : "● ready";

  const rightLabel = `${modeBadge}${theme.reset}${theme.topbarBg}${theme.muted} — ${modelLabel}`;
  const rightLabelVisible = modeBadgeVisible + " — " + modelLabel;
  const inner = `${hamburger}${newBtn}${title}${separator}${label}`;
  const visibleUsed = 1 + 2 + " Cerberus".length + separator.length + label.length;
  const padding = Math.max(0, w - visibleUsed - rightLabelVisible.length - 1);

  return `${theme.topbarBg}${inner}${" ".repeat(padding)}${rightLabel} ${theme.reset}`;
}
