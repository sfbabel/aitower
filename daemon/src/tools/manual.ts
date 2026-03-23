/**
 * Manual tool — loads tool/service manuals on demand.
 *
 * Manuals live as .md files in ~/.config/aitower/manuals/.
 * Only loaded when the AI needs them, keeping the default
 * system prompt lean.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { loadManual, getManualNames } from "../system";

export const manual: Tool = {
  name: "read_manual",

  description:
    "Load a tool/service manual by name. Use this when the user asks about " +
    "how to use a specific tool or service (e.g., Discord, Outlook, Git). " +
    "Returns the manual content. Call with no name to list available manuals.",

  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the manual to load (e.g., 'discord', 'outlook', 'git'). Omit to list available manuals.",
      },
    },
    required: [],
  },

  display: {
    label: "Manual",
    color: "#F08020",  // amber to match theme
  },

  summarize(input: Record<string, unknown>): ToolSummary {
    const name = input.name as string | undefined;
    if (name) {
      return { label: "Manual", detail: name };
    }
    return { label: "Manual", detail: "list" };
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const name = input.name as string | undefined;

    if (!name) {
      const names = getManualNames();
      if (names.length === 0) {
        return { output: "No manuals available. Add .md files to ~/.config/aitower/manuals/", isError: false };
      }
      return { output: `Available manuals:\n${names.map(n => `  - ${n}`).join("\n")}`, isError: false };
    }

    const content = loadManual(name);
    if (!content) {
      const available = getManualNames();
      return {
        output: `Manual "${name}" not found. Available: ${available.join(", ") || "none"}`,
        isError: true,
      };
    }

    return { output: content, isError: false };
  },
};
