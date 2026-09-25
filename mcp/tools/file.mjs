// mcp/tools/file.mjs — lens_file: one file's history across every session.
//
// "When was this file first written?", "which session moved it?", "who last
// edited it?" — answered from the recorded tool calls, oldest first. Every tool
// call whose input names the path is an event; what it DID is read off the
// recorded tool name (Write / Edit / Read …) or, for shell commands, off the
// command verb (Move-Item, mv, rm, Copy-Item, >, Set-Content …). A command
// that names the file without a recognised verb is reported as "mentioned",
// never guessed into a write.
//
// The path matches with either slash and regardless of the JSON doubling of
// backslashes in the raw transcript (see server/find.mjs makeMatcher).

import { z } from 'zod';
import { scanEvents, coverageLine, titleOf } from '../scan.mjs';

const DESCRIPTION = 'The history of one file across every recorded session, OLDEST FIRST: each tool call that wrote, edited, read, moved, copied or deleted it, with when, which session and the exact command. Answers "when was this file first written/created", "which session moved or deleted it", "who last edited it". Pass the most distinctive tail of the path (e.g. "AaronO\\\\README.md" or "src/app/main.ts"); either slash works. Shell commands are classified by their verb; a command that names the file without a recognised verb is shown as "mentioned", never assumed to be a write.';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'str_replace_based_edit_tool']);
const SHELL_TOOLS = /^(Bash|PowerShell|BashOutput)$/i;

