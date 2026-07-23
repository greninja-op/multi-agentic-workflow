/**
 * Small, bounded local-only diff previews for the CFLS team panel.
 *
 * This module deliberately has no transport dependency: its output is derived
 * from the user's active VS Code document and its on-disk saved version, and
 * is rendered only in that same VS Code window. It must never be placed in a
 * coordination event, Local_API request, or host payload.
 */

/** The kind of one rendered unified-diff line. */
export type LocalDiffLineKind = "added" | "removed" | "context";

/** A single, display-safe line in the small local preview. */
export interface LocalDiffLine {
  kind: LocalDiffLineKind;
  text: string;
}

/** A deliberately small local change preview suitable for the team panel. */
export interface LocalDiffPreview {
  /** Repository-relative file path. */
  path: string;
  /** Number of added and removed lines in the full local comparison. */
  changedLines: number;
  /** True when the preview was bounded rather than showing every change. */
  truncated: boolean;
  /** Display-safe unified-diff lines. */
  lines: LocalDiffLine[];
}

const MAX_INPUT_CHARACTERS = 24_000;
const MAX_INPUT_LINES = 240;
const MAX_OUTPUT_LINES = 14;
const CONTEXT_LINES = 2;
const MAX_DISPLAY_LINE_LENGTH = 180;

const SECRET_ASSIGNMENT =
  /\b(api[-_ ]?key|authorization|password|private[-_ ]?key|secret|token)\b\s*([:=])\s*([^\s,;]+)/iu;
const TOKEN_VALUE =
  /\b(?:sk|pk|rk|ghp)[_-][A-Za-z0-9_-]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;

/** Split normalised text without manufacturing a phantom final empty line. */
function linesOf(value: string): string[] {
  const normalised = value.replace(/\r\n?/gu, "\n");
  if (normalised === "") {
    return [];
  }
  const lines = normalised.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Keep a local preview useful in a screen-share without casually exposing a
 * credential-shaped value. The document itself never leaves the VS Code
 * process; this is a second, presentation-only guard.
 */
function displayLine(value: string): string {
  const redactedAssignment = value.replace(
    SECRET_ASSIGNMENT,
    (_match, field: string, separator: string) =>
      `${field}${separator}<redacted>`,
  );
  const redacted = redactedAssignment.replace(TOKEN_VALUE, "<redacted>");
  return redacted.length > MAX_DISPLAY_LINE_LENGTH
    ? `${redacted.slice(0, MAX_DISPLAY_LINE_LENGTH - 1)}…`
    : redacted;
}

/** Construct the minimal line edit script with a bounded LCS table. */
function diffLines(before: string[], after: string[]): LocalDiffLine[] {
  const table = Array.from(
    { length: before.length + 1 },
    () => new Uint16Array(after.length + 1),
  );

  for (
    let beforeIndex = before.length - 1;
    beforeIndex >= 0;
    beforeIndex -= 1
  ) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex]![afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? table[beforeIndex + 1]![afterIndex + 1]! + 1
          : Math.max(
              table[beforeIndex + 1]![afterIndex]!,
              table[beforeIndex]![afterIndex + 1]!,
            );
    }
  }

  const result: LocalDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length &&
      afterIndex < after.length &&
      before[beforeIndex] === after[afterIndex]
    ) {
      result.push({ kind: "context", text: before[beforeIndex]! });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      beforeIndex < before.length &&
      (afterIndex === after.length ||
        table[beforeIndex + 1]![afterIndex]! >=
          table[beforeIndex]![afterIndex + 1]!)
    ) {
      result.push({ kind: "removed", text: before[beforeIndex]! });
      beforeIndex += 1;
    } else {
      result.push({ kind: "added", text: after[afterIndex]! });
      afterIndex += 1;
    }
  }
  return result;
}

/**
 * Build an actual, compact unified diff for an active unsaved document.
 * Returns `null` when there is no local change. Large files intentionally get
 * a content-free notice instead of a costly or overly broad preview.
 */
export function buildLocalDiffPreview(
  path: string,
  savedText: string,
  currentText: string,
): LocalDiffPreview | null {
  if (savedText === currentText) {
    return null;
  }

  const before = linesOf(savedText);
  const after = linesOf(currentText);
  if (
    savedText.length > MAX_INPUT_CHARACTERS ||
    currentText.length > MAX_INPUT_CHARACTERS ||
    before.length > MAX_INPUT_LINES ||
    after.length > MAX_INPUT_LINES
  ) {
    return {
      path,
      changedLines: 1,
      truncated: true,
      lines: [
        {
          kind: "context",
          text: "Large local change detected — preview intentionally limited.",
        },
      ],
    };
  }

  const full = diffLines(before, after);
  const changedLines = full.filter((line) => line.kind !== "context").length;
  const firstChange = full.findIndex((line) => line.kind !== "context");
  if (firstChange < 0) {
    return null;
  }
  let end = firstChange;
  while (end < full.length && full[end]!.kind !== "context") {
    end += 1;
  }
  const start = Math.max(0, firstChange - CONTEXT_LINES);
  const requestedEnd = Math.min(full.length, end + CONTEXT_LINES);
  const visible = full.slice(
    start,
    Math.min(requestedEnd, start + MAX_OUTPUT_LINES),
  );
  const truncated =
    start > 0 ||
    requestedEnd < full.length ||
    visible.length < requestedEnd - start;

  return {
    path,
    changedLines,
    truncated,
    lines: visible.map((line) => ({ ...line, text: displayLine(line.text) })),
  };
}
