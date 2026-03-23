/**
 * Output formatting for CLI responses.
 *
 * Three modes:
 * - text (default): human/AI-readable, filtered output
 * - json: structured JSON, everything included
 * - stream: NDJSON events as they arrive (handled in main, not here)
 */

import type { Block, DisplayEntry } from "@aitower/shared/protocol";
import type { CollectedResponse } from "./collect";

// ── Text formatting ─────────────────────────────────────────────────

/**
 * Format blocks as plain text.
 *
 * Default: text blocks + tool call summaries.
 * Full: also includes thinking blocks and tool result output.
 */
export function formatBlocksAsText(blocks: Block[], full: boolean): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "tool_call":
        parts.push(`  ╸ ${block.summary}`);
        break;
      case "tool_result":
        if (full) {
          const prefix = block.isError ? "  ✗ " : "  ┃ ";
          const indented = block.output
            .split("\n")
            .map((l) => prefix + l)
            .join("\n");
          parts.push(indented);
        }
        break;
      case "thinking":
        if (full) {
          parts.push(`  💭 ${block.text}`);
        }
        break;
    }
  }

  return parts.join("\n");
}

// ── JSON formatting ─────────────────────────────────────────────────

export function formatResponseAsJson(response: CollectedResponse): string {
  return JSON.stringify({
    convId: response.convId,
    blocks: response.blocks,
    tokens: response.tokens,
    duration: response.duration,
  });
}

// ── Display entry formatting (for history command) ──────────────────

export function formatEntriesAsText(entries: DisplayEntry[], full: boolean): string {
  const parts: string[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        parts.push(`\x1b[1;34m▶ You\x1b[0m`);
        parts.push(entry.text);
        parts.push("");
        break;
      case "ai":
        parts.push(`\x1b[1;32m▶ Assistant\x1b[0m`);
        parts.push(formatBlocksAsText(entry.blocks, full));
        parts.push("");
        break;
      case "system":
        parts.push(`\x1b[1;33m▶ System\x1b[0m ${entry.text}`);
        parts.push("");
        break;
    }
  }

  return parts.join("\n").trimEnd();
}

export function formatEntriesAsJson(entries: DisplayEntry[]): string {
  return JSON.stringify(entries);
}
