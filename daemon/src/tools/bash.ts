/**
 * Bash tool — execute shell commands.
 */

import { spawn } from "child_process";
import type { Tool, ToolResult, ToolSummary } from "./types";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour
const MAX_OUTPUT_BYTES = 1_000_000;   // 1MB truncation limit

// ── Execution ──────────────────────────────────────────────────────

async function executeBash(input: Record<string, unknown>): Promise<ToolResult> {
  const command = input.command as string;
  if (!command) return { output: "Error: missing 'command' parameter", isError: true };

  const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    function collect(data: Buffer): void {
      if (truncated) return;
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        chunks.push(data.subarray(0, MAX_OUTPUT_BYTES - (totalBytes - data.length)));
      } else {
        chunks.push(data);
      }
    }

    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);

    proc.on("error", (err) => {
      resolve({ output: `Error: ${err.message}`, isError: true });
    });

    proc.on("close", (code) => {
      let output = Buffer.concat(chunks).toString("utf8");
      if (truncated) output += "\n... (output truncated)";
      if (code !== 0 && code !== null) {
        output += `\n(exit code ${code})`;
      }
      resolve({ output, isError: code !== 0 && code !== null });
    });
  });
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const command = (input.command as string) ?? "";
  return { label: "$", detail: command.slice(0, 200) };
}

// ── Tool definition ────────────────────────────────────────────────

export const bash: Tool = {
  name: "bash",
  description: "Execute a bash command. Returns stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 3600000)" },
    },
    required: ["command"],
  },
  systemHint: undefined,
  display: {
    label: "$",
    color: "#d19a66",  // muted amber
  },
  summarize,
  execute: executeBash,
};
