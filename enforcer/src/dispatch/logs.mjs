// Dispatcher logging: dispatcher.jsonl (one JSON object per line) plus the human dispatcher.log line;
// worker streams under logs/ are 0600, redacted once the worker exits, and pruned by age and size on start.
import { appendFileSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../graph/redact.mjs';

export const DEFAULT_LOG_DAYS = 14;
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 ** 3;

/** @type {[RegExp, string][]} */
const LEVEL_RE = [
  [/^(REFUSE|BLOCKED|DENIED|FAILED|HARNESS-LIMITED|CI-UNAVAILABLE)\b/, 'error'],
  [/\b(failed|refused|denied|not minted|could not)\b/i, 'warn'],
];
export const levelOf = (msg) => (LEVEL_RE.find(([rx]) => /** @type {RegExp} */ (rx).test(msg)) || [0, 'info'])[1];
const eventOf = (msg) => (msg.match(/^[A-Za-z][\w-]*/) || ['log'])[0].toLowerCase();

/** Literal secrets the dispatcher holds (the agent key): replaced in every log line and worker stream, whatever their shape. */
const SECRETS = new Set();
export function addSecret(s) {
  if (typeof s === 'string' && s.length >= 8) SECRETS.add(s);
}
export function scrubSecrets(text, extra = []) {
  if (typeof text !== 'string' || !text) return [text, 0];
  let n = 0;
  for (const s of new Set([...SECRETS, ...extra.filter((x) => typeof x === 'string' && x.length >= 8)])) {
    const parts = text.split(s);
    if (parts.length > 1) {
      n += parts.length - 1;
      text = parts.join('[redacted:secret]');
    }
  }
  // any bare agent or worker token, whatever the surrounding text
  text = text.replace(/\b(?:ag|env3)_[A-Za-z0-9_-]{8,}/g, () => {
    n++;
    return '[redacted:secret]';
  });
  return [text, n];
}
const clean = (v) => {
  if (typeof v !== 'string') return v;
  return redact(scrubSecrets(v)[0])[0];
};

/** One JSON line: {ts (ISO), level, event, key, run, fields}. Secrets in strings are redacted. */
export function jsonLine(msg, { level, event, key = null, run = null, fields = {} } = /** @type {any} */ ({})) {
  const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, clean(v)]));
  return (
    JSON.stringify({ ts: new Date().toISOString(), level: level || levelOf(msg), event: event || eventOf(msg), key, run, msg: clean(msg), fields: f }) + '\n'
  );
}

/** Append the JSONL record and the human line to state/dispatcher.{jsonl,log}; 0600. */
export function writeLog(state, human, msg, opts) {
  const write = (name, text) => {
    try {
      const p = join(state, name);
      appendFileSync(p, text, { mode: 0o600 });
      chmodSync(p, 0o600);
    } catch {
      /* state dir gone */
    }
  };
  write('dispatcher.log', scrubSecrets(human)[0]);
  write('dispatcher.jsonl', jsonLine(msg, opts));
}

/** Create a worker stream file at 0600 and return its fd. */
export function openStream(path) {
  const fd = openSync(path, 'w', 0o600);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return fd;
}

/** Redact a finished stream in place (tool outputs may echo a token); returns the redaction count. */
export function redactFile(path, secrets = []) {
  try {
    const [lit, k] = scrubSecrets(readFileSync(path, 'utf8'), secrets);
    const [text, m] = redact(lit);
    const n = k + m;
    if (n) writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
    return n;
  } catch {
    return 0;
  }
}

/** Redact every existing stream in `dir` (a SIGKILLed dispatcher left them unredacted); returns the number of files changed. */
export function redactLogsDir(dir, secrets = []) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let files = 0;
  for (const n of names) if ((n.endsWith('.jsonl') || n.endsWith('.log')) && redactFile(join(dir, n), secrets)) files++;
  return files;
}

/** Remove streams older than `days` and, oldest first, enough to fit `maxBytes`. `skip` = paths of live workers. */
export function pruneLogs(dir, { days = DEFAULT_LOG_DAYS, maxBytes = DEFAULT_LOG_MAX_BYTES, now = Date.now(), skip = [] } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => !skip.includes(p))
    .flatMap((p) => {
      try {
        const s = statSync(p);
        return s.isFile() ? [{ p, t: s.mtimeMs, size: s.size }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.t - b.t);
  const removed = [];
  const rm = (f) => {
    try {
      rmSync(f.p, { force: true });
      removed.push(f.p);
      f.gone = true;
    } catch {
      /* keep */
    }
  };
  for (const f of files) if (now - f.t > days * 86400e3) rm(f);
  let total = files.filter((f) => !f.gone).reduce((a, f) => a + f.size, 0);
  for (const f of files) {
    if (total <= maxBytes) break;
    if (!f.gone) {
      rm(f);
      total -= f.size;
    }
  }
  return removed;
}
