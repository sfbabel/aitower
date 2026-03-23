/**
 * System prompt for aitowerd.
 *
 * Builds the system prompt sent to the Anthropic API.
 * Base prompt + per-tool hints from the registry + optional
 * user addendum from the config root (system.md).
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
import { getExternalToolHints } from "./external-tools";
import { configDir } from "@aitower/shared/paths";

// ── User system prompt addendum ───────────────────────────────────

let _userAddendum: string = "";

function loadUserAddendum(): void {
  try {
    _userAddendum = readFileSync(join(configDir(), "system.md"), "utf8").trim();
  } catch {
    _userAddendum = "";
  }
}
loadUserAddendum();

// ── Manuals ──────────────────────────────────────────────────────

const MANUALS_DIR = join(configDir(), "manuals");

export function loadManual(name: string): string | null {
  try {
    const path = join(MANUALS_DIR, `${name}.md`);
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function getManualNames(): string[] {
  try {
    return readdirSync(MANUALS_DIR)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// ── Build ─────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const base = [
    `You are Exo, the user's assistant.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");

  const parts = [base];

  const toolHints = buildToolSystemHints();
  if (toolHints) parts.push(toolHints);

  const externalHints = getExternalToolHints();
  if (externalHints) parts.push("# External tools\n" + externalHints);

  if (_userAddendum) parts.push(_userAddendum);

  return parts.join("\n\n");
}
