/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands, manages in-memory conversation state,
 * and drives the Anthropic streaming API.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import { streamMessage, type ApiMessage, type StreamResult, AuthError } from "./api";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command, ModelId, Event } from "./protocol";

// ── Conversation state ──────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  text: string;
}

interface Conversation {
  id: string;
  model: ModelId;
  messages: Message[];
  streaming: boolean;
  abortController: AbortController | null;
  createdAt: number;
}

const conversations = new Map<string, Conversation>();
const activeJobs = new Map<string, AbortController>();

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return [
    `You are an AI assistant. You are helpful, harmless, and honest.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      // ── ping ──────────────────────────────────────────────────
      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        break;
      }

      // ── new_conversation ──────────────────────────────────────
      case "new_conversation": {
        const id = generateId();
        const model = cmd.model ?? "sonnet";
        const conv: Conversation = {
          id, model, messages: [],
          streaming: false, abortController: null,
          createdAt: Date.now(),
        };
        conversations.set(id, conv);
        log("info", `handler: created conversation ${id} (model=${model})`);

        server.sendTo(client, {
          type: "conversation_created",
          reqId: cmd.reqId,
          convId: id,
          model,
        });
        break;
      }

      // ── subscribe / unsubscribe ───────────────────────────────
      case "subscribe": {
        server.subscribe(client, cmd.convId);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }
      case "unsubscribe": {
        server.unsubscribe(client, cmd.convId);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      // ── abort ─────────────────────────────────────────────────
      case "abort": {
        const ac = activeJobs.get(cmd.convId);
        if (ac) {
          ac.abort();
          log("info", `handler: abort requested for ${cmd.convId}`);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      // ── send_message ──────────────────────────────────────────
      case "send_message": {
        await handleSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text);
        break;
      }

      default: {
        server.sendTo(client, {
          type: "error",
          reqId: (cmd as any).reqId,
          message: `Unknown command: ${(cmd as any).type}`,
        });
      }
    }
  };
}

// ── Send message handler ────────────────────────────────────────────

async function handleSendMessage(
  server: DaemonServer,
  client: ConnectedClient,
  reqId: string | undefined,
  convId: string,
  text: string,
): Promise<void> {
  // Auth check
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Not authenticated. Run: bun run login (in daemon/)" });
    return;
  }

  // Find conversation
  const conv = conversations.get(convId);
  if (!conv) {
    server.sendTo(client, { type: "error", reqId, convId, message: `Conversation ${convId} not found` });
    return;
  }
  if (conv.streaming) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Already streaming" });
    return;
  }

  // Add user message
  conv.messages.push({ role: "user", text });

  // Set up abort
  const ac = new AbortController();
  activeJobs.set(convId, ac);
  conv.streaming = true;
  conv.abortController = ac;

  const startedAt = Date.now();
  server.broadcast({ type: "streaming_started", convId, model: conv.model, startedAt });

  // Build API messages
  const apiMessages: ApiMessage[] = conv.messages.map((m) => ({
    role: m.role,
    content: m.text,
  }));

  let fullText = "";

  try {
    const result = await streamMessage(
      apiMessages,
      conv.model,
      // onText
      (chunk) => {
        fullText += chunk;
        server.sendToSubscribers(convId, { type: "text_chunk", convId, text: chunk });
      },
      // onThinking
      (chunk) => {
        server.sendToSubscribers(convId, { type: "thinking_chunk", convId, text: chunk });
      },
      buildSystemPrompt(),
      ac.signal,
    );

    // Store assistant message
    conv.messages.push({ role: "assistant", text: result.text });

    const durationMs = Date.now() - startedAt;
    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      text: result.text,
      model: conv.model,
      tokens: result.outputTokens,
      durationMs,
    });

    log("info", `handler: message complete for ${convId} (${result.outputTokens ?? "?"} tokens, ${durationMs}ms)`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `handler: stream error for ${convId}: ${msg}`);

    // If we got partial text, save it
    if (fullText) {
      conv.messages.push({ role: "assistant", text: fullText + "\n[interrupted]" });
    }

    server.sendToSubscribers(convId, { type: "error", convId, message: msg });
  } finally {
    activeJobs.delete(convId);
    conv.streaming = false;
    conv.abortController = null;
    server.broadcast({ type: "streaming_stopped", convId });
  }
}
