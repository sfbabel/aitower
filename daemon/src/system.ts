/**
 * System prompt for exocortexd.
 *
 * Builds the system prompt sent to the Anthropic API.
 * Base prompt + per-tool hints composed from the registry.
 */

import { buildToolSystemHints } from "./tools/registry";

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const base = [
    `You are Mnemo, the user's assistant.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");

  const toolHints = buildToolSystemHints();
  return toolHints ? `${base}\n\n${toolHints}` : base;
}
