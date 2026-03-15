import { theme } from "../theme";
import { formatMarkdown, stripMarkdown, termWidth, hardBreak, isHorizontalRule } from "./formatting";
import { FENCE_OPEN_RE, isFenceClose, renderCodeBlock } from "./codeblocks";
import { isTableLine, renderTableBlock } from "./tables";

/**
 * Main markdown-aware word wrapping function.
 *
 * Processes text line by line and:
 * 1. Detects fenced code blocks and renders them with syntax highlighting
 * 2. Detects table blocks and renders with box-drawing
 * 3. Detects horizontal rules and renders them as box-drawing lines
 * 4. For regular paragraph text, word-wraps to fit within width and
 *    applies inline markdown formatting (bold/italic/code)
 *
 * Output lines are fully formatted — the caller only needs to indent them.
 *
 * @param text The markdown text to wrap
 * @param width The width to wrap to
 * @param bgRestore Controls markdown formatting:
 *   - When provided (non-null), means we're rendering an assistant message — apply formatMarkdown
 *   - When null/undefined, it's a user message — keep text plain
 * @returns Array of wrapped, formatted lines
 */
export function markdownWordWrap(text: string, width: number, bgRestore?: string): string[] {
  if (width < 1) return [text];

  const inputLines = text.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < inputLines.length) {
    // Detect fenced code blocks: ```language ... ```
    // Only for assistant messages (bgRestore is the markdown-mode signal)
    const fenceMatch = bgRestore != null ? inputLines[i].match(FENCE_OPEN_RE) : null;
    if (fenceMatch) {
      const fenceLen = fenceMatch[1].length;
      const language = fenceMatch[2] || "";
      const codeLines: string[] = [];
      i++; // skip opening fence
      while (i < inputLines.length && !isFenceClose(inputLines[i], fenceLen)) {
        codeLines.push(inputLines[i]);
        i++;
      }
      if (i < inputLines.length) i++; // skip closing fence
      result.push(...renderCodeBlock(codeLines, language, width));
      continue;
    }

    // Detect table blocks: consecutive lines matching markdown table syntax
    if (isTableLine(inputLines[i])) {
      const start = i;
      while (i < inputLines.length && isTableLine(inputLines[i])) {
        i++;
      }
      result.push(...renderTableBlock(inputLines.slice(start, i), width, bgRestore));
      continue;
    }

    // Detect horizontal rules
    if (bgRestore != null && isHorizontalRule(inputLines[i])) {
      // Render as a thin box-drawing line
      const hrWidth = Math.min(width, 40); // cap at 40 chars
      result.push(theme.muted + "─".repeat(hrWidth) + theme.reset);
      i++;
      continue;
    }

    // Regular paragraph text — word-wrap and optionally format
    wrapParagraph(inputLines[i], width, result, bgRestore);
    i++;
  }

  return result;
}

/**
 * Wraps a single paragraph to fit within width.
 *
 * When bgRestore is provided (assistant mode), width measurement accounts
 * for markdown markers (** etc.) being invisible after formatting, and
 * formatMarkdown is applied to each wrapped line.
 */
function wrapParagraph(paragraph: string, width: number, result: string[], bgRestore?: string): void {
  if (paragraph === "") {
    result.push("");
    return;
  }

  // In markdown mode, measure visible width excluding markers.
  // In plain mode, measure raw terminal width.
  const measure = bgRestore != null
    ? (s: string) => termWidth(stripMarkdown(s))
    : termWidth;

  // First pass: word-wrap with correct measurement
  const wrapped: string[] = [];
  const words = paragraph.split(/\s+/);
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = measure(word) > width ? hardBreak(word, width, wrapped) : word;
    } else if (measure(line) + 1 + measure(word) <= width) {
      line += " " + word;
    } else {
      wrapped.push(line);
      line = measure(word) > width ? hardBreak(word, width, wrapped) : word;
    }
  }
  if (line !== "") wrapped.push(line);

  // Second pass: apply inline markdown formatting if in assistant mode
  if (bgRestore) {
    for (const l of wrapped) {
      result.push(formatMarkdown(l, bgRestore).text);
    }
  } else {
    result.push(...wrapped);
  }
}
