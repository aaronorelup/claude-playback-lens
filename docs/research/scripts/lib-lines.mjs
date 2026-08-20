// lib-lines.mjs - streaming JSONL line reader that splits ONLY on \n (0x0A).
//
// WHY NOT node:readline: readline also breaks lines on U+2028 LINE SEPARATOR and
// U+2029 PARAGRAPH SEPARATOR. Those two code points are LEGAL raw inside a JSON
// string (JSON only forbids U+0000-U+001F), and they do occur in Claude transcript
// tool results. readline therefore tears one JSON record into several fragments,
// each of which fails JSON.parse. Measured: 12 occurrences in 3 of 946 corpus files;
// one agent file reported 83 "lines" and 7 parse errors under readline vs 76
// lines and 0 errors here.
//
// Splitting on \n alone is safe because a raw \n cannot appear inside a JSON string.
import fs from 'node:fs';

export async function* readJsonlLines(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
    }
  }
  if (buf.length) {
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    yield buf;
  }
}
