// tests/stubs/store — stand-in for server/jsonl.mjs (group B).
// The stub parser never calls these; they only have to exist so the worker can
// hand them to parseSession.

export function stripHeavy(lineText) {
  return { text: lineText, blobs: [] };
}

export async function* readLines(_absPath) {
  // no lines
}

export async function buildOffsetTable() {
  return { offsets: [], total: 0, bytes: 0 };
}

export async function readLineAt() {
  return '';
}

export async function readLineRange() {
  return { from: 1, count: 0, total: 0, lines: [] };
}
