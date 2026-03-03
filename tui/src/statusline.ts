/**
 * Status line renderer.
 *
 * Renders the usage bars below the input prompt.
 * This is the only file that knows how to display usage data.
 */

import type { UsageData, UsageWindow } from "./messages";

// ── ANSI ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const FG_ACCENT = `${ESC}38;5;75m`;
const FG_WHITE = `${ESC}37m`;

// ── Formatting ──────────────────────────────────────────────────────

const BAR_WIDTH = 20;

function renderBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return FG_ACCENT + "\u2588".repeat(filled) + DIM + "\u2591".repeat(empty);
}

function formatTimeUntil(resetMs: number | null, now: number): string {
  if (resetMs === null) return "";
  const diff = Math.floor((resetMs - now) / 1000);
  if (diff <= 0) return "";

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d:${hours}h:${pad2(mins)}m`;
  return `${hours}h:${pad2(mins)}m`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function renderWindowLine(label: string, window: UsageWindow, now: number): string {
  const pctStr = `${Math.round(window.utilization)}%`;
  const resetStr = formatTimeUntil(window.resetsAt, now);
  const bar = renderBar(window.utilization);
  const resetPart = resetStr ? ` resets in ${FG_ACCENT}${resetStr}` : "";
  return `${DIM}${label}: ${FG_WHITE}[${bar}${FG_WHITE}]${DIM} ${FG_ACCENT}${pctStr}${DIM}${resetPart}${RESET}`;
}

// ── Public renderer ─────────────────────────────────────────────────

/**
 * Render the status line.
 * Returns an array of ANSI strings (one per row), or empty if no data.
 */
export function renderStatusLine(usage: UsageData | null): string[] {
  if (!usage) return [];

  const now = Date.now();
  const lines: string[] = [];

  if (usage.fiveHour) {
    lines.push(renderWindowLine("5-Hour", usage.fiveHour, now));
  }
  if (usage.sevenDay) {
    lines.push(renderWindowLine("Weekly", usage.sevenDay, now));
  }

  return lines;
}

/** Number of terminal rows the status line occupies. */
export function statusLineHeight(usage: UsageData | null): number {
  if (!usage) return 0;
  let h = 0;
  if (usage.fiveHour) h++;
  if (usage.sevenDay) h++;
  return h;
}
