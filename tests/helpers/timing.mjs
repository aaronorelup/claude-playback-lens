// tests/helpers/timing.mjs — the shared timing helpers.
//
// These were re-declared per test file; the bodies here are verbatim lifts
// (waitUntil comes from tests/fixes-round8.test.mjs, where the worker-revival
// suites needed a bounded poll with a named condition in the timeout error).
//
// NOTE: web-fixes files that settled on a different default (20ms rather than
// 30ms) keep a one-line local `const settle = (ms = 20) => sleep(ms);` — this
// module never changes a file's sleep durations.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(10);
  }
}
