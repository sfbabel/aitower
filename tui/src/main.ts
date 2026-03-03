/**
 * Exocortex TUI — terminal client for exocortexd.
 *
 * Connects to the daemon via Unix socket, displays a conversational UI,
 * and forwards user input. All AI, auth, and streaming logic lives in
 * the daemon — this is purely a presentation layer.
 *
 * Usage: bun run src/main.ts
 */

import { DaemonClient } from "./client";
import { parseKeys, type KeyEvent } from "./input";
import {
  render, enter_alt, leave_alt, hide_cursor, show_cursor, clear_screen,
  type RenderState, type DisplayMessage,
} from "./render";
import type { Event, ModelId } from "./protocol";

// ── State ───────────────────────────────────────────────────────────

const state: RenderState = {
  messages: [],
  streamingText: "",
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

let running = true;
let daemon: DaemonClient;
let pendingSendAfterCreate = false;
let pendingMessageText = "";
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let streamTimer: ReturnType<typeof setInterval> | null = null;

// ── Render scheduling ───────────────────────────────────────────────

function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
  }, 16); // ~60fps cap
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function handleEvent(event: Event): void {
  switch (event.type) {
    case "conversation_created": {
      state.convId = event.convId;
      state.model = event.model;

      // Subscribe to this conversation's streaming events
      daemon.subscribe(event.convId);

      // If we had a pending message, send it now
      // (the message was already added to state.messages by handleSubmit)
      if (pendingSendAfterCreate && pendingMessageText) {
        daemon.sendMessage(event.convId, pendingMessageText);
        pendingMessageText = "";
        pendingSendAfterCreate = false;
      }
      break;
    }

    case "streaming_started": {
      state.streaming = true;
      state.streamingText = "";
      state.streamStartedAt = event.startedAt;
      state.scrollOffset = 0; // auto-scroll to bottom

      // Periodic re-render to update elapsed time display
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = setInterval(scheduleRender, 1000);
      break;
    }

    case "text_chunk": {
      state.streamingText += event.text;
      state.scrollOffset = 0; // stay at bottom while streaming
      break;
    }

    case "thinking_chunk": {
      // For prototype, we don't display thinking — just ignore
      break;
    }

    case "message_complete": {
      state.messages.push({
        role: "assistant",
        text: event.text,
        durationMs: event.durationMs,
      });
      state.streamingText = "";
      break;
    }

    case "streaming_stopped": {
      state.streaming = false;
      state.streamingText = "";
      state.streamStartedAt = null;
      if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
      break;
    }

    case "error": {
      state.messages.push({
        role: "system",
        text: `✗ ${event.message}`,
      });
      break;
    }

    case "ack":
    case "pong":
      break;
  }

  scheduleRender();
}

// ── Input handling ──────────────────────────────────────────────────

function handleSubmit(): void {
  const text = state.inputBuffer.trim();
  if (!text) return;

  // Commands
  if (text === "/quit" || text === "/exit") {
    running = false;
    return;
  }

  if (text === "/new") {
    state.messages = [];
    state.convId = null;
    state.streaming = false;
    state.streamingText = "";
    state.inputBuffer = "";
    state.cursorPos = 0;
    state.scrollOffset = 0;
    scheduleRender();
    return;
  }

  if (text.startsWith("/model")) {
    const parts = text.split(/\s+/);
    if (parts[1] && ["sonnet", "haiku", "opus"].includes(parts[1])) {
      state.model = parts[1] as ModelId;
      state.messages.push({ role: "system", text: `Model set to ${state.model}` });
    } else {
      state.messages.push({ role: "system", text: `Current: ${state.model}. Available: sonnet, haiku, opus` });
    }
    state.inputBuffer = "";
    state.cursorPos = 0;
    scheduleRender();
    return;
  }

  // Regular message
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.scrollOffset = 0;

  if (state.streaming) {
    state.messages.push({ role: "system", text: "Still streaming — wait or press Escape to abort." });
    scheduleRender();
    return;
  }

  // If no conversation yet, create one first
  if (!state.convId) {
    pendingSendAfterCreate = true;
    pendingMessageText = text;
    state.messages.push({ role: "user", text });
    daemon.createConversation(state.model);
    scheduleRender();
    return;
  }

  // Send to daemon
  state.messages.push({ role: "user", text });
  daemon.sendMessage(state.convId, text);
  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  switch (key.type) {
    case "char": {
      if (!key.char) break;
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos) +
        key.char +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos++;
      break;
    }
    case "enter": {
      handleSubmit();
      break;
    }
    case "backspace": {
      if (state.cursorPos > 0) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos - 1) +
          state.inputBuffer.slice(state.cursorPos);
        state.cursorPos--;
      }
      break;
    }
    case "delete": {
      if (state.cursorPos < state.inputBuffer.length) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos) +
          state.inputBuffer.slice(state.cursorPos + 1);
      }
      break;
    }
    case "left": {
      if (state.cursorPos > 0) state.cursorPos--;
      break;
    }
    case "right": {
      if (state.cursorPos < state.inputBuffer.length) state.cursorPos++;
      break;
    }
    case "home": {
      state.cursorPos = 0;
      break;
    }
    case "end": {
      state.cursorPos = state.inputBuffer.length;
      break;
    }
    case "up": {
      // Scroll up
      const allLines = state.messages.length * 3; // rough estimate
      const maxScroll = Math.max(0, allLines - (state.rows - 5));
      state.scrollOffset = Math.min(state.scrollOffset + 3, maxScroll);
      break;
    }
    case "down": {
      state.scrollOffset = Math.max(0, state.scrollOffset - 3);
      break;
    }
    case "escape": {
      // Abort streaming
      if (state.streaming && state.convId) {
        daemon.abort(state.convId);
      }
      break;
    }
    case "ctrl-c":
    case "ctrl-d": {
      running = false;
      break;
    }
    default:
      return; // don't re-render for unknown keys
  }
  scheduleRender();
}

// ── Terminal setup ──────────────────────────────────────────────────

function setupTerminal(): void {
  process.stdout.write(enter_alt + hide_cursor);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdout.write(show_cursor + leave_alt);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Connect to daemon
  daemon = new DaemonClient(handleEvent);
  try {
    await daemon.connect();
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Handle daemon disconnection
  daemon.onConnectionLost(() => {
    state.streaming = false;
    state.messages.push({ role: "system", text: "⚠ Lost connection to daemon." });
    scheduleRender();
    setTimeout(() => { running = false; }, 2000);
  });

  // Set up terminal
  setupTerminal();

  // Handle resize
  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    scheduleRender();
  });

  // Initial render
  state.messages.push({
    role: "system",
    text: "Connected to exocortexd. Type a message to begin.",
  });
  render(state);

  // Input loop
  process.stdin.on("data", (data: Buffer) => {
    const keys = parseKeys(data);
    for (const key of keys) {
      handleKey(key);
      if (!running) break;
    }

    if (!running) {
      cleanup();
    }
  });
}

function cleanup(): void {
  if (streamTimer) clearInterval(streamTimer);
  daemon?.disconnect();
  restoreTerminal();
  process.exit(0);
}

// Handle cleanup on signals
process.on("exit", () => restoreTerminal());
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

main().catch((err) => {
  restoreTerminal();
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
