#!/usr/bin/env bun
/**
 * Import Claude Code conversations into aitower.
 *
 * Reads JSONL conversation files from Claude Code's data directory
 * and converts them into aitower v9 conversation JSON files.
 *
 * Usage:
 *   bun run scripts/import-claude-code.ts [--all | --file <path.jsonl> | --dir <dir>]
 *   bun run scripts/import-claude-code.ts --all          Import all conversations from all projects
 *   bun run scripts/import-claude-code.ts --file foo.jsonl Import a single file
 *   bun run scripts/import-claude-code.ts --dir <dir>     Import all .jsonl from a directory
 *   bun run scripts/import-claude-code.ts --list          List available conversations
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ── aitower types (simplified for the importer) ───────────────────

interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  metadata: MessageMetadata | null;
}

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface MessageMetadata {
  startedAt: number;
  endedAt: number | null;
  model: string;
  tokens: number;
}

interface ConversationFile {
  version: 9;
  id: string;
  model: "sonnet" | "haiku" | "opus";
  effort: "high";
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  title: string;
}

// ── Claude Code types ───────────────────────────────────────────────

interface ClaudeCodeEntry {
  type: string;
  parentUuid?: string | null;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role: string;
    model?: string;
    content: string | ClaudeCodeBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
}

interface ClaudeCodeBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown[];
  is_error?: boolean;
}

// ── Paths ───────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const EXOCORTEX_CONV_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "aitower",
  "conversations",
);

// ── Model mapping ───────────────────────────────────────────────────

function mapModel(raw: string | undefined): "sonnet" | "haiku" | "opus" {
  if (!raw) return "sonnet";
  if (raw.includes("opus")) return "opus";
  if (raw.includes("haiku")) return "haiku";
  return "sonnet";
}

// ── Convert a single JSONL file ─────────────────────────────────────

function convertJsonl(filePath: string): ConversationFile | null {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(l => l.trim());

  // Parse all entries
  const entries: ClaudeCodeEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Filter to actual messages (not file-history-snapshot, last-prompt, etc.)
  const messageEntries = entries.filter(
    e => (e.type === "user" || e.type === "assistant") && e.message && !e.isSidechain
  );

  if (messageEntries.length === 0) return null;

  // Build aitower messages
  const messages: StoredMessage[] = [];
  let firstModel = "sonnet";
  let firstTimestamp = Date.now();
  let lastTimestamp = Date.now();
  let detectedModel: string | undefined;

  for (const entry of messageEntries) {
    const msg = entry.message!;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

    if (messages.length === 0) firstTimestamp = ts;
    lastTimestamp = ts;

    // Detect model from first non-synthetic assistant message
    if (msg.role === "assistant" && msg.model && msg.model !== "<synthetic>" && !detectedModel) {
      detectedModel = msg.model;
      firstModel = mapModel(msg.model);
    }

    // Skip API error messages
    if ((entry as any).isApiErrorMessage) continue;

    const metadata: MessageMetadata = {
      startedAt: ts,
      endedAt: ts,
      model: mapModel(msg.model) || firstModel,
      tokens: msg.usage?.output_tokens ?? 0,
    };

    if (msg.role === "user") {
      // User messages: can be plain string or array with tool_result blocks
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: msg.content,
          metadata,
        });
      } else if (Array.isArray(msg.content)) {
        // Check if it's a tool_result container
        const hasToolResult = msg.content.some((b: any) => b.type === "tool_result");
        if (hasToolResult) {
          // Convert tool results to aitower format
          const blocks: ContentBlock[] = msg.content.map((b: any) => {
            if (b.type === "tool_result") {
              return {
                type: "tool_result",
                tool_use_id: b.tool_use_id || "",
                content: typeof b.content === "string" ? b.content :
                  Array.isArray(b.content) ? b.content.map((c: any) =>
                    typeof c === "string" ? c : c.text || JSON.stringify(c)
                  ).join("\n") : "",
                is_error: b.is_error || false,
              };
            }
            return b;
          });
          messages.push({ role: "user", content: blocks, metadata });
        } else {
          // Regular user message with content blocks (extract text)
          const text = msg.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
          messages.push({
            role: "user",
            content: text || "(empty)",
            metadata,
          });
        }
      }
    } else if (msg.role === "assistant") {
      // Assistant messages: array of content blocks
      if (!Array.isArray(msg.content)) continue;

      const blocks: ContentBlock[] = [];
      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            if (block.text) {
              blocks.push({ type: "text", text: block.text });
            }
            break;
          case "thinking":
            if (block.thinking) {
              blocks.push({
                type: "thinking",
                thinking: block.thinking,
                signature: block.signature || "",
              });
            }
            break;
          case "tool_use":
            blocks.push({
              type: "tool_use",
              id: block.id || `tool_${Date.now()}`,
              name: block.name || "unknown",
              input: block.input || {},
            });
            break;
          default:
            // Preserve unknown block types
            blocks.push(block as ContentBlock);
        }
      }

      if (blocks.length > 0) {
        messages.push({ role: "assistant", content: blocks, metadata });
      }
    }
  }

  if (messages.length === 0) return null;

  // Merge consecutive same-role assistant messages (Claude Code splits them)
  const merged: StoredMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.role === "assistant" &&
      msg.role === "assistant" &&
      Array.isArray(prev.content) &&
      Array.isArray(msg.content)
    ) {
      // Merge blocks into previous message
      (prev.content as ContentBlock[]).push(...(msg.content as ContentBlock[]));
      // Update end time
      if (prev.metadata && msg.metadata) {
        prev.metadata.endedAt = msg.metadata.endedAt;
        prev.metadata.tokens += msg.metadata.tokens;
      }
    } else {
      merged.push(msg);
    }
  }

  // Generate conversation ID from session ID or filename
  const sessionId = messageEntries[0]?.sessionId;
  const convId = sessionId
    ? `cc-${sessionId.slice(0, 8)}`
    : `cc-${basename(filePath, ".jsonl").slice(0, 8)}`;

  // Extract title from first user message
  let title = "";
  const firstUser = merged.find(m => m.role === "user");
  if (firstUser) {
    const text = typeof firstUser.content === "string"
      ? firstUser.content
      : "";
    title = text.split("\n")[0].slice(0, 80) || "Imported from Claude Code";
  }

  return {
    version: 9,
    id: convId,
    model: firstModel as "sonnet" | "haiku" | "opus",
    effort: "high",
    messages: merged,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: -firstTimestamp,
    title: `[CC] ${title}`,
  };
}

// ── Find all JSONL files ────────────────────────────────────────────

function findAllJsonlFiles(): string[] {
  const files: string[] = [];
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return files;

  for (const project of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, project);
    try {
      const stat = statSync(projectDir);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    for (const file of readdirSync(projectDir)) {
      if (file.endsWith(".jsonl")) {
        files.push(join(projectDir, file));
      }
    }
  }

  return files;
}

// ── Save converted conversation ─────────────────────────────────────

function saveConversation(conv: ConversationFile): void {
  mkdirSync(EXOCORTEX_CONV_DIR, { recursive: true });
  const dest = join(EXOCORTEX_CONV_DIR, `${conv.id}.json`);

  if (existsSync(dest)) {
    console.log(`  ⊘ Skipping ${conv.id} — already exists`);
    return;
  }

  writeFileSync(dest, JSON.stringify(conv, null, 2));
  console.log(`  ✓ ${conv.id} — ${conv.messages.length} messages — "${conv.title}"`);
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Import Claude Code conversations into aitower.

Usage:
  bun run scripts/import-claude-code.ts --all              Import all conversations
  bun run scripts/import-claude-code.ts --file <path.jsonl> Import a single file
  bun run scripts/import-claude-code.ts --dir <dir>         Import all .jsonl from a directory
  bun run scripts/import-claude-code.ts --list              List available conversations
`);
    return;
  }

  if (args.includes("--list")) {
    const files = findAllJsonlFiles();
    if (files.length === 0) {
      console.log("No Claude Code conversations found.");
      return;
    }
    console.log(`Found ${files.length} Claude Code conversations:\n`);
    for (const file of files) {
      const project = basename(join(file, ".."));
      const name = basename(file, ".jsonl");
      console.log(`  ${project}/${name}`);
    }
    return;
  }

  let files: string[] = [];

  if (args.includes("--all")) {
    files = findAllJsonlFiles();
  } else if (args.includes("--file")) {
    const idx = args.indexOf("--file");
    const path = args[idx + 1];
    if (!path || !existsSync(path)) {
      console.error("File not found:", path);
      process.exit(1);
    }
    files = [path];
  } else if (args.includes("--dir")) {
    const idx = args.indexOf("--dir");
    const dir = args[idx + 1];
    if (!dir || !existsSync(dir)) {
      console.error("Directory not found:", dir);
      process.exit(1);
    }
    files = readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => join(dir, f));
  } else {
    // Default: import all
    files = findAllJsonlFiles();
  }

  if (files.length === 0) {
    console.log("No Claude Code conversations found.");
    console.log(`Searched: ${CLAUDE_PROJECTS_DIR}`);
    return;
  }

  console.log(`Importing ${files.length} conversations...\n`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const conv = convertJsonl(file);
      if (!conv) {
        skipped++;
        continue;
      }
      saveConversation(conv);
      imported++;
    } catch (err) {
      console.error(`  ✗ Failed: ${basename(file)} — ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped (empty), ${failed} failed.`);

  if (imported > 0) {
    console.log("\nRestart the aitower daemon to load imported conversations:");
    console.log("  systemctl --user restart aitower-daemon");
  }
}

main();
