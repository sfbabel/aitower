/**
 * Path tab-completion for the prompt line.
 *
 * Extracts the whitespace-delimited token at the cursor position,
 * resolves it against the filesystem, and returns the completed
 * buffer + cursor. Supports absolute paths, tilde expansion, and
 * relative paths. Adds a trailing / for directories.
 */

import { readdirSync, statSync } from "fs";
import { resolve, dirname, basename, join } from "path";
import { homedir } from "os";

export interface TabResult {
  buffer: string;
  cursor: number;
}

/**
 * Try to tab-complete the path token at the cursor.
 * Returns the updated buffer + cursor, or null if no completion.
 */
export function tabComplete(buffer: string, cursor: number): TabResult | null {
  // ── Extract the whitespace-delimited token ending at cursor ────
  let start = cursor;
  while (start > 0 && buffer[start - 1] !== " " && buffer[start - 1] !== "\n" && buffer[start - 1] !== "\t") {
    start--;
  }
  const token = buffer.slice(start, cursor);
  if (!token) return null;

  // ── Expand tilde ──────────────────────────────────────────────
  const home = homedir();
  let expanded = token;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = home + expanded.slice(1);
  }

  // ── Split into directory + prefix ─────────────────────────────
  let dir: string;
  let prefix: string;

  if (expanded.endsWith("/")) {
    dir = resolve(expanded);
    prefix = "";
  } else {
    dir = dirname(resolve(expanded));
    prefix = basename(expanded);
  }

  // ── List directory entries ────────────────────────────────────
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return null;
  }

  // ── Filter by prefix (case-sensitive) ─────────────────────────
  const matches = prefix ? entries.filter(e => e.startsWith(prefix)) : entries;
  if (matches.length === 0) return null;

  // ── Longest common prefix of matches ──────────────────────────
  let lcp = matches[0];
  for (let i = 1; i < matches.length; i++) {
    let j = 0;
    while (j < lcp.length && j < matches[i].length && lcp[j] === matches[i][j]) j++;
    lcp = lcp.slice(0, j);
  }

  // ── Nothing new to add ────────────────────────────────────────
  if (lcp === prefix) {
    // Exact single match that's a directory → append /
    if (matches.length === 1) {
      try {
        if (statSync(join(dir, lcp)).isDirectory() && !token.endsWith("/")) {
          const completed = token + "/";
          return {
            buffer: buffer.slice(0, start) + completed + buffer.slice(cursor),
            cursor: start + completed.length,
          };
        }
      } catch {}
    }
    return null;
  }

  // ── Build the completed token ─────────────────────────────────
  let completed: string;
  const lastSlash = token.lastIndexOf("/");
  if (lastSlash === -1) {
    completed = lcp;
  } else {
    completed = token.slice(0, lastSlash + 1) + lcp;
  }

  // Single match that's a directory → add trailing /
  if (matches.length === 1) {
    try {
      if (statSync(join(dir, lcp)).isDirectory()) {
        completed += "/";
      }
    } catch {}
  }

  return {
    buffer: buffer.slice(0, start) + completed + buffer.slice(cursor),
    cursor: start + completed.length,
  };
}
