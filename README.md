# Exocortex

A daemon-driven AI assistant with a clean client/server architecture.

```
┌─────────────┐         Unix Socket         ┌──────────────┐
│             │    (JSON-lines protocol)     │              │
│  exocortex  │◄───────────────────────────►│  exocortexd  │
│    (TUI)    │   Commands ──►              │   (daemon)   │
│             │          ◄── Events          │              │
└─────────────┘                              └──────┬───────┘
  Presentation                                      │
  layer only                                        │  Anthropic
                                                    │  Messages API
                                                    ▼
                                              ┌──────────┐
                                              │  Claude   │
                                              └──────────┘
```

## Architecture

**Two completely separate packages:**

- **`daemon/`** — The backend. Owns everything: auth, API calls, streaming,
  conversation state, tool execution. Runs as a persistent background process
  exposing a Unix socket.

- **`tui/`** — The frontend. A terminal UI that connects to the daemon and
  renders the conversation. Pure presentation — no AI logic.

The protocol between them is newline-delimited JSON over a Unix domain socket.
Commands flow client → daemon. Events flow daemon → client.

## Quick Start

```bash
# 1. Install dependencies
cd daemon && bun install
cd ../tui && bun install

# 2. Authenticate (if not already logged in via Mnemo)
cd ../daemon && bun run login

# 3. Start the daemon
bun run start

# 4. In another terminal, start the TUI
cd ../tui && bun run start
```

## Usage

| Key / Command  | Action                              |
|----------------|-------------------------------------|
| `Enter`        | Send message                        |
| `Escape`       | Abort current stream                |
| `↑` / `↓`     | Scroll message history              |
| `Ctrl+C`       | Quit                                |
| `/new`         | Start a new conversation            |
| `/model <m>`   | Switch model (sonnet, haiku, opus)  |
| `/quit`        | Exit                                |

## Protocol

See `daemon/src/protocol.ts` (or `tui/src/protocol.ts`).

**Commands** (client → daemon):
- `ping` → `pong`
- `new_conversation` → `conversation_created`
- `send_message` → streaming events → `message_complete`
- `subscribe` / `unsubscribe` → `ack`
- `abort` → `ack`

**Events** (daemon → client):
- `streaming_started` / `streaming_stopped` — broadcast to all clients
- `text_chunk` / `thinking_chunk` — sent to subscribers only
- `message_complete` — sent to subscribers
- `error` — sent to relevant client(s)

## File Structure

```
daemon/
├── src/
│   ├── main.ts        Entry point (start daemon or login)
│   ├── protocol.ts    IPC type definitions
│   ├── server.ts      Unix socket server
│   ├── handler.ts     Command routing + conversation state
│   ├── api.ts         Anthropic Messages API streaming
│   ├── auth.ts        OAuth login + token refresh
│   ├── store.ts       Credential persistence
│   └── log.ts         File logger
└── package.json

tui/
├── src/
│   ├── main.ts        Entry point + app logic
│   ├── protocol.ts    IPC type definitions (independent copy)
│   ├── client.ts      Unix socket client
│   ├── render.ts      Terminal rendering
│   └── input.ts       Key event parsing
└── package.json
```

## What's Next

This is a prototype. The architecture is in place for:

- **Tools** — Add tool definitions to the daemon, execute them server-side
- **Conversation persistence** — Save/load from disk
- **Multiple clients** — The daemon already supports multiple connections
- **Sidebar** — Conversation list, switching between conversations
- **Vim mode** — Modal editing in the TUI
- **Compaction** — Context window management
- **Headless mode** — Pipe queries through the daemon without a TUI
