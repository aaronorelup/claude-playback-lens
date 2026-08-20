// server/api.mjs — the public door to the HTTP API (group D; SPEC §9).
// The implementation lives in server/api/ (one concern per module); this
// façade re-exports the stable seam that lens.mjs and the tests import.
// The ctx contract createApi consumes is documented in server/api/index.mjs.

export { createApi } from './api/index.mjs';
export { parseScope, scopeString, catastrophicShape } from './api/scope.mjs';
export { resolveFileRef } from './api/fileref.mjs';
export { localDateOf, dateOfDay, dayStartMsOf, makeBands, finishBands } from './api/bands.mjs';
