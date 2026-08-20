// web/js/lib/locator.mjs — the dotted-bi block grammar and the e/<line>[.<bi>]
// event locator (SPEC §8). Pure parsing/formatting only — the whole event
// addressing surface, testable without a DOM.
//
// `bi` is a dotted PATH STRING, never an integer:
//   <i>      message.content[i]
//   <i>.<j>  message.content[i].content[j]      (blocks inside a tool_result)
//   r        toolUseResult (object or bare-string form)
//   r.<j>    toolUseResult[j]                   (array form)

const RE_BI_I = /^(\d+)$/;
const RE_BI_IJ = /^(\d+)\.(\d+)$/;
const RE_BI_RJ = /^r\.(\d+)$/;

/** parseBi('2.11') -> {kind:'content-nested', i:2, j:11}; invalid -> null. */
export function parseBi(bi) {
  if (bi === null || bi === undefined) return null;
  const str = String(bi);
  if (str === '') return null;
  if (str === 'r') return { kind: 'sidecar', i: null, j: null };
  let m = RE_BI_I.exec(str);
  if (m) return { kind: 'content', i: Number(m[1]), j: null };
  m = RE_BI_IJ.exec(str);
  if (m) return { kind: 'content-nested', i: Number(m[1]), j: Number(m[2]) };
  m = RE_BI_RJ.exec(str);
  if (m) return { kind: 'sidecar-index', i: null, j: Number(m[1]) };
  return null;
}

/** formatBi({kind:'content-nested',i:2,j:11}) -> '2.11'; invalid -> null. */
export function formatBi(parsed) {
  if (!parsed) return null;
  if (typeof parsed === 'string') return parseBi(parsed) ? parsed : null;
  switch (parsed.kind) {
    case 'content':
      return Number.isInteger(parsed.i) && parsed.i >= 0 ? String(parsed.i) : null;
    case 'content-nested':
      return Number.isInteger(parsed.i) && parsed.i >= 0 && Number.isInteger(parsed.j) && parsed.j >= 0
        ? `${parsed.i}.${parsed.j}` : null;
    case 'sidecar':
      return 'r';
    case 'sidecar-index':
      return Number.isInteger(parsed.j) && parsed.j >= 0 ? `r.${parsed.j}` : null;
    default:
      return null;
  }
}

/**
 * parseLocator('412.2.11') -> {line:412, bi:'2.11'}
 * "The hash router splits e/<line> and the block path on the first `.` only
 * after the line number" (SPEC §8). Invalid -> null.
 */
export function parseLocator(loc) {
  if (loc === null || loc === undefined) return null;
  const str = String(loc).trim();
  if (str === '') return null;
  const dot = str.indexOf('.');
  const lineStr = dot === -1 ? str : str.slice(0, dot);
  if (!/^\d+$/.test(lineStr)) return null;
  const line = Number(lineStr);
  if (line < 1) return null;                       // 1-based everywhere (SPEC §1)
  if (dot === -1) return { line, bi: null };
  const rest = str.slice(dot + 1);
  if (rest === '') return null;
  if (!parseBi(rest)) return null;
  return { line, bi: rest };
}

/** formatLocator(412, '2.11') -> '412.2.11'. */
export function formatLocator(line, bi) {
  const n = Number(line);
  if (!Number.isInteger(n) || n < 1) return null;
  const b = bi === null || bi === undefined || bi === '' ? null : formatBi(bi);
  return b ? `${n}.${b}` : String(n);
}

/** The user-verifiable copy-locator: `<rel>:<line>[.<bi>]`, 1-based. */
export function copyLocator(rel, line, bi) {
  const loc = formatLocator(line, bi);
  return `${rel ?? '?'}:${loc ?? line}`;
}

/** bi -> a JSON path array for jsonview's highlightPath. */
export function biToPath(bi) {
  const p = parseBi(bi);
  if (!p) return null;
  switch (p.kind) {
    case 'content': return ['message', 'content', p.i];
    case 'content-nested': return ['message', 'content', p.i, 'content', p.j];
    case 'sidecar': return ['toolUseResult'];
    case 'sidecar-index': return ['toolUseResult', p.j];
    default: return null;
  }
}
