// Layer A — what an agent may DO. A pure function of the action text.
//
// This layer is the security-critical half and it is deliberately the half
// that needs no state at all: patterns matched against what the agent is about
// to run, nothing read, nothing written. That is what lets it FAIL CLOSED
// while the spend checks fail open. v1 got this exactly backwards — the daemon
// held both, so when it was down (which, on the machine this was found on, was
// its normal state) `curl | sh` and `rm -rf` sailed through along with the
// budget. Deleting the state directory turned every rule off.
//
// Keep the invariant when editing: nothing in this file may import the store,
// read a file, or touch the network. If a rule ever needs to know what the
// agent has spent, it belongs in economics.mjs, not here.

import { Verdict, CAPABILITY } from './verdict.mjs';
import { isOn, isOff } from './bool.mjs';
import { toolMatches, nativeField } from './tools.mjs';
import { ruleCode } from './codes.mjs';
import { SETTINGS_PATHS } from './worker.mjs';

// PowerShell-native spellings. Parameters may be abbreviated to any unambiguous
// prefix (-r, -rec, -fo), so the flags are matched as prefixes.
const PS_FETCH = '(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|downloadstring)';
const PS_IEX = '(?:iex|invoke-expression)';
const PS_WRITE = '(?:set-content|out-file|add-content|clear-content|tee-object|sc|ac)';
// Windows paths use a backslash; the shared settings paths use a slash.
const SETTINGS_ANY = SETTINGS_PATHS.replace(/\\\//g, '[\\\\/]');

// `action` is the text a rule matches; `tool` scopes it ('' means any tool).
// `field` names the input key a rewrite edits. Both are in the core's own
// vocabulary (tools.mjs): `shell` and `command`, not Claude Code's `Bash` --
// which a rule may still say, and which still means the same thing.
//
// `id` is the rule's name in a TENANT POLICY: the governor asks Enforcer about
// `agent_action` resources whose id is this, so a policy can say "deploy.publish
// needs an elevated account" without matching command text itself. Ids are a
// published vocabulary — renaming one silently detaches every policy written
// against it, so add new ones rather than rename. `authz` is the action the
// question is asked as: read or write. Not manage: the platform's owner
// baseline never grants `manage`, so for an ordinary user every manage question
// is refused by the platform before the tenant policy is consulted at all. The
// rule id already tells a policy WHICH action this is; the verb only has to get
// the question past the platform.
export const DEFAULT_RULES = [
  {
    id: 'shell.pipe_to_shell',
    authz: 'write',
    name: 'download a script from the internet and run it straight away (curl | sh)',
    tool: 'shell',
    action: 'deny',
    // Judged on the stripped, tokenised pipeline (sudo/env/nohup/... removed),
    // so a sudo'd shell, a tee in the middle, a bare interpreter and a decoded
    // payload are the same shape as the plain one; process and command
    // substitution into a shell are covered too.
    match:
      '(?:(?:curl|wget)\\b|base64\\s+(?:-d|--decode)\\b)[^|;&\\n]*(?:\\|[^|;&\\n]*)*?\\|\\s*(?:(?:(?:ba|z|fi|da|k|a)?sh)\\b|(?:python[\\d.]*|perl|ruby|node|php)\\b(?=\\s*(?:-\\s*)?(?:$|[|;&)])))' +
      '|\\b(?:ba|z|da|k)?sh\\s+(?:-\\S+\\s+)*<\\(\\s*(?:curl|wget)\\b' +
      '|(?:^|[\\s;&|(])(?:\\.|source)\\s+<\\(\\s*(?:curl|wget)\\b' +
      '|\\b(?:(?:ba|z|da|k)?sh\\s+-\\w*c|eval)\\s+["\']?(?:\\$\\(|`)\\s*(?:curl|wget)\\b' +
      // PowerShell: iex fed by a fetch, as an argument or down a pipe.
      '|(?:^|[\\s;&|(])' +
      PS_IEX +
      '\\b[^;&\\n]*\\b' +
      PS_FETCH +
      '\\b' +
      '|\\b' +
      PS_FETCH +
      '\\b[^;&\\n]*\\|\\s*' +
      PS_IEX +
      '\\b',
  },
  // A shell command that writes to plugin or governor settings: a PowerShell
  // writer cmdlet or a redirection whose operands name a settings path.
  {
    id: 'governor.settings',
    authz: 'write',
    name: "change Enforcer's own settings",
    tool: 'shell',
    action: 'deny',
    match: '(?:(?:^|[\\s;&|(])' + PS_WRITE + '\\b|[^0-9&<]>{1,2}(?!&))[^;&\\n]*?(?:^|[\\s"\'=/\\\\])(?:' + SETTINGS_ANY + ')',
  },

  // Moving, deleting, relinking or changing the mode of the governor's own
  // directory: one `chmod 000` there once made config.json unreadable and the
  // rules fell back to off. store.mjs now keeps them on in that case, and this
  // asks before the attempt. Matches ~/.config/enforcer, its governor
  // directory and anything under it, the pre-2.10 ~/.enforcer-governor, and
  // $GOVERNOR_HOME.
  {
    id: 'governor.home',
    authz: 'write',
    name: "move, delete or change access to Enforcer's own folder",
    tool: 'shell',
    action: 'ask',
    match:
      '(?:^|[\\s;&|(])(?:chmod|chown|chgrp|chattr|setfacl|mv|rm|rmdir|unlink|ln)\\s+[^;&|\\n]*?(?:\\.config[\\\\/]enforcer(?:[\\\\/]governor(?=[\\s\'"\\\\/|;&)]|$)[^\\s;&|]*)?[\\\\/]?(?=[\\s\'"|;&)]|$)|\\.enforcer-governor\\b|\\$\\{?GOVERNOR_HOME\\b)',
  },

  // A force-push is the one dangerous git action with a strictly safer form
  // that preserves the intent: --force-with-lease refuses when someone else
  // has pushed since you last fetched, which is the case that loses work.
  // Rewriting is honest here in a way it would not be for, say, turning a
  // kubectl delete into --dry-run — that does not do what was asked at all.
  {
    id: 'git.force_push',
    authz: 'write',
    name: 'overwrite work other people saved online (git force-push)',
    tool: 'shell',
    action: 'rewrite',
    // Judged per segment (never across `&&`), anchored at the segment's `git`,
    // case-sensitive (`-F` is not `-f`), flag-cluster aware (`-uf`), and
    // tolerant of `git -C dir` / `git -c k=v` before `push`.
    scope: 'segment',
    cs: true,
    field: 'command',
    match: '^git\\s+(?:(?:-[Cc]\\s+\\S+|-\\S+)\\s+)*push\\s+(?:.*\\s)?(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\\s|$)',
    replace: [
      '(?<=\\spush\\s(?:.*\\s)?)(?:--force|-([a-zA-Z]*)f([a-zA-Z]*))(?=\\s|$)',
      (m, a, b) => ((a || '') + (b || '') ? `-${a || ''}${b || ''} ` : '') + '--force-with-lease',
    ],
    why: 'a plain force-push can overwrite work other people saved online, so Enforcer added a safety check (--force-with-lease) that stops the push if anyone else has pushed since you last fetched',
  },

  {
    id: 'fs.delete_tree',
    authz: 'write',
    name: 'permanently delete a folder and everything in it (rm -rf)',
    tool: 'shell',
    action: 'ask',
    // Any spelling of recursive + force, split across flags or not:
    // -rf, -fr, -r -f, -R --force, --recursive -f.
    match:
      '\\brm\\s+(?=(?:[^;&|\\n]*\\s)?(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)(?=\\s|$))(?=(?:[^;&|\\n]*\\s)?(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\\s|$))' +
      // PowerShell: Remove-Item and its aliases, -Recurse and -Force in any
      // order, abbreviated or not.
      '|(?:^|[\\s;&|(])(?:remove-item|ri|del|erase|rd|rmdir|rm)\\s+(?=(?:[^;&|\\n]*\\s)?-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?(?=[\\s:]|$))(?=(?:[^;&|\\n]*\\s)?-f(?:o(?:r(?:ce?)?)?)?(?=[\\s:]|$))',
  },
  {
    id: 'git.rewrite_history',
    authz: 'write',
    name: "erase recent changes or rewrite the project's history (git reset --hard or filter-branch)",
    tool: 'shell',
    action: 'ask',
    // Anchored at the command (wrappers are already stripped, `-C dir` and
    // other options may sit before the verb), so a mention is not a rewrite:
    // `grep -n "reset --hard" README.md` is a search, not a reset.
    match: '^git\\s+(?:(?:-[Cc]\\s+\\S+|-\\S+)\\s+)*(?:reset\\s+--hard|filter-branch)',
  },
  // Credentials: a shell command that READS OR WRITES a credentials file (the
  // path is an operand of a reading/writing verb or a redirection), or an
  // edit/write whose TARGET is one. Not a mention: until 1.0.3 this rule
  // matched the characters ".env" anywhere in any tool's input, so a worker
  // whose task was "copy .env into worktrees" was asked on every command,
  // every edit and even its graph_report — and a headless worker's ask is a
  // denial (2026-10-05, dispatcher-worktree-include, three attempts).
  {
    id: 'secrets.access',
    authz: 'read',
    name: 'read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
    tool: 'shell',
    field: 'command',
    action: 'ask',
    match:
      '(?:^|[\\s;&|(`])(?:cat|less|more|head|tail|cp|mv|scp|rsync|source|\\.|tee|sed|awk|cut|base64|xxd|od|strings|curl|wget|gh|printf|echo|vim?|nano|cmp|diff|gpg|openssl|python3?|node|grep|egrep|fgrep|rg|ag|bat|tac|nl|find|perl|ruby|php)\\s+(?:[^|;&\\n]*?[\\s\'"=/])?(?:\\.env(?:\\.[\\w-]+)?|id_rsa\\w*|id_ed25519\\w*|[\\w.-]+\\.pem|credentials\\.json|\\.npmrc|\\.netrc|\\.git-credentials|\\.pgpass|policy-cache\\.json)(?=[\\s\'"|;&)]|$)|(?:\\.(?:aws|ssh)|~/\\.enforcer)/|[<>]{1,2}\\s*[^|;&\\s]*(?:\\.env(?:\\.[\\w-]+)?|id_rsa|id_ed25519|\\.pem\\b|credentials\\.json|\\.npmrc|\\.netrc|\\.git-credentials|\\.pgpass|policy-cache\\.json|\\.aws/|\\.ssh/|\\.enforcer/)',
  },
  {
    id: 'secrets.edit',
    authz: 'write',
    name: 'read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
    tool: '',
    field: 'path',
    action: 'ask',
    match:
      '(?:^|/)(?:\\.env(?:\\.[\\w-]+)?|id_rsa\\w*|id_ed25519\\w*|[\\w.-]+\\.pem|credentials\\.json|\\.npmrc|\\.netrc|\\.git-credentials|\\.pgpass|policy-cache\\.json)$|(?:^|/)\\.(?:aws|ssh|enforcer)/',
  },
  // Enforcer MCP writes. enforcer_api_write can reach any route and the
  // agent_credential_* tools mint or revoke credentials; both were ungated.
  // Headless there is nobody to ask, so these are refused outright, except a
  // graph route from a session that carries GRAPH_ID (see graphRoute).
  {
    id: 'enforcer.api_write',
    authz: 'write',
    headless: 'deny',
    graphExempt: true,
    name: 'change data in your Enforcer workspace',
    tool: '',
    action: 'ask',
    match: '^mcp__[\\w-]*__enforcer_api_write:',
  },
  {
    id: 'enforcer.credential',
    authz: 'write',
    headless: 'deny',
    name: 'create, replace or cancel a login key for an AI agent',
    tool: '',
    action: 'ask',
    match: '^mcp__[\\w-]*__agent_credential_(?:issue|rotate|revoke)\\w*:',
  },
  // graph_decide decides a node (a gate, or a validation run): a write with the capability of graph_review's approve.
  // A person decides it; a headless worker never does.
  {
    id: 'enforcer.graph_decide',
    authz: 'write',
    headless: 'deny',
    name: 'approve or reject a step in an Enforcer work plan',
    tool: '',
    action: 'ask',
    match: '^mcp__[\\w-]*__graph_decide:',
  },
  {
    id: 'deploy.publish',
    authz: 'write',
    name: 'publish or put something live for other people to use (npm publish, vercel --prod, kubectl apply, terraform apply)',
    tool: 'shell',
    action: 'ask',
    // Anchored at the command. Unanchored, the words matched anywhere in a
    // segment, and on one machine every one of the 35 shadow hits in a
    // fortnight (2026-10-23) was a `grep "terraform apply"` over docs or
    // workflows, a `tail | grep` of a roll log, or a Makefile search - no
    // deploy among them. A deploy starts its own command.
    match: '^(?:npm\\s+publish|vercel\\s+.*--prod|kubectl\\s+(?:apply|delete)|terraform\\s+(?:-chdir=\\S+\\s+)?apply)',
  },
];

/**
 * A rule's policy id. A custom rule in config.json may not carry one, so it is
 * derived from the name — stable for as long as the name is, which is the most
 * a rule without an explicit id can promise.
 */
export function ruleId(rule) {
  if (rule?.id) return String(rule.id);
  return (
    'custom.' +
    String(rule?.name || 'rule')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  );
}

/** The authorization action a rule is asked about. Unknown means the widest. */
export function ruleAuthz(rule) {
  return rule?.authz === 'read' ? 'read' : 'write';
}

const warned = new Set();
/** Why a rule is unusable, or null. Shape plus regex compile. */
export function ruleProblem(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (typeof r.match !== 'string' || !r.match) return 'match must be a non-empty string';
  if (r.tool != null && typeof r.tool !== 'string') return 'tool must be a string';
  try {
    new RegExp(r.match, 'i');
  } catch (e) {
    return `match is not a valid regex (${e.message})`;
  }
  return null;
}

/**
 * The rules this config means. Bad rules are dropped with one stderr line each
 * (naming the rule); good ones still apply. A non-empty list with NO usable
 * rule is a broken config, not "no rules": that throws, and the hook denies.
 */
export function resolveRules(cfg = {}) {
  if (isOff(cfg.rulesOn)) return [];
  if (cfg.rules == null) return DEFAULT_RULES;
  if (!Array.isArray(cfg.rules)) throw new Error('config.rules is not an array');
  const good = [];
  cfg.rules.forEach((r, i) => {
    const why = ruleProblem(r);
    if (!why) return good.push(r);
    let shown;
    try {
      shown = JSON.stringify(r);
    } catch {
      shown = String(r);
    }
    const line = `enforcer-governor: invalid rule #${i} ${shown}: ${why}; skipped`;
    if (!warned.has(line)) {
      warned.add(line);
      try {
        process.stderr.write(line + '\n');
      } catch {}
    }
  });
  if (cfg.rules.length && !good.length) throw new Error('config.rules has no valid rule');
  return good;
}

// ---- shell tokeniser -------------------------------------------------------
// A rule is judged on every command the text contains, not on the text as one
// string: split on ; && || | & and newlines (outside quotes and $( ) ), peel
// the wrappers that change nothing about WHAT runs (env, sudo, nohup, time,
// xargs, bash -c ...), and look inside $(...), `...`, <(...) and -c strings.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
// wrapper -> the options that take a separate argument
const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'],
  env: ['-u', '-C', '-S'],
  nohup: [],
  time: ['-f', '-o'],
  command: [],
  exec: ['-a'],
  builtin: [],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  setsid: [],
  timeout: ['-s', '-k'],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-l'],
};
const MAX_DEPTH = 5,
  MAX_SEGS = 400;

