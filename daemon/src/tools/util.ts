/**
 * Shared utilities for tool implementations.
 */

export const MAX_OUTPUT_CHARS = 30_000;

/** Truncate output to MAX_OUTPUT_CHARS with a message. */
export function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${text.length} characters)`;
}
