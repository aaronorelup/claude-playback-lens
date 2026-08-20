// tests/stubs/store — stand-in for server/summary.mjs (group B).

import { appendFileSync } from 'node:fs';

export function summarise(model, ledgerRows, fingerprint) {
  if (process.env.LENS_TEST_CALLS) {
    appendFileSync(process.env.LENS_TEST_CALLS, `summarise ${model.id}\n`);
  }
  return {
    card: {
      v: 1,
      slug: model.slug,
      id: model.id,
      fingerprint,
      state: 'ok',
      title: `stub ${model.id}`,
      aiTitle: null,
      customTitle: null,
      cwd: null,
      version: null,
      entrypoint: null,
      branch: null,
      startedAt: null,
      endedAt: null,
      otherSessionIds: [],
      bytes: 0,
      files: 0,
      lines: 0,
      events: 0,
      rows: ledgerRows.length,
      toolCalls: 0,
      images: 0,
      thinkingChars: 0,
      textChars: 0,
      usageByModel: {},
      mainMsgIds: ledgerRows.map((r) => r.msgId).filter(Boolean),
      turnCount: 0,
      agentCount: 0,
      workflowCount: 0,
      badges: [],
    },
    detail: { turns: [], agents: [], workflows: [], problems: [] },
  };
}
