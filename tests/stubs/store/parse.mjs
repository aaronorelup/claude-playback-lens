// tests/stubs/store — stand-in for server/parse.mjs (group B).
// Records every call so the test can prove that unchanged sessions are NOT
// re-parsed on a second start.

import { appendFileSync } from 'node:fs';

export async function parseSession(sessionEntry, { onProgress } = {}) {
  if (process.env.LENS_TEST_CALLS) {
    appendFileSync(
      process.env.LENS_TEST_CALLS,
      `parse ${sessionEntry.id}\nabs ${sessionEntry.id} ${sessionEntry.absMain}\n`,
    );
  }
  if (sessionEntry.id === process.env.LENS_TEST_THROW_ID) {
    throw new Error('stub parse failure');
  }
  if (typeof onProgress === 'function') onProgress({ bytesDone: Math.floor((sessionEntry.bytes || 0) / 2) });
  return {
    id: sessionEntry.id,
    slug: sessionEntry.slug,
    main: { rows: [{ line: 1, bi: null, kind: 'prompt', at: 1, head: 'stub', extra: {} }], turns: [], meta: {} },
    agents: [],
    workflows: [],
    journalOnly: [],
    inventory: { perType: {}, attachmentKinds: {}, images: [], spills: [], filesLedger: [], sessionIdsSeen: [], problems: [] },
    assistantLines: [{ id: `msg_${sessionEntry.id}`, sessionId: sessionEntry.id }],
    // echoed back so the test can assert the worker handed over absolute paths
    _absMain: sessionEntry.absMain,
    _projectsDir: sessionEntry.projectsDir,
  };
}
