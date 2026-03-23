/**
 * System prompt for aitowerd.
 *
 * Builds the system prompt sent to the Anthropic API.
 * Base prompt + per-tool hints from the registry + optional
 * user addendum from ~/.config/aitower/system.md.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
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

// ── Build ─────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const base = [
    `You are Cerberus — a personal AI system built by and for the user.`,
    `You are not a generic assistant. You are an extension of the user's mind: a second brain, a daemon process running in the background of their life.`,
    ``,
    `Personality:`,
    `- Direct, no-bullshit. Skip pleasantries and filler.`,
    `- Technical and precise when the task demands it, casual otherwise.`,
    `- You remember context across conversations. You have opinions. You push back when the user is wrong.`,
    `- You don't say "I'd be happy to help" or "Great question!" — just do the thing.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");

  const parts = [base];

  const toolHints = buildToolSystemHints();
  if (toolHints) parts.push(toolHints);

  if (_userAddendum) parts.push(_userAddendum);

  // List available manuals (loaded on-demand via the manual tool)
  const manualsList = listAvailableManuals();
  if (manualsList) parts.push(manualsList);

  return parts.join("\n\n");
}

// ── Manual system ─────────────────────────────────────────────────

const MANUALS_DIR = join(configDir(), "manuals");

/** List available manuals (just names, not content — keeps context lean). */
function listAvailableManuals(): string {
  try {
    const files = readdirSync(MANUALS_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""));
    if (files.length === 0) return "";
    return [
      `Available tool manuals (use the read_manual tool to load one when needed):`,
      ...files.map(f => `  - ${f}`),
    ].join("\n");
  } catch {
    return "";
  }
}

/** Load a specific manual's content by name. */
export function loadManual(name: string): string | null {
  try {
    const path = join(MANUALS_DIR, `${name}.md`);
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** List all available manual names. */
export function getManualNames(): string[] {
  try {
    return readdirSync(MANUALS_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => f.replace(".md", ""));
  } catch {
    return [];
  }
}