// Order matters: the first verb that appears in the command wins.
const SHELL_VERBS = [
  ['delete', /\b(Remove-Item|rm|del|erase|rmdir|rd|unlink)\b/i],
  ['move', /\b(Move-Item|mv|Rename-Item|ren|rename|git\s+mv)\b/i],
  ['copy', /\b(Copy-Item|cp|copy|xcopy|robocopy)\b/i],
  ['write', /(Set-Content|Add-Content|Out-File|New-Item|\btee\b|>>?\s*["']?[^\s|&;]*$|>>?\s*["']?[\w.:\\/~-])/i],
  ['read', /\b(Get-Content|cat|type|head|tail|less|more)\b/i],
];

function opOf(tool, text) {
  if (!tool) return 'mentioned';
  if (tool === 'Write') return 'write';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (tool === 'Read') return 'read';
  if (tool === 'Glob' || tool === 'Grep') return 'search';
  if (SHELL_TOOLS.test(tool)) {
    let cmd = text;
    try { const j = JSON.parse(text); if (j && typeof j.command === 'string') cmd = j.command; } catch { /* raw */ }
    for (const [op, rx] of SHELL_VERBS) if (rx.test(cmd)) return op;
    return 'mentioned';
  }
  return 'mentioned';
}

function variantsOf(p) {
  const v = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
  // Tool-call input is JSON text: its backslashes are doubled.
  for (const x of [...v]) v.add(JSON.stringify(x).slice(1, -1));
  return [...v].map((x) => x.toLowerCase());
}

function snippet(text, variants, width = 180) {
  const low = text.toLowerCase();
  let at = -1, len = 0;
  for (const v of variants) { const i = low.indexOf(v); if (i !== -1) { at = i; len = v.length; break; } }
  if (at < 0) return text.slice(0, width).replace(/\s+/g, ' ');
  const half = Math.max(0, Math.floor((width - len) / 2));
  const a = Math.max(0, at - half);
  const b = Math.min(text.length, at + len + half);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

export function register(server, deps) {
  const { ctx, render } = deps;

  server.registerTool(
    'lens_file',
    {
      title: 'File history',
      description: DESCRIPTION,
      inputSchema: z.object({
        path: z.string().min(2).describe('The file path, or its most distinctive tail. Either slash.'),
        include_reads: z.boolean().default(true).describe('Include reads and searches, not only changes.'),
        since: z.string().optional().describe('YYYY-MM-DD (UTC) or ISO timestamp.'),
        until: z.string().optional().describe('YYYY-MM-DD (UTC, inclusive) or ISO timestamp.'),
        scope: z.string().default('store').describe('store | project:<slug> | session:<slug>/<id>'),
        include_current_session: z.boolean().default(false),
        limit: z.number().int().min(1).max(300).default(60).describe('Events to list (oldest first).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a, extra) => {
      const callerId = extra && extra.caller && extra.caller.sessionId;
      const excludeIds = !a.include_current_session && callerId ? [callerId] : [];
      const r = await scanEvents(deps, {
        scope: a.scope,
        cap: 2000,
        find: {
          q: a.path,
          kinds: ['tool_use'],
          since: a.since ?? null,
          until: a.until ?? null,
          distinct: true,
          fullText: true,
          excludeIds,
        },
      });
      if (r.pending) return render.pendingResult({});
      if (r.error) return render.errorResult(`lens_file: ${r.error}`);

      const variants = variantsOf(a.path);
      const ms = (m) => (m.at ? Date.parse(m.at) : Number.POSITIVE_INFINITY);
      let events = r.matches.map((m) => ({ ...m, op: opOf(m.tool, String(m.ctx ?? '')) }))
        .sort((x, y) => ms(x) - ms(y));
      if (!a.include_reads) events = events.filter((e) => e.op !== 'read' && e.op !== 'search');

      const lines = [];
      lines.push(`FILE ${JSON.stringify(a.path)} · scope=${r.scopeStr}${excludeIds.length ? ` · skipping this session ${excludeIds[0].slice(0, 8)}` : ''} · oldest first`);
      lines.push(coverageLine(render, r));
      if (events.length === 0) {
        lines.push(r.capped
          ? 'no events shown, and the scan hit its cap — NOT a real zero.'
          : 'no recorded tool call names this path — a real zero for that coverage. Try a shorter tail of the path (just the file name), or lens_search for it in tool_result text.');
        return render.textResult(lines.join('\n'));
      }
      const counts = {};
      for (const e of events) counts[e.op] = (counts[e.op] ?? 0) + 1;
      lines.push(`${events.length} event${events.length === 1 ? '' : 's'}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
      const firstOf = (ops) => events.find((e) => ops.includes(e.op));
      const lastOf = (ops) => [...events].reverse().find((e) => ops.includes(e.op));
      const stamp = (e) => (e ? `${e.at ? e.at.replace('T', ' ').slice(0, 16) : render.UNKNOWN} UTC — ${e.op} via ${e.tool} in ${e.id.slice(0, 8)}${titleOf(ctx, e.id) ? ` "${titleOf(ctx, e.id)}"` : ''}` : 'none recorded');
      lines.push(`first seen:   ${stamp(events[0])}`);
      lines.push(`first write:  ${stamp(firstOf(['write']))}`);
      lines.push(`last change:  ${stamp(lastOf(['write', 'edit', 'move', 'copy', 'delete']))}`);
      if (counts.mentioned) lines.push(`"mentioned" = a command names the path but no recognised verb shows what it did — open it with lens_read to see.`);
      lines.push(render.FENCE);

      const shown = events.slice(0, a.limit);
      const rows = shown.map((e) => [
        e.at ? e.at.replace('T', ' ').slice(0, 16) : render.UNKNOWN,
        e.op,
        e.tool ?? render.UNKNOWN,
        e.id.slice(0, 8),
        `${e.file === `${e.id}.jsonl` ? '' : `${e.file} `}L${e.line}`,
      ]);
      const laid = render.table([['when (UTC)', 'op', 'tool', 'session', 'line'], ...rows]).split('\n');
      lines.push(laid[0]);
      for (let i = 0; i < shown.length; i++) {
        lines.push(laid[i + 1]);
        lines.push(`    "${snippet(String(shown[i].ctx ?? ''), variants)}"`);
      }
      if (events.length > shown.length) lines.push(`… ${events.length - shown.length} later events not shown (raise limit).`);
      const f = shown[0];
      lines.push(`next: lens_read slug=${JSON.stringify(f.slug)} id=${JSON.stringify(f.id)} file=${JSON.stringify(f.file)} line=${f.line} following=1   (the first event and its result)`);
      return render.textResult(render.capText(lines.join('\n'), { narrow: 'limit' }));
    },
  );
}