function words(seg) {
  const out = [];
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) break;
    const start = i;
    let w = '';
    let q = null;
    while (i < seg.length && (q || !/\s/.test(seg[i]))) {
      const c = seg[i];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"' && i + 1 < seg.length) w += seg[++i];
        else w += c;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '\\' && i + 1 < seg.length) w += seg[++i];
      else w += c;
      i++;
    }
    out.push({ w, start });
  }
  return out;
}

// Peel wrappers off one segment. Returns the command that actually runs plus
// any -c strings found on the way.
function strip(seg) {
  const inner = [];
  let text = seg.replace(/^[\s({!]+/, '');
  for (let guard = 0; guard < 12; guard++) {
    const ws = words(text);
    let k = 0;
    while (k < ws.length && /^[A-Za-z_]\w*=/.test(ws[k].w)) k++;
    if (k >= ws.length) return { cmd: '', inner };
    const base = ws[k].w.replace(/^.*\//, '');
    if (Object.hasOwn(WRAPPERS, base)) {
      const takes = WRAPPERS[base];
      k++;
      while (k < ws.length) {
        const t = ws[k].w;
        if (/^[A-Za-z_]\w*=/.test(t)) k++;
        else if (t === '--') {
          k++;
          break;
        } else if (t.startsWith('-') && t.length > 1) k += takes.includes(t) ? 2 : 1;
        else break;
      }
      if (base === 'timeout' && k < ws.length && /^[\d.]+[smhd]?$/.test(ws[k].w)) k++;
      if (k >= ws.length) return { cmd: '', inner };
      text = text.slice(ws[k].start);
      continue;
    }
    if (SHELLS.has(base)) {
      for (let m = k + 1; m < ws.length; m++) {
        const t = ws[m].w;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
          if (ws[m + 1]) inner.push(ws[m + 1].w);
          break;
        }
        if (!t.startsWith('-')) break;
      }
    }
    return { cmd: text.slice(ws[k].start), inner };
  }
  return { cmd: text, inner };
}

// Index just past the ')' that closes a '(' already consumed at text[from-1].
function closeParen(text, from) {
  let i = from,
    d = 1,
    q = null;
  while (i < text.length && d) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i++;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\') i++;
    else if (c === '(') d++;
    else if (c === ')') d--;
    i++;
  }
  return i;
}

// Split text into top-level segments, noting which are joined by a pipe, and
// collect $( ) / ` ` / <( ) bodies. Quotes and substitutions are atomic.
function split(text) {
  const segs = [];
  const subs = [];
  let q = null,
    start = 0,
    i = 0;
  const push = (end, sep) => {
    segs.push({ start, end, sep });
  };
  while (i < text.length) {
    const c = text[i],
      n = text[i + 1];
    if (q === "'") {
      if (c === "'") q = null;
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      const e = text.indexOf('`', i + 1);
      subs.push(text.slice(i + 1, e < 0 ? text.length : e));
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if ((c === '$' || (!q && (c === '<' || c === '>'))) && n === '(') {
      const e = closeParen(text, i + 2);
      subs.push(text.slice(i + 2, Math.max(i + 2, e - 1)));
      i = e;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      i++;
      continue;
    }
    if (c === ';' || c === '\n') {
      push(i, ';');
      i++;
      start = i;
      continue;
    }
    if (c === '|') {
      if (n === '|') {
        push(i, ';');
        i += 2;
      } else {
        push(i, '|');
        i += n === '&' ? 2 : 1;
      }
      start = i;
      continue;
    }
    if (c === '&') {
      const p = text[i - 1];
      if (n === '&') {
        push(i, ';');
        i += 2;
        start = i;
        continue;
      }
      if (p === '>' || p === '<' || n === '>') {
        i++;
        continue;
      }
      push(i, ';');
      i++;
      start = i;
      continue;
    }
    i++;
  }
  push(text.length, ';');
  return { segs: segs.filter((s) => text.slice(s.start, s.end).trim()), subs };
}

/** Every command in `text`: [{raw, start, end, cmd, top}] and the pipelines, as joined strings. */
export function commands(text) {
  const out = [];
  const pipes = [];
  const walk = (t, top, depth) => {
    if (depth > MAX_DEPTH || out.length > MAX_SEGS) return;
    const { segs, subs } = split(t);
    let run = [];
    const flush = () => {
      if (run.length > 1) pipes.push(run.join(' | '));
      run = [];
    };
    for (const s of segs) {
      const raw = t.slice(s.start, s.end);
      const { cmd, inner } = strip(raw);
      out.push({ raw, start: s.start, end: s.end, cmd, top });
      run.push(cmd);
      if (s.sep !== '|') flush();
      for (const x of inner) walk(x, false, depth + 1);
    }
    flush();
    for (const x of subs) walk(x, false, depth + 1);
  };
  walk(String(text || ''), true, 0);
  return { commands: out, pipelines: pipes };
}

const STRICT = { deny: 3, ask: 2, rewrite: 1 };
const strictness = (r) => STRICT[r.action] ?? 2; // an unknown action is treated as an ask

function compile(r) {
  try {
    return new RegExp(r.match, r.cs ? '' : 'i');
  } catch {
    return null;
  } // a bad pattern must not break the check
}

/**
 * Every rule on every command; the strictest hit wins (deny > ask > rewrite),
 * the earlier rule on a tie. Returns {rule, segs} (segs: the top-level commands
 * a segment-scoped rule hit, which a rewrite edits) or null.
 */
// A graph route called from a session that holds a graph (GRAPH_ID).
function graphRoute(ev) {
  if (!ev?.worker?.graphId) return false;
  const p = String(ev.raw?.path ?? ev.input?.path ?? ev.raw?.url ?? '');
  return /^\/?graphs?(?:\/|$|\?)/i.test(p.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/(?:api\/)?(?:v\d+\/)?/, '/'));
}

function scan(rules, ev) {
  const text = String(ev.action || '');
  const cache = new Map(); // command analysis per subject text
  let best = null;
  for (const r of rules || []) {
    if (!toolMatches(r.tool, ev)) continue;
    if (r.graphExempt && graphRoute(ev)) continue;
    const re = compile(r);
    if (!re) continue;
    // A rule that names a field matches THAT field only (the canonical one,
    // else the harness's own key), never the whole input: ".env" inside a
    // report or a test fixture is not a credential access.
    const subject = r.field ? fieldText(r.field, ev) : text;
    const shell = (!r.field || r.field === 'command') && toolMatches('shell', ev);
    let segs = null; // null: no hit
    if (!shell) {
      if (re.test(subject)) segs = [];
    } else {
      const body = r.field ? subject : subject.replace(/^[\w.-]+:/, '');
      if (!cache.has(body)) cache.set(body, commands(body));
      const { commands: cmds, pipelines } = cache.get(body);
      const hits = cmds.filter((c) => c.cmd && re.test(c.cmd));
      if (hits.length) segs = r.scope === 'segment' && hits.some((c) => !c.top) ? [] : hits.filter((c) => c.top);
      else if (r.scope !== 'segment' && (re.test(subject) || pipelines.some((p) => re.test(p)))) segs = [];
    }
    if (segs && (!best || strictness(r) > strictness(best.rule))) best = { rule: r, segs };
  }
  return best;
}

/** The strictest rule that fires on any command in the action. Null when nothing matches. */
export function matchRule(rules, ev) {
  return scan(rules, ev)?.rule ?? null;
}

function fieldText(field, ev) {
  const canon = ev?.input?.[field];
  if (typeof canon === 'string') return canon;
  const key = nativeField(field, ev);
  const raw = ev?.raw?.[key];
  return typeof raw === 'string' ? raw : '';
}

// Build the replacement input for a rewrite rule. Returns null when the edit
// would not actually change anything, which demotes the rule to an ask:
// claiming to have made something safer without having done so is worse than
// admitting the pattern was not handled.
//
// The rewrite is made to the harness's OWN input (`ev.raw`), with the rule's
// field translated to the harness's key, so what comes back is exactly what
// the harness runs -- every other key it sent (a description, a timeout) kept
// as it was. A caller that sends no raw input is rewritten in `ev.input`.
// A segment-scoped rule edits ONLY the commands it hit, never the rest of the
// line, and not at all (an ask) when a hit is nested inside a -c string or
// substitution, where the splice position is not the harness's text.
function rewriteInput(rule, ev, segs) {
  if (!rule.replace || !rule.field) return null;
  const input = ev.raw ?? ev.input;
  const key = nativeField(rule.field, ev);
  const before = input?.[key];
  if (typeof before !== 'string') return null;
  let re;
  try {
    re = new RegExp(rule.replace[0], rule.cs ? 'g' : 'gi');
  } catch {
    return null;
  }
  let after;
  if (rule.scope === 'segment') {
    if (!segs?.length || before !== fieldText(rule.field, ev)) return null;
    after = before;
    for (const s of [...segs].sort((a, b) => b.start - a.start)) {
      const piece = s.raw.replace(re, rule.replace[1]);
      after = after.slice(0, s.start) + piece + after.slice(s.end);
    }
  } else after = before.replace(re, rule.replace[1]);
  return after === before ? null : { ...input, [key]: after };
}

/**
 * Evaluate the capability layer.
 * @returns {Verdict|null} null means "no rule had an opinion" — NOT "allowed".
 *   The caller decides what silence means; here it only ever means this layer
 *   is finished, and economics still gets its turn.
 */
export function evaluate(rules, ev) {
  const found = scan(rules || DEFAULT_RULES, ev);
  if (!found) return null;
  const hit = found.rule;
  const of = { source: CAPABILITY, rule: hit.name, checked: [CAPABILITY], code: ruleCode(hit), ruleId: ruleId(hit) };

  if (hit.action === 'deny') {
    // Refuse the ACTION, do not stop the agent. A capability check says "not
    // that", never "you are finished" — stopping here once meant a single
    // blocked command silently turned every later verdict into "agent stopped".
    return Verdict.deny(`the AI is not allowed to ${hit.name}`, of);
  }

  if (hit.action === 'rewrite') {
    const input = rewriteInput(hit, ev, found.segs);
    if (input) return Verdict.rewrite(input, hit.why || `it would ${hit.name}`, of);
    return Verdict.ask(`would ${hit.name}`, of); // could not make it safer; ask instead
  }

  if (hit.headless === 'deny' && ev.worker?.headless) return Verdict.deny(`the AI is not allowed to ${hit.name} when nobody is there to approve it`, of);

  // Deliberately does not latch anything: every separate dangerous action
  // deserves its own answer, not one blanket approval for the session.
  return Verdict.ask(`would ${hit.name}`, of);
}
