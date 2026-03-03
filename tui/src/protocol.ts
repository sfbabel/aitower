/**
 * IPC protocol for exocortexd ↔ client communication.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 *
 * NOTE: This is an independent copy of the daemon's protocol.ts.
 * Both packages must stay in sync.
 */

// ── Models ──────────────────────────────────────────────────────────

export type ModelId = "sonnet" | "haiku" | "opus";

export const MODEL_MAP: Record<ModelId, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  opus:   "claude-opus-4-6",
};

// ── Commands (client → daemon) ──────────────────────────────────────

export interface PingCommand {
  type: "ping";
  reqId?: string;
}

export interface NewConversationCommand {
  type: "new_conversation";
  reqId?: string;
  model?: ModelId;
}

export interface SendMessageCommand {
  type: "send_message";
  reqId?: string;
  convId: string;
  text: string;
}

export interface AbortCommand {
  type: "abort";
  reqId?: string;
  convId: string;
}

export interface SubscribeCommand {
  type: "subscribe";
  reqId?: string;
  convId: string;
}

export interface UnsubscribeCommand {
  type: "unsubscribe";
  reqId?: string;
  convId: string;
}

export type Command =
  | PingCommand
  | NewConversationCommand
  | SendMessageCommand
  | AbortCommand
  | SubscribeCommand
  | UnsubscribeCommand;

// ── Events (daemon → client) ────────────────────────────────────────

export interface PongEvent {
  type: "pong";
  reqId?: string;
}

export interface AckEvent {
  type: "ack";
  reqId?: string;
  convId?: string;
}

export interface ConversationCreatedEvent {
  type: "conversation_created";
  reqId?: string;
  convId: string;
  model: ModelId;
}

export interface StreamingStartedEvent {
  type: "streaming_started";
  convId: string;
  model: ModelId;
  startedAt: number;
}

export interface StreamingStoppedEvent {
  type: "streaming_stopped";
  convId: string;
}

export interface TextChunkEvent {
  type: "text_chunk";
  convId: string;
  text: string;
}

export interface ThinkingChunkEvent {
  type: "thinking_chunk";
  convId: string;
  text: string;
}

export interface MessageCompleteEvent {
  type: "message_complete";
  convId: string;
  text: string;
  model: ModelId;
  tokens?: number;
  durationMs?: number;
}

export interface ErrorEvent {
  type: "error";
  reqId?: string;
  convId?: string;
  message: string;
}

export type Event =
  | PongEvent
  | AckEvent
  | ConversationCreatedEvent
  | StreamingStartedEvent
  | StreamingStoppedEvent
  | TextChunkEvent
  | ThinkingChunkEvent
  | MessageCompleteEvent
  | ErrorEvent;
