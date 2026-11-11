// `enforcer dispatch watch`: a long-running supervisor that keeps one dispatcher per graph that is looking for this
// caller's work. It never claims, launches or reports anything itself: the work lobby (GET /work) says which graphs
// advertise open seats to the caller, and for each one with no live dispatcher it runs `enforcer dispatch <graph>` (the
// same preflight and detached start a person gets). A dispatcher still exits when its graph goes idle; the next lobby
// read starts it again when demand returns. GET /work/stream wakes the loop early; a timer re-reads the lobby anyway,
// because a lapsing lease opens a seat without writing anything the stream could carry.
//
// A dispatcher that exits 6 (only failed or denied nodes remain, left for a person) parks its graph: watch does not start
// it again until the graph's fingerprint (graphFingerprint) differs from the one taken at that exit, even though the
// lobby still advertises those nodes. Without that, every relaunch spent fresh attempts on a node nobody had fixed.
//
// State: <config home>/dispatch/watch.json (this process, its graphs, its backoffs, its parked graphs), read by
// `enforcer dispatch status`; parked graphs are read back at start, so a watcher restart keeps them parked.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../config.mjs';
import { headers as authHeaders } from '../preflight.mjs';
import { API } from './api.mjs';
import { readAgentKey } from './agent.mjs';
import { FOR_VALUES } from './run.mjs';
import { LEASE_KEY } from './lease.mjs';

/** The contract asks lobby pollers to poll at 10 s or slower (WORK_LOBBY_CONTRACT §8). */
export const MIN_POLL = 10;
export const DEFAULT_POLL = 30;
/** A dispatcher that dies sooner than this after we started it counts as a failed start (preflight, auth, BLOCKED). */
export const SHORT_LIFE = 300;
export const BACKOFF_MIN = 60;
export const BACKOFF_MAX = 1800;
const IDENT = /^[A-Za-z0-9._-]+$/;

export const WATCH_HELP = `usage: enforcer dispatch watch [--for me|mine] [--agent <name>] [--max-graphs N] [--poll secs] [--once] [--dry-run] [dispatcher flags]
  keeps one dispatcher running per graph whose work lobby (GET /work) advertises open seats to this caller, and starts
  it again when demand returns after it went idle. It claims nothing itself.
  --for me|mine     read the lobby and run each dispatcher for nodes assigned to the caller (me: or to nobody)
  --agent <name>    the lobby, the stream and every dispatcher run as that agent (key: ENFORCER_AGENT_KEY or the keychain)
  --max-graphs N    at most N dispatchers at once (default 2); each still runs up to --workers workers
  --poll secs       re-read the lobby at least this often (default ${DEFAULT_POLL}, minimum ${MIN_POLL})
  --once            one pass, then exit (cron, tests); --dry-run says what it would start and starts nothing
  every other flag (--workers, --repo-root, --model, --worker-rules, ...) is passed to each dispatcher
state: <config home>/dispatch/watch.json; stop with SIGTERM (systemd stop): running dispatchers get it too and drain
`;

const WATCH_VALUE = ['--max-graphs', '--poll'];
const WATCH_BOOL = ['--once', '--dry-run'];

