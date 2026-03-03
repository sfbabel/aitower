/**
 * File logger for exocortexd.
 *
 * Writes to ~/.config/exocortex/exocortex.log with automatic rotation at 5 MB.
 */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "exocortex");
const LOG_FILE = join(LOG_DIR, "exocortex.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const envLevel = (process.env.EXOCORTEX_LOG_LEVEL ?? "info").toLowerCase();
const minLevel = LEVEL_RANK[envLevel as LogLevel] ?? LEVEL_RANK.info;

const PID = process.pid;
let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

export function log(level: LogLevel, msg: string): void {
  if (LEVEL_RANK[level] < minLevel) return;
  ensureDir();
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size >= MAX_LOG_BYTES) {
      try { renameSync(LOG_FILE, LOG_FILE + ".1"); } catch {}
    }
  } catch {}
  const ts = new Date().toISOString();
  appendFileSync(LOG_FILE, `[${ts}] [${PID}] [${level.toUpperCase()}] ${msg}\n`);
}
