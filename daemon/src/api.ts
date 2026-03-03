/**
 * Anthropic Messages API streaming client.
 *
 * Handles SSE parsing, auth token management, and retry logic.
 * This is the sole point of contact with the Anthropic API.
 */

import { loadAuth, isTokenExpired, saveAuth } from "./store";
import { refreshTokens, AuthError } from "./auth";
import { log } from "./log";
import type { ModelId, MODEL_MAP } from "./protocol";

// Re-export for handler use
export { AuthError };

// ── Config ──────────────────────────────────────────────────────────

const BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const BETA_BASE = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27";
const BETA_ADAPTIVE = `${BETA_BASE},adaptive-thinking-2026-01-28`;
const STREAM_STALL_TIMEOUT = 120_000;

const MODEL_IDS: Record<ModelId, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  opus:   "claude-opus-4-6",
};

// ── Types ───────────────────────────────────────────────────────────

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

export type ApiContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface StreamResult {
  text: string;
  thinking: string;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class OverloadError extends Error {
  constructor(message: string) { super(message); this.name = "OverloadError"; }
}

// ── Token management ────────────────────────────────────────────────

export async function getAccessToken(): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) throw new Error("Not authenticated");

  if (isTokenExpired(auth.tokens)) {
    if (!auth.tokens.refreshToken) throw new Error("Token expired, no refresh token");
    log("info", "api: token expired, refreshing");
    const newTokens = await refreshTokens(auth.tokens.refreshToken);
    saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
    return newTokens.accessToken;
  }

  return auth.tokens.accessToken;
}

async function forceRefreshToken(failedToken: string): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.refreshToken) throw new Error("No refresh token");
  if (auth.tokens.accessToken !== failedToken) return auth.tokens.accessToken;
  const newTokens = await refreshTokens(auth.tokens.refreshToken);
  saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
  return newTokens.accessToken;
}

// ── Request building ────────────────────────────────────────────────

function supportsAdaptive(model: ModelId): boolean {
  return model === "sonnet" || model === "opus";
}

function buildRequest(
  accessToken: string, messages: ApiMessage[], model: ModelId,
  maxTokens: number, system?: string,
) {
  const adaptive = supportsAdaptive(model);
  const thinking = adaptive
    ? { type: "adaptive" }
    : { type: "enabled", budget_tokens: 10000 };

  const body: Record<string, unknown> = {
    model: MODEL_IDS[model], messages, max_tokens: maxTokens,
    thinking, stream: true,
  };
  if (system) {
    body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }

  return {
    url: `${BASE_URL}/v1/messages?beta=true`,
    init: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": adaptive ? BETA_ADAPTIVE : BETA_BASE,
        "Content-Type": "application/json",
        "User-Agent": "exocortex/0.1.0",
        "x-app": "cli",
      },
      body: JSON.stringify(body),
    } satisfies RequestInit,
  };
}

// ── SSE stream parser ───────────────────────────────────────────────

interface StreamCallbacks {
  onText: (chunk: string) => void;
  onThinking: (chunk: string) => void;
}

async function readStream(res: Response, cb: StreamCallbacks): Promise<StreamResult> {
  if (!res.body) throw new Error("No response body");

  let fullText = "";
  let fullThinking = "";
  let stopReason = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  // Track content block types by index
  const blockTypes = new Map<number, "text" | "thinking" | "tool_use">();

  const processEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "content_block_start": {
        const idx = event.index as number;
        const cb = event.content_block as Record<string, unknown>;
        blockTypes.set(idx, cb.type as "text" | "thinking" | "tool_use");
        break;
      }
      case "content_block_delta": {
        const idx = event.index as number;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.type === "text_delta") {
          fullText += delta.text;
          cb.onText(delta.text);
        } else if (delta?.type === "thinking_delta") {
          fullThinking += delta.thinking;
          cb.onThinking(delta.thinking);
        }
        break;
      }
      case "message_start": {
        const msg = event.message as Record<string, Record<string, number>> | undefined;
        if (msg?.usage?.input_tokens != null) inputTokens = msg.usage.input_tokens;
        break;
      }
      case "message_delta": {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
        const delta = event.delta as Record<string, string> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        break;
      }
      case "error": {
        const err = event.error as Record<string, string> | undefined;
        const msg = `Stream error (${err?.type ?? "unknown"}): ${err?.message ?? ""}`;
        if (err?.type === "overloaded_error") throw new OverloadError(msg);
        throw new Error(msg);
      }
    }
  };

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        processEvent(JSON.parse(data));
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new Error(`Stream stalled: no data for ${STREAM_STALL_TIMEOUT / 1000}s`)),
          STREAM_STALL_TIMEOUT,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    processLines(lines);
  }

  // Flush remaining
  buffer += decoder.decode();
  if (buffer.trim()) processLines(buffer.split("\n"));

  return { text: fullText, thinking: fullThinking, stopReason, inputTokens, outputTokens };
}

// ── Public: stream a message ────────────────────────────────────────

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  onText: (chunk: string) => void,
  onThinking: (chunk: string) => void,
  system?: string,
  signal?: AbortSignal,
  maxTokens = 32000,
): Promise<StreamResult> {
  let accessToken = await getAccessToken();
  let authRetried = false;
  let overloadAttempt = 0;

  while (true) {
    const { url, init } = buildRequest(accessToken, messages, model, maxTokens, system);
    const res = await fetch(url, { ...init, signal });

    // Auth errors → refresh once
    if (!authRetried && (res.status === 401 || (res.status === 403 && (await res.clone().text()).includes("revoked")))) {
      log("warn", `api: ${res.status}, refreshing token`);
      accessToken = await forceRefreshToken(accessToken);
      authRetried = true;
      continue;
    }

    // Retryable errors → backoff
    if (res.status === 429 || res.status === 529 || res.status === 503) {
      if (overloadAttempt < 5) {
        const delay = Math.min(1000 * Math.pow(2, overloadAttempt), 30000) + Math.random() * 1000;
        log("warn", `api: ${res.status}, retry ${overloadAttempt + 1}/5 in ${Math.round(delay / 1000)}s`);
        await new Promise((r) => setTimeout(r, delay));
        overloadAttempt++;
        continue;
      }
      const text = await res.text();
      throw new OverloadError(`API error (${res.status}) after 5 retries: ${text.slice(0, 200)}`);
    }

    // Non-retryable errors
    if (!res.ok) {
      const text = await res.text();
      log("error", `api: error (${res.status}): ${text.slice(0, 500)}`);
      throw new Error(`API error (${res.status}): ${text}`);
    }

    // Stream the response
    return readStream(res, { onText, onThinking });
  }
}
