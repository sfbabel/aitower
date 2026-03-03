/**
 * TUI state model.
 *
 * Defines the message types (user, assistant, system) and the
 * block-based structure of AI messages. The renderer and event
 * handler both operate on these types.
 */

import type { ModelId, Block } from "./protocol";

// ── Message types ───────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  model?: ModelId;
  tokens?: number;
  durationMs?: number;
}

export interface SystemMessage {
  role: "system";
  text: string;
}

export type Message = UserMessage | AIMessage | SystemMessage;

// ── Render state ────────────────────────────────────────────────────

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  streaming: boolean;
  streamStartedAt: number | null;
  model: ModelId;
  convId: string | null;
  inputBuffer: string;
  cursorPos: number;
  cols: number;
  rows: number;
  scrollOffset: number;
}

export function createInitialState(): RenderState {
  return {
    messages: [],
    pendingAI: null,
    streaming: false,
    streamStartedAt: null,
    model: "sonnet",
    convId: null,
    inputBuffer: "",
    cursorPos: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
  };
}