/** argv -> {opts, passthrough}. passthrough is what each dispatcher start gets (it carries --for and --agent too). */
export function parseWatchArgs(argv) {
  const opts = { for: null, agent: null, maxGraphs: 2, poll: DEFAULT_POLL, once: false, dryRun: false };
  const pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (WATCH_VALUE.includes(a)) {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${a} must be a whole number >= 1`);
      if (a === '--max-graphs') opts.maxGraphs = n;
      else opts.poll = Math.max(n, MIN_POLL);
      continue;
    }
    if (WATCH_BOOL.includes(a)) {
      if (a === '--once') opts.once = true;
      else opts.dryRun = true;
      continue;
    }
    if (a === '--for' || a === '--agent') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) throw new Error(`${a} needs a value`);
      if (a === '--for' && !FOR_VALUES.includes(v)) throw new Error(`--for must be one of ${FOR_VALUES.join(', ')}`);
      opts[a === '--for' ? 'for' : 'agent'] = v;
    }
    if (!a.startsWith('-') && !['--for', '--agent'].includes(argv[i - 1]) && !isValueOf(argv, i))
      throw new Error(`watch takes no graph id (${JSON.stringify(a)}): it reads the lobby; use enforcer dispatch <graph> for one graph`);
    pass.push(a);
  }
  return { opts, pass };
}

// A bare word right after a dispatcher flag that takes a value is that flag's value, not a graph id.
const DISPATCH_VALUE_FLAGS = ['--workers', '--model', '--repo-root', '--worker-rules', '--context', '--routes', '--route-probe-ttl', '--harness'];
const isValueOf = (argv, i) => DISPATCH_VALUE_FLAGS.includes(argv[i - 1]);

/**
 * Which lobby rows to start a dispatcher for. Pure. `rows` are GET /work items in the server's order (demand, then
 * priority); `running` is the set of graph ids with a live dispatcher; `backoff` maps graph id -> epoch seconds until
 * which it is not started. Returns {start: [graph ids], skipped: [[graph id, why]]}.
 */
/** The file `enforcer dispatch unpark <graph>` leaves for the watcher: its next pass releases the parked graph and removes it. */
export const unparkFile = (cfgHome, graph) => join(cfgHome, 'dispatch', String(graph), 'UNPARK');

export function pickGraphs(rows, { running = new Set(), backoff = new Map(), parked = new Map(), maxGraphs = 2, now = Date.now() / 1000 } = {}) {
  const start = [];
  /** @type {Array<[string, string]>} */
  const skipped = [];
  let slots = Math.max(0, maxGraphs - running.size);
  for (const r of rows || []) {
    const g = r?.graph_id;
    if (!g || running.has(g)) continue;
    if (!IDENT.test(g)) {
      skipped.push([g, 'graph id is not a safe path segment']);
      continue;
    }
    if (!(Number(r.workers_wanted) > 0)) continue;
    if (Array.isArray(r.my_can) && !r.my_can.includes('claim')) {
      skipped.push([g, `advertised to this caller, but its role (${r.my_role || '?'}) cannot claim: share the graph with it as editor`]);
      continue;
    }
    const park = parked.get(g);
    if (park) {
      const keys = park.nodes?.length ? ` (${park.nodes.slice(0, 5).join(', ')}${park.nodes.length > 5 ? ', ...' : ''})` : '';
      skipped.push([g, `failed or denied nodes left for a person${keys}; not starting it until something on the graph changes`]);
      continue;
    }
    const until = backoff.get(g) || 0;
    if (until > now) {
      skipped.push([g, `backing off until ${new Date(until * 1000).toISOString().slice(11, 19)}Z after a short-lived dispatcher`]);
      continue;
    }
    if (!slots) {
      skipped.push([g, `--max-graphs ${maxGraphs} reached`]);
      continue;
    }
    start.push(g);
    slots--;
  }
  return { start, skipped };
}

/** Next backoff for a graph whose dispatcher lived `livedS` seconds: doubles after a short life, clears after a long one. */
export function nextBackoff(prev, livedS) {
  if (livedS >= SHORT_LIFE) return 0;
  return Math.min(BACKOFF_MAX, prev ? prev * 2 : BACKOFF_MIN);
}

/** The node keys a dispatcher log's last line says were left for a person (`exiting 6: failed or denied nodes remain:
 *  a, b (peak N)`), or null when it ended any other way. */
export function leftKeys(lastLine) {
  const m = /nothing runnable or running; exiting 6: failed or denied nodes remain: (.*?) \(peak/.exec(lastLine || '');
  return m ? m[1].split(/,\s*/).filter(Boolean) : null;
}

/** At most this many left nodes have their resolved skills read for a fingerprint. */
export const FINGERPRINT_SKILL_NODES = 20;

/**
 * What a person changes when they fix a node left for them, as one hash: the graph's epoch and updated_at, its skill
 * source commit, every node's (id, status, updated_at) except the dispatcher's lease node, and the resolved skills
 * (slug, version, id, source commit) of the left nodes. Throws when the graph or its nodes cannot be read.
 */
export async function graphFingerprint(api, g, keys = []) {
  const graph = (await api.call('GET', `/graphs/${g}`)).data || {};
  const nodes = [];
  for (let off = 0; ; off += 200) {
    const d = await api.call('GET', `/graphs/${g}/nodes?limit=200&offset=${off}`);
    nodes.push(...(d.data || []));
    if (!(d.data || []).length || off + 200 >= (d.meta?.total ?? nodes.length)) break;
  }
  let source = null;
  try {
    const d = (await api.call('GET', `/graphs/${g}/skill-source`)).data || {};
    source = d.source?.resolved_commit ?? null;
  } catch {
    /* no source, or a server without the route */
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const skills = [];
  for (const k of keys.slice(0, FINGERPRINT_SKILL_NODES)) {
    const n = byKey.get(k);
    if (!n?.id) continue;
    let rows = [];
    try {
      rows = (await api.call('GET', `/graphs/${g}/nodes/${n.id}/skills`)).data || [];
    } catch {
      rows = ['unreadable'];
    }
    skills.push([k, rows.map((r) => (r?.skill ? [r.skill.slug, r.skill.version, r.skill.id, r.skill.metadata?.source?.commit ?? null] : r))]);
  }
  const rec = {
    graph: [graph.epoch ?? null, graph.updated_at ?? null],
    source,
    nodes: nodes
      .filter((n) => n.key !== LEASE_KEY)
      .map((n) => [n.id, n.status, n.updated_at ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    skills,
  };
  return createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
}

/** Every lobby row (GET /work?kind=work[&for=]), all pages. */
export async function lobby(api, forWho = null) {
  const out = [];
  for (let off = 0; ; off += 200) {
    const q = new URLSearchParams({ kind: 'work', limit: '200', offset: String(off) });
    if (forWho) q.set('for', forWho);
    const d = (await api.call('GET', `/work?${q}`)).data || {};
    const items = d.items || [];
    out.push(...items);
    if (items.length < 200 || out.length >= (d.total ?? 0)) return out;
  }
}

/**
 * Hold GET /work/stream open and call `wake()` on every frame (demand, poll, resync, ready). Returns when the stream ends
 * or `signal` aborts; throws on an HTTP error. Frames are only wake-ups (the contract's "invalidation, not delivery").
 * @param {string} url
 * @param {Record<string, string>} hdrs
 * @param {(event: string) => void} wake
 * @param {{ signal?: AbortSignal, fetchImpl?: Function }} [o]
 */
export async function followStream(url, hdrs, wake, { signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { ...hdrs, accept: 'text/event-stream' }, signal });
  if (!res.ok || !res.body) throw new Error(`work stream answered HTTP ${res.status}`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim() || 'message';
      wake(ev);
      if (ev === 'closed') return;
      i = buf.indexOf('\n\n');
    }
  }
}

export class Watcher {
  /**
   * deps: {api, env, cfgHome, start(graph, argv, env) -> exit code, alive(graph) -> pid|null, out(line), now()}.
   * Everything with an effect is injected, so the loop is tested without a network or a process.
   */
  constructor(opts, pass, deps) {
    this.o = opts;
    this.pass = pass;
    this.d = deps;
    this.started = new Map(); // graph -> {pid, at}: dispatchers this watcher started and still believes alive
    this.backoff = new Map(); // graph -> epoch seconds
    this.backoffLen = new Map(); // graph -> current backoff length, seconds
    this.lastPass = null;
    this.lastError = null;
    // graph -> {fingerprint, nodes, since}: exited 6, not started again until the fingerprint changes; kept across restarts
    this.parked = new Map(Object.entries((deps.cfgHome && readWatchState(deps.cfgHome)?.parked) || {}));
    this.toPark = [];
  }

  say(m) {
    this.d.out(`${new Date(this.d.now() * 1000).toISOString().slice(11, 19)} watch: ${m}\n`);
  }

  /** True when the graph's dispatcher log ends with the clean idle exit (`nothing runnable or running; exiting (peak`),
   *  i.e. it ran out of work, not into an error. Not the `exiting 6: failed or denied nodes remain` variant: those
   *  nodes are still advertised, so restarting at once would only churn. */
  finished(g) {
    if (typeof this.d.finished === 'function') return Boolean(this.d.finished(g));
    return /nothing runnable or running; exiting \(peak/.test(this.lastLogLine(g));
  }

  /** The keys a dispatcher that exited 6 left for a person, or null (see leftKeys). */
  leftForPerson(g) {
    if (typeof this.d.leftForPerson === 'function') return this.d.leftForPerson(g);
    return leftKeys(this.lastLogLine(g));
  }

  lastLogLine(g) {
    if (!this.d.cfgHome) return '';
    try {
      const lines = readFileSync(join(this.d.cfgHome, 'dispatch', g, 'dispatcher.log'), 'utf8')
        .trimEnd()
        .split('\n');
      return lines[lines.length - 1] || '';
    } catch {
      return '';
    }
  }

  /** The graph's fingerprint, or null when it cannot be read (the graph then stays as it is: parked or not). */
  async fingerprint(g, keys) {
    try {
      return await (this.d.fingerprint || graphFingerprint)(this.d.api, g, keys);
    } catch (e) {
      this.say(`cannot read ${g} to tell whether it changed (${e.message})`);
      return null;
    }
  }

  /** Park the graphs reaped this pass, and release parked ones the lobby offers whose fingerprint moved. */
  async reviewParked(rows, running) {
    const fresh = new Set();
    for (const [g, keys] of this.toPark.splice(0)) {
      this.parked.set(g, { fingerprint: await this.fingerprint(g, keys), nodes: keys, since: new Date(this.d.now() * 1000).toISOString() });
      fresh.add(g);
    }
    for (const r of rows) {
      const g = r?.graph_id;
      const p = g && this.parked.get(g);
      if (!p || fresh.has(g) || running.has(g) || !(Number(r.workers_wanted) > 0)) continue;
      // `enforcer dispatch unpark <graph>`: a person says the cause was fixed somewhere the fingerprint cannot see
      const flag = this.d.cfgHome && unparkFile(this.d.cfgHome, g);
      if (flag && existsSync(flag)) {
        rmSync(flag, { force: true });
        this.parked.delete(g);
        this.say(`${g} unparked by hand (enforcer dispatch unpark); it can start again`);
        continue;
      }
      const fp = await this.fingerprint(g, p.nodes || []);
      if (!fp) continue;
      if (!p.fingerprint)
        p.fingerprint = fp; // the read at exit failed: this one is the baseline
      else if (fp !== p.fingerprint) {
        this.parked.delete(g);
        this.say(`${g} changed since its dispatcher stopped on nodes left for a person; it can start again`);
      }
    }
  }

  /** Forget dispatchers that exited; a short life backs the graph off. Returns the set of graphs with a live dispatcher. */
  reapStarted() {
    const running = new Set();
    for (const [g, s] of [...this.started]) {
      if (this.d.alive(g)) {
        running.add(g);
        continue;
      }
      const lived = this.d.now() - s.at;
      this.started.delete(g);
      const left = this.leftForPerson(g);
      if (left) {
        // exit 6: the nodes it left are still advertised; starting it again would only spend attempts on them
        this.backoffLen.delete(g);
        this.backoff.delete(g);
        this.toPark.push([g, left]);
        this.say(
          `dispatcher for ${g} exited after ${Math.round(lived)}s leaving failed or denied nodes for a person (${left.join(', ')}); not starting it again until the graph changes`,
        );
        continue;
      }
      // a dispatcher that finished the graph is not one that died young: with workers reaped on exit a whole graph
      // can now finish inside SHORT_LIFE (a 20-step plan in 155-194 s), and that was backed off as a failure
      const len = this.finished(g) ? 0 : nextBackoff(this.backoffLen.get(g) || 0, lived);
      if (len) {
        this.backoffLen.set(g, len);
        this.backoff.set(g, this.d.now() + len);
        this.say(`dispatcher for ${g} exited after ${Math.round(lived)}s; not restarting it for ${len}s (see enforcer dispatch status ${g})`);
      } else {
        this.backoffLen.delete(g);
        this.backoff.delete(g);
        this.say(`dispatcher for ${g} exited after ${Math.round(lived)}s (graph went idle or finished)`);
      }
    }
    return running;
  }

  /** One pass: read the lobby, start what is missing. Never throws. */
  async pass_() {
    const running = this.reapStarted();
    let rows;
    try {
      rows = await lobby(this.d.api, this.o.for);
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this.say(`lobby read failed (${e.message}); retrying next pass`);
      this.save(running);
      return;
    }
    // a dispatcher a person (or an earlier watcher) started counts as running: one per graph, whoever started it
    for (const r of rows) if (r?.graph_id && IDENT.test(r.graph_id) && this.d.alive(r.graph_id)) running.add(r.graph_id);
    await this.reviewParked(rows, running);
    const { start, skipped } = pickGraphs(rows, { running, backoff: this.backoff, parked: this.parked, maxGraphs: this.o.maxGraphs, now: this.d.now() });
    for (const [g, why] of skipped) if (this.lastSkip?.get(g) !== why) this.say(`skip ${g}: ${why}`);
    this.lastSkip = new Map(skipped);
    for (const g of start) {
      if (this.o.dryRun) {
        this.say(`would start a dispatcher for ${g}`);
        continue;
      }
      this.say(`starting a dispatcher for ${g}`);
      let rc;
      try {
        rc = await this.d.start(g, this.pass, this.d.env);
      } catch (e) {
        rc = 2;
        this.say(`start ${g} threw: ${e.message}`);
      }
      if (rc === 0) {
        this.started.set(g, { at: this.d.now() });
        running.add(g);
      } else if (rc === 3) {
        // another dispatcher already runs it: look again after a minute, without counting it as a failure
        running.add(g);
        this.backoff.set(g, this.d.now() + BACKOFF_MIN);
        this.say(`${g} already has a dispatcher; checking again in ${BACKOFF_MIN}s`);
      } else {
        const len = nextBackoff(this.backoffLen.get(g) || 0, 0);
        this.backoffLen.set(g, len);
        this.backoff.set(g, this.d.now() + len);
        this.say(`start ${g} failed (exit ${rc}: preflight or routes); retrying in ${len}s`);
      }
    }
    this.lastPass = this.d.now();
    this.save(running, rows.length);
  }

  save(running, rows = null) {
    if (this.o.dryRun || !this.d.cfgHome) return;
    try {
      const dir = join(this.d.cfgHome, 'dispatch');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const p = join(dir, 'watch.json');
      const rec = {
        pid: this.d.pid ?? process.pid,
        for: this.o.for,
        agent: this.o.agent,
        max_graphs: this.o.maxGraphs,
        last_pass: this.lastPass ? new Date(this.lastPass * 1000).toISOString() : null,
        last_error: this.lastError,
        lobby_rows: rows,
        running: [...running].sort(),
        backoff: Object.fromEntries([...this.backoff].map(([g, t]) => [g, new Date(t * 1000).toISOString()])),
        parked: Object.fromEntries(this.parked),
      };
      writeFileSync(p + '.tmp', JSON.stringify(rec), { mode: 0o600 });
      renameSync(p + '.tmp', p);
    } catch {
      /* best effort */
    }
  }
}

/** The watch.json a running watcher wrote, or null. */
export function readWatchState(cfgHome) {
  try {
    return JSON.parse(readFileSync(join(cfgHome, 'dispatch', 'watch.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** `enforcer dispatch watch ...`. Returns the exit code. deps lets dispatch-command inject start/alive. */
export async function main(argv, env = process.env, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(WATCH_HELP);
    return 0;
  }
  let opts;
  let pass;
  try {
    ({ opts, pass } = parseWatchArgs(argv));
  } catch (e) {
    process.stderr.write(`enforcer dispatch watch: ${e.message}\n`);
    return 2;
  }
  if (process.platform === 'win32') {
    process.stderr.write('enforcer dispatch watch: not supported on Windows; use WSL\n');
    return 2;
  }
  let wenv = env;
  if (opts.agent) {
    const key = readAgentKey(opts.agent, env);
    if (!key) {
      process.stderr.write(`enforcer dispatch watch: agent "${opts.agent}" has no key: set ENFORCER_AGENT_KEY or store one in the OS keychain\n`);
      return 2;
    }
    // the lobby, the stream and each dispatcher's preflight must see the graphs as the agent, not as the operator
    wenv = { ...env, GRAPH_API_KEY: key };
  }
  const cfg = resolveConfig({ env: wenv });
  const api = deps.api || new API(cfg.graphUrl, { headers: () => authHeaders(wenv) });
  const cfgHome = deps.cfgHome ?? null;
  const w = new Watcher(opts, pass, {
    api,
    env: wenv,
    cfgHome,
    start: deps.start,
    alive: deps.alive,
    out: deps.out || ((s) => process.stdout.write(s)),
    now: deps.now || (() => Date.now() / 1000),
  });
  w.say(
    `watching the work lobby${opts.for ? ` for ${opts.for}` : ''}${opts.agent ? ` as agent ${opts.agent}` : ''}; up to ${opts.maxGraphs} dispatcher(s); poll ${opts.poll}s${opts.dryRun ? '; dry run' : ''}`,
  );
  if (opts.once) {
    await w.pass_();
    return 0;
  }
  const ac = new AbortController();
  let stopping = false;
  let wakeNow = null;
  const wake = () => wakeNow?.();
  const onSig = (sig) => {
    if (stopping) return;
    stopping = true;
    w.say(`${sig}: stopping (dispatchers it started drain on their own SIGTERM)`);
    ac.abort();
    wake();
  };
  process.on('SIGTERM', onSig);
  process.on('SIGINT', onSig);
  // the stream: reconnect with backoff, forever; it only ever wakes the loop
  (async () => {
    let delay = 5;
    while (!stopping) {
      try {
        const h = await authHeaders(wenv);
        await followStream(`${cfg.graphUrl.replace(/\/$/, '')}/work/stream`, h, wake, { signal: ac.signal, fetchImpl: deps.fetchImpl });
        delay = 5;
      } catch (e) {
        if (stopping) break;
        w.say(`work stream: ${e.message}; reconnecting in ${delay}s (the ${opts.poll}s poll carries on)`);
      }
      await new Promise((r) => setTimeout(r, delay * 1000));
      delay = Math.min(delay * 2, 300);
    }
  })();
  let lastRun = 0;
  while (!stopping) {
    // coalesce a burst of stream frames into one lobby read, and never read faster than MIN_POLL
    const since = w.d.now() - lastRun;
    if (since < MIN_POLL) await new Promise((r) => setTimeout(r, (MIN_POLL - since) * 1000));
    if (stopping) break;
    lastRun = w.d.now();
    await w.pass_();
    await new Promise((r) => {
      const t = setTimeout(r, opts.poll * 1000);
      wakeNow = () => {
        clearTimeout(t);
        r();
      };
    });
    wakeNow = null;
  }
  process.off('SIGTERM', onSig);
  process.off('SIGINT', onSig);
  return 0;
}
