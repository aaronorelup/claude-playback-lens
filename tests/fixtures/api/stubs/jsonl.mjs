// Test stub for server/jsonl.mjs (group B) — documented signatures only.
import fsp from 'node:fs/promises';

const B64_RE = /("(?:data|base64)"\s*:\s*")([A-Za-z0-9+/=]{500,})(")/g;
const SIG_RE = /("signature"\s*:\s*")([A-Za-z0-9+/=_-]{100,})(")/g;

export function stripHeavy(lineText) {
  const blobs = [];
  let text = lineText.replace(B64_RE, (_m, a, mid, z) => {
    blobs.push({ kind: 'base64', length: mid.length });
    return a + z;
  });
  text = text.replace(SIG_RE, (_m, a, mid, z) => {
    blobs.push({ kind: 'signature', length: mid.length });
    return a + z;
  });
  return { text, blobs };
}

async function readAllLines(absPath) {
  const buf = await fsp.readFile(absPath);
  const text = buf.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] !== '' && !text.endsWith('\n')) parts.pop(); // hold back tail
  else parts.pop(); // drop empty final split
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export async function* readLines(absPath) {
  const lines = await readAllLines(absPath);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    yield { text: lines[i], line: i + 1, byteOffset: off, bytes: Buffer.byteLength(lines[i]) + 1 };
    off += Buffer.byteLength(lines[i]) + 1;
  }
}

export async function buildOffsetTable(absPath) {
  const lines = await readAllLines(absPath);
  return { offsets: [], total: lines.length, bytes: 0 };
}

export async function readLineAt(absPath, line1) {
  const lines = await readAllLines(absPath);
  return line1 >= 1 && line1 <= lines.length ? lines[line1 - 1] : null;
}

export async function readLineRange(absPath, from1, count) {
  const lines = await readAllLines(absPath);
  const total = lines.length;
  const slice = lines.slice(from1 - 1, from1 - 1 + count);
  return { from: from1, count: slice.length, total, lines: slice };
}
