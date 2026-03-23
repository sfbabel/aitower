/**
 * Key hints status block — context-sensitive keybinding hints.
 *
 * Shows the most relevant keys for the current mode and focus,
 * so you always know what actions are available without memorizing
 * the full keybinding table.
 */

import type { RenderState } from "../state";
import type { StatusBlock } from "../statusline";
import { isStreaming } from "../state";
import { theme } from "../theme";

// ── Hint sets ───────────────────────────────────────────────────────

interface Hint { key: string; desc: string }

const PROMPT_INSERT: Hint[] = [
  { key: "Enter", desc: "send" },
  { key: "Shift+Enter", desc: "newline" },
  { key: "Esc", desc: "done typing" },
  { key: "/keys", desc: "all keys" },
];

const PROMPT_NORMAL: Hint[] = [
  { key: "i", desc: "type" },
  { key: "s", desc: "conversations" },
  { key: "n", desc: "new chat" },
  { key: "j/k", desc: "scroll" },
];

const SIDEBAR: Hint[] = [
  { key: "Enter", desc: "open" },
  { key: "j/k", desc: "navigate" },
  { key: "right-click", desc: "menu" },
  { key: "s", desc: "close" },
];

const HISTORY: Hint[] = [
  { key: "j/k", desc: "scroll" },
  { key: "i", desc: "type" },
  { key: "s", desc: "conversations" },
  { key: "yy", desc: "copy" },
  { key: "v", desc: "select" },
];

const STREAMING: Hint[] = [
  { key: "q or ■", desc: "stop" },
  { key: "j/k", desc: "scroll" },
];

const VISUAL: Hint[] = [
  { key: "y", desc: "yank" },
  { key: "d", desc: "delete" },
  { key: "Esc", desc: "cancel" },
];

// ── Hint rendering ──────────────────────────────────────────────────

function selectHints(state: RenderState): Hint[] {
  if (isStreaming(state)) return STREAMING;

  const vim = state.vim.mode;
  if (vim === "visual" || vim === "visual-line") return VISUAL;

  if (state.panelFocus === "sidebar") return SIDEBAR;
  if (state.chatFocus === "history") return HISTORY;

  // Prompt
  return vim === "insert" ? PROMPT_INSERT : PROMPT_NORMAL;
}

function renderHintLine(hints: Hint[], maxWidth: number): { line: string; width: number } {
  const sep = theme.muted + " │ ";
  const sepWidth = 3;
  let line = "  ";
  let width = 2;

  for (let i = 0; i < hints.length; i++) {
    const h = hints[i];
    const part = `${theme.accent}${h.key}${theme.muted} ${h.desc}`;
    const partWidth = h.key.length + 1 + h.desc.length;

    const needed = i > 0 ? sepWidth + partWidth : partWidth;
    if (width + needed > maxWidth) break;

    if (i > 0) { line += sep; width += sepWidth; }
    line += part;
    width += partWidth;
  }

  return { line, width };
}

// ── Block builder ───────────────────────────────────────────────────

export function hintsBlock(state: RenderState): StatusBlock | null {
  const hints = selectHints(state);
  const { line, width } = renderHintLine(hints, state.cols - 10);

  return {
    id: "hints",
    priority: 10,       // highest priority — always visible
    width,
    height: 1,
    rows: [line + theme.reset],
  };
}
