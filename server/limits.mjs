// server/limits.mjs — every tunable knob the server honours, in one place.
// Each value is a deliberate default someone might reasonably retune — never
// intrinsic math (ms per day, base64 arithmetic), which stays at its use site.
// Nothing here is read from config or env; overrides arrive per call site.

// ---------------------------------------------------------------- HTTP / API
export const DEFAULT_PORT = 8791;            // first port tried; --port / PORT override
export const PORT_SCAN_ATTEMPTS = 10;        // how far the EADDRINUSE walk goes past DEFAULT_PORT
export const HELLO_PROBE_TIMEOUT_MS = 1200;  // GET /api/hello port-probe timeout (focus, don't duplicate)
export const SSE_HEARTBEAT_MS = 15000;       // SSE comment-heartbeat cadence (SPEC §9: every 15 s)
export const BODY_LIMIT_BYTES = 1 << 20;     // largest accepted JSON request body (1 MiB)
export const ROWS_PAGE_DEFAULT = 300;        // /api/agent + /api/records default page size
export const ROWS_PAGE_MAX = 5000;           // /api/agent + /api/records hard page cap (caps clamp, never reject)
export const LINES_WINDOW_MAX = 500;         // /api/lines window size — both the default and the cap
export const RETRY_AFTER_MS = 1000;          // retry hint carried by every 409 not-indexed-yet envelope
export const PROGRESS_POLL_MS = 500;         // /api/progress status-poll cadence (no-watchProgress fallback)
export const DAY_WALK_CAP = 100000;          // most local calendar days one turn bar's span is walked
                                             // (a longer recorded span is clock skew; the walk stops and says so)

// ------------------------------------------------- indexing / worker lifecycle
export const WORKER_RESTART_DEBOUNCE_MS = 2000;      // trailing debounce on worker re-`start` after staleness
export const WORKER_BACKOFF_MS = [1000, 2000, 5000]; // respawn delays; the last step repeats
export const WORKER_CRASH_WINDOW_MS = 60000;         // crash-loop detection window
export const WORKER_CRASH_CAP = 5;                   // respawns tolerated inside the window before staying down
export const RESCAN_INTERVAL_MS = 5000;              // liveness stat-walk cadence (SPEC §9)
export const WORKER_PROGRESS_MS = 250;               // worker build-progress message cadence
export const PROBLEMS_CAP = 200;                     // store-scope problem rows kept and served
export const PROBLEM_SOURCE_CAP = 25;                // linked source identities kept per collapsed problem row

// ---------------------------------------------------------------------- caches
export const LRU_MAX_ENTRIES = 8;            // parsed-session LRU entry budget (SPEC §9)
export const LRU_MAX_BYTES = 96e6;           // parsed-session LRU byte budget (SPEC §9; estimated, not measured)
export const OFFSET_TABLE_CAP = 32;          // jsonl line-offset tables kept resident
export const RANGE_BYTE_BUDGET = 16 << 20;   // /api/lines byte budget per window read (16 MiB)
export const INDEX_WRITE_DEBOUNCE_MS = 2000; // index.json writer minimum interval between flushes
export const TMP_SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // orphaned cache tmp-file age before the boot sweep deletes it

// ----------------------------------------------------------------------- scans
export const FIND_MATCH_CAP = 500;           // /api/find stops emitting after this many matches
export const REGEX_LINE_CAP = 1 << 18;       // chars of one line/block a user regex is matched against (256 KiB)
export const WALK_FILE_CAP = 250000;         // /api/validate-dir walk stops counting past this many files
export const WALK_MS_CAP = 8000;             // /api/validate-dir walk time budget
