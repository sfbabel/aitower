#!/usr/bin/env bun
/**
 * exo — Exocortex CLI client.
 *
 * A stateless, machine-friendly interface to exocortexd.
 * Each invocation connects, does its work, and disconnects.
 * The daemon holds all state; conversation IDs are the handles.
 *
 * Usage:
 *   exo "question"                  Send a message (new conversation)
 *   exo "follow up" -c <id>         Continue a conversation
 *   exo ls                          List conversations
 *   exo info <id>                   Show conversation metadata
 *   exo history <id>                Show conversation history
 *   exo rm <id>                     Delete a conversation
 *   exo abort <id>                  Abort in-flight stream
 *   exo rename <id> <title>         Rename a conversation
 *   exo llm "text" --system "..."   One-shot LLM completion
 *
 * Flags:
 *   --opus, --sonnet, --haiku       Model selection
 *   -c, --conv <id>                 Conversation ID
 *   --json                          JSON output
 *   --full                          Include thinking + tool results
 *   --stream                        Stream events as NDJSON
 *   --id                            Print only conversation ID
 *   --timeout <sec>                 Max wait time (default 300)
 *   --system <prompt>               System prompt (for llm command)
 */

import { Connection } from "./conn";
import { send, ls, info, history, rm, abort, rename, llm, type OutputOptions } from "./commands";
import type { ModelId } from "@exocortex/shared/protocol";

// ── Arg parsing ─────────────────────────────────────────────────────

const SUBCOMMANDS = new Set(["ls", "info", "history", "rm", "abort", "rename", "llm", "help"]);

interface ParsedArgs {
  subcommand: string | null;
  positionals: string[];
  conv: string | null;
  model: ModelId | null;
  system: string;
  json: boolean;
  full: boolean;
  stream: boolean;
  idOnly: boolean;
  timeout: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    positionals: [],
    conv: null,
    model: null,
    system: "You are a helpful assistant.",
    json: false,
    full: false,
    stream: false,
    idOnly: false,
    timeout: 300_000,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // Flags
    if (arg === "--opus") { result.model = "opus"; i++; continue; }
    if (arg === "--sonnet") { result.model = "sonnet"; i++; continue; }
    if (arg === "--haiku") { result.model = "haiku"; i++; continue; }
    if (arg === "--json") { result.json = true; i++; continue; }
    if (arg === "--full") { result.full = true; i++; continue; }
    if (arg === "--stream") { result.stream = true; i++; continue; }
    if (arg === "--id") { result.idOnly = true; i++; continue; }
    if ((arg === "-c" || arg === "--conv") && i + 1 < argv.length) {
      result.conv = argv[++i]; i++; continue;
    }
    if (arg === "--system" && i + 1 < argv.length) {
      result.system = argv[++i]; i++; continue;
    }
    if (arg === "--timeout" && i + 1 < argv.length) {
      result.timeout = parseInt(argv[++i], 10) * 1000; i++; continue;
    }
    if (arg === "-h" || arg === "--help") {
      result.subcommand = "help"; i++; continue;
    }

    // Positionals
    result.positionals.push(arg);
    i++;
  }

  // Detect subcommand: first positional if it's a known command
  if (result.positionals.length > 0 && SUBCOMMANDS.has(result.positionals[0])) {
    result.subcommand = result.positionals.shift()!;
  }

  return result;
}

// ── Help ────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(`\x1b[1mexo\x1b[0m — Exocortex CLI client

\x1b[1mUSAGE\x1b[0m
  exo "message"                     Send a message (new conversation)
  exo "message" -c <id>             Continue a conversation
  exo "message" --opus              Use a specific model
  cat file | exo -                  Read message from stdin

\x1b[1mCOMMANDS\x1b[0m
  ls                                List conversations
  info <id>                         Conversation metadata
  history <id>                      Conversation history
  rm <id>                           Delete a conversation
  abort <id>                        Abort in-flight stream
  rename <id> <title>               Rename a conversation
  llm "text" --system "prompt"      One-shot LLM (no conversation)
  help                              Show this help

\x1b[1mFLAGS\x1b[0m
  --opus, --sonnet, --haiku         Model selection
  -c, --conv <id>                   Conversation ID
  --json                            Structured JSON output
  --full                            Include thinking + tool results
  --stream                          Stream events as NDJSON
  --id                              Print only conversation ID
  --timeout <sec>                   Max wait time (default 300)
  --system <prompt>                 System prompt (for llm)
`);
}

// ── Stdin reading ───────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.subcommand === "help" || (args.positionals.length === 0 && !args.subcommand)) {
    printHelp();
    return 0;
  }

  const opts: OutputOptions = {
    json: args.json,
    full: args.full,
    stream: args.stream,
    idOnly: args.idOnly,
    timeout: args.timeout,
  };

  const conn = new Connection();

  try {
    await conn.connect();
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 2;
  }

  try {
    switch (args.subcommand) {
      case "ls":
        return await ls(conn, opts);

      case "info": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo info <convId>\n"); return 1; }
        return await info(conn, convId, opts);
      }

      case "history": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo history <convId>\n"); return 1; }
        return await history(conn, convId, opts);
      }

      case "rm": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo rm <convId>\n"); return 1; }
        return await rm(conn, convId);
      }

      case "abort": {
        const convId = args.positionals[0];
        if (!convId) { process.stderr.write("Usage: exo abort <convId>\n"); return 1; }
        return await abort(conn, convId);
      }

      case "rename": {
        const convId = args.positionals[0];
        const title = args.positionals.slice(1).join(" ");
        if (!convId || !title) { process.stderr.write("Usage: exo rename <convId> <title>\n"); return 1; }
        return await rename(conn, convId, title);
      }

      case "llm": {
        const text = args.positionals[0] === "-"
          ? await readStdin()
          : args.positionals.join(" ");
        if (!text) { process.stderr.write("Usage: exo llm \"text\" --system \"prompt\"\n"); return 1; }
        return await llm(conn, text, args.system, args.model, opts);
      }

      default: {
        // No subcommand → send message
        let text: string;
        if (args.positionals.length === 1 && args.positionals[0] === "-") {
          text = await readStdin();
        } else {
          text = args.positionals.join(" ");
        }
        if (!text) { printHelp(); return 0; }
        return await send(conn, text, args.conv, args.model, opts);
      }
    }
  } catch (err: any) {
    process.stderr.write(`Error: ${err.message}\n`);
    return 1;
  } finally {
    conn.disconnect();
  }
}

main().then((code) => process.exit(code));
