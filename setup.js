#!/usr/bin/env node
/**
 * setup.js — point Claude Code at OpenRouter models.
 *
 * Works for the CLI and the VSCode extension at once, because both read the
 * `env` block in ~/.claude/settings.json.
 *
 *     default / background : WANTED.a
 *     opus slot            : WANTED.b, for /model opus
 *
 * There is no proxy, no daemon and no background service. OpenRouter serves the
 * Anthropic Messages API natively at https://openrouter.ai/api/v1/messages, so
 * Claude Code talks to it directly. Earlier versions of this script routed
 * through Claude Code Router; that added a native SQLite dependency, a port, a
 * process to keep alive and an autostart entry, every one of which was a way
 * for the install to fail. None of it was necessary.
 *
 * Usage:
 *   node setup.js --key sk-or-v1-...   # install
 *   OPENROUTER_API_KEY=sk-or-v1-... node setup.js
 *   node setup.js --status             # what is configured
 *   node setup.js --doctor             # diagnose, change nothing
 *   node setup.js --off                # back to your Anthropic account
 *   node setup.js --on                 # back to OpenRouter
 *   node setup.js --uninstall          # restore the newest backup
 *   node setup.js --no-verify          # skip the live test request
 *   node setup.js --no-language-hint   # do not add the English-replies note to CLAUDE.md
 *   node setup.js --reliable           # use the pricier of the two models as the default
 *   node setup.js --efficient          # token-saving setup: reply compression + plain
 *                                      # language rules (same as --extras)
 *   node setup.js --extras             # also install caveman + a plain-language CLAUDE.md
 *                                      # (off by default: they change how the model is
 *                                      #  instructed, and a small model can go silent)
 *   node setup.js --no-launch          # do not start Claude Code when finished
 *   node setup.js --no-autoupdate      # do not check GitHub for updates at session start
 *   node setup.js --version            # installed version vs GitHub
 *   node setup.js --trim               # see/disable MCP servers (they cost tokens every request)
 *   node setup.js --untrim             # put the MCP servers back
 *   node setup.js --usage              # token and spend totals
 *   node setup.js --usagelog           # log per-turn tokens to a file (off by default)
 *   node setup.js --quiet              # no output except warnings (used by the updater)
 *
 * Requires Node >= 18 (global fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Checked against the live catalogue at install time. If a slug is retired, the
// fuzzy terms find the closest surviving model rather than writing a config
// that fails on the first prompt.
//
// a is the default, b is /model opus. That is the owner's choice, not a price
// ranking: MiMo is the pricier of the two and is still the default.
const WANTED = {
  a: {
    label: 'MiMo V2.6 Pro',
    slug: 'xiaomi/mimo-v2.6-pro',
    fuzzy: ['mimo', 'v2.6', 'pro'],
  },
  b: {
    label: 'GPT-6 Luna',
    slug: 'openai/gpt-6-luna',
    fuzzy: ['gpt-6', 'luna'],
  },
};

const API_ROOT = 'https://openrouter.ai/api';
const MODELS_URL = `${API_ROOT}/v1/models`;
const MESSAGES_URL = `${API_ROOT}/v1/messages`;

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const STATUSLINE = path.join(CLAUDE_DIR, 'statusline-openrouter.js');
const AUTOUPDATE = path.join(CLAUDE_DIR, 'hooks', 'openrouter-autoupdate.js');
const REPO = 'djerok/claude-openrouter';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const STATE_FILE = path.join(CLAUDE_DIR, 'openrouter-setup-state.json');
// Older installs wrote this name; still read it so --on keeps working.
const LEGACY_STATE_FILE = path.join(CLAUDE_DIR, 'ccr-openrouter-state.json');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

let step = 0;
// --quiet exists for the auto-update hook, which reinstalls in the background
// and must not scribble over a live terminal. Warnings still print.
const QUIET = argv.includes('--quiet');
const out = (m) => { if (!QUIET) console.log(m); };
const say = (m) => out(`${C.cyan}[${++step}]${C.reset} ${m}`);
const ok = (m) => out(`    ${C.green}ok${C.reset}   ${m}`);
const warn = (m) => console.log(`    ${C.yellow}warn${C.reset} ${m}`);
const info = (m) => out(`    ${C.dim}${m}${C.reset}`);

function die(msg, hint) {
  console.error(`\n${C.red}fatal:${C.reset} ${msg}`);
  if (hint) console.error(`${C.dim}${hint}${C.reset}`);
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    die(`${file} is not valid JSON: ${err.message}`, 'Fix or delete it, then re-run.');
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Write a file this script generates, refusing to write it if it is not valid
 * JavaScript.
 *
 * These files are built from template literals inside this one, so an escaping
 * mistake here produces a syntactically broken hook that fails on every single
 * turn — which is exactly what happened: a newline escape collapsed into a real
 * line break inside a string, and the Stop hook errored for everyone who
 * installed it. The generator cannot be trusted to be correct by inspection, so
 * it is checked before it reaches disk.
 */
function writeGenerated(file, source, label) {
  // Drop a leading shebang, which is valid in a script but not in a Function body.
  const lines = source.split(String.fromCharCode(10));
  if (lines[0].startsWith('#!')) lines.shift();
  const body = lines.join(String.fromCharCode(10));
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
  } catch (err) {
    die(
      `generated ${label} is not valid JavaScript: ${err.message}`,
      `This is a bug in the installer, not in your setup. Please report it at https://github.com/${REPO}/issues`
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function run(cmd, args, opts = {}) {
  // Windows needs a shell to run .cmd/.ps1 shims. Node deprecated passing an
  // args array together with shell:true (DEP0190) because it concatenates them
  // unescaped, so when a shell is required the command line is built and quoted
  // here and the args array is left empty.
  const needsShell = IS_WIN && !/\.exe$/i.test(cmd);
  let file = cmd;
  let list = args;
  if (needsShell) {
    const quote = (a) => (/[\s&|<>^"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    file = [quote(cmd), ...args.map(quote)].join(' ');
    list = [];
  }
  const res = spawnSync(file, list, { encoding: 'utf8', shell: needsShell, ...opts });
  return {
    code: res.status === null ? 1 : res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    die(
      `Node ${process.versions.node} is too old (need >= 18 for global fetch).`,
      'Install Node 18+ from https://nodejs.org, or use install.ps1 / install.sh which do it for you.'
    );
  }
  ok(`node ${process.versions.node}`);
}

/** Returns { version, path } for Claude Code, or null. */
function probeClaude() {
  const res = run('claude', ['--version']);
  if (res.code === 0 && res.stdout) {
    // Resolve the real file so the path printed at the end is something the
    // user can actually click, copy or hand to a bug report.
    const which = IS_WIN ? run('where', ['claude']) : run('which', ['claude']);
    const resolved = which.code === 0 && which.stdout ? which.stdout.split('\n')[0].trim() : 'claude';
    return { version: res.stdout.split('\n')[0], path: resolved };
  }
  const prefix = run('npm', ['prefix', '-g']).stdout;
  if (prefix) {
    const cands = IS_WIN
      ? [path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude')]
      : [path.join(prefix, 'bin', 'claude'), path.join(prefix, 'claude')];
    for (const c of cands) {
      if (!fs.existsSync(c)) continue;
      const r = run(c, ['--version']);
      if (r.code === 0 && r.stdout) return { version: r.stdout.split('\n')[0], path: c };
    }
  }
  return null;
}

function ensureClaudeCode() {
  const v = probeClaude();
  if (v) {
    ok(`Claude Code present (${v.version})`);
    return v;
  }

  info('Claude Code not found — installing @anthropic-ai/claude-code globally');
  const res = run('npm', ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit' });
  if (res.code !== 0) {
    die(
      `npm install -g @anthropic-ai/claude-code failed (exit ${res.code}).`,
      IS_WIN
        ? 'If this is a permissions error, reopen the terminal as Administrator, or:\n  npm config set prefix "%LOCALAPPDATA%\\npm"'
        : 'Try sudo, or:\n  npm config set prefix "$HOME/.npm-global"'
    );
  }
  const after = probeClaude();
  if (!after) {
    die(
      'Claude Code installed but is not runnable.',
      `Add your npm global bin directory to PATH and open a new terminal:\n  ${run('npm', ['prefix', '-g']).stdout}`
    );
  }
  ok(`Claude Code installed (${after.version})`);
  return after;
}

// ---------------------------------------------------------------------------
// Key and models
// ---------------------------------------------------------------------------

function resolveKey() {
  // No baked-in default: a key inside a script is a key in someone's git history.
  const prev = readJson(CLAUDE_SETTINGS, {});
  const reused =
    prev.env && typeof prev.env.ANTHROPIC_AUTH_TOKEN === 'string' &&
    prev.env.ANTHROPIC_AUTH_TOKEN.startsWith('sk-or-')
      ? prev.env.ANTHROPIC_AUTH_TOKEN
      : null;

  const key = flagValue('--key') || process.env.OPENROUTER_API_KEY || reused;
  if (!key) {
    die('No OpenRouter API key.', [
      'Get one at https://openrouter.ai/keys (and put a few dollars of credit on it), then:',
      '  node setup.js --key sk-or-v1-...',
      '  OPENROUTER_API_KEY=sk-or-v1-... node setup.js',
    ].join('\n'));
  }
  if (!/^sk-or-v1-[0-9a-f]{16,}$/i.test(key)) {
    die('That does not look like an OpenRouter key (expected sk-or-v1-...).');
  }
  if (!flagValue('--key') && !process.env.OPENROUTER_API_KEY) {
    info('reusing the OpenRouter key already in your settings');
  }
  return key;
}

/**
 * Confirm the key actually works before writing it anywhere.
 *
 * The catalogue endpoint is public, so it answers 200 for a dead key and the
 * install would finish "successfully" with a configuration that cannot make a
 * single request. /v1/key requires auth, so it is the honest check.
 */
async function checkKey(key) {
  let res;
  try {
    res = await fetch(`${API_ROOT}/v1/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    warn(`could not reach OpenRouter to check the key: ${err.message}`);
    return;
  }

  if (res.ok) {
    const d = (await res.json()).data || {};
    const spent = Number(d.usage || 0);
    const left = d.limit_remaining;
    ok(
      `key accepted${left != null ? ` — $${Number(left).toFixed(2)} of credit left` : ''}` +
        `${spent ? ` (spent $${spent.toFixed(2)})` : ''}`
    );
    if (left != null && Number(left) <= 0) {
      warn('that key has no credit left, so every request will fail until you top it up');
    }
    return;
  }

  let detail = '';
  try {
    detail = ((await res.json()).error || {}).message || '';
  } catch {}

  if (res.status === 401) {
    die(
      `OpenRouter rejected the key (401${detail ? ': ' + detail : ''}).`,
      /user not found/i.test(detail)
        ? [
            'That key no longer exists, or its account is disabled or closed.',
            'Create a new one at https://openrouter.ai/keys and re-run with --key.',
            'This is not a problem with your setup: the same key fails against curl too.',
          ].join(String.fromCharCode(10))
        : 'The key is invalid, revoked, or out of credit. Check https://openrouter.ai/keys'
    );
  }
  warn(`could not verify the key (HTTP ${res.status}) — continuing`);
}

async function fetchCatalogue(key) {
  let res;
  try {
    res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    die(`Could not reach openrouter.ai: ${err.message}`,
      'Check your network. Behind a proxy, set HTTPS_PROXY before running.');
  }
  if (res.status === 401) {
    // OpenRouter answers a deleted key, or one whose account no longer resolves,
    // with "User not found" rather than anything about the key — which reads
    // like a bug in whatever is calling it. Name it plainly.
    let detail = '';
    try {
      detail = ((await res.json()).error || {}).message || '';
    } catch {}
    die(
      `OpenRouter rejected the key (401${detail ? ': ' + detail : ''}).`,
      /user not found/i.test(detail)
        ? [
            'That key no longer exists, or its account is disabled or closed.',
            'Create a new one at https://openrouter.ai/keys and re-run with --key.',
            'This is not a problem with your setup: the same key fails against curl too.',
          ].join(String.fromCharCode(10))
        : 'The key is invalid, revoked, or out of credit. Check https://openrouter.ai/keys'
    );
  }
  if (!res.ok) die(`OpenRouter /models returned HTTP ${res.status}.`);
  const body = await res.json();
  if (!Array.isArray(body.data) || !body.data.length) die('OpenRouter returned an empty model list.');
  return body.data;
}

/** Blended $/M, weighted 1:3 input:output — roughly a coding session's shape. */
function blendedPrice(m) {
  const p = m.pricing || {};
  return ((Number(p.prompt) || 0) * 3 + (Number(p.completion) || 0)) * 1e6 / 4;
}

/** Does this model accept image input at all? */
function takesImages(m) {
  const a = m.architecture || {};
  const inputs = a.input_modalities || a.modality || [];
  return Array.isArray(inputs) ? inputs.includes('image') : /image/.test(String(inputs));
}

function priceLabel(m) {
  const p = m.pricing || {};
  return `$${((Number(p.prompt) || 0) * 1e6).toFixed(2)}/M in, $${((Number(p.completion) || 0) * 1e6).toFixed(2)}/M out`;
}

function pickModel(catalogue, want) {
  const exact = catalogue.find((m) => m.id === want.slug);
  if (exact) return { ...exact, matchedBy: 'exact' };

  const candidates = catalogue
    .filter((m) => !m.id.startsWith('~') && !m.id.endsWith(':batch'))
    .filter((m) => want.fuzzy.every((t) => m.id.toLowerCase().includes(t)));
  if (!candidates.length) {
    die(`OpenRouter no longer lists "${want.slug}" and nothing matches [${want.fuzzy.join(', ')}].`,
      'Edit the WANTED table at the top of this script with a current slug from https://openrouter.ai/models');
  }
  candidates.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return { ...candidates[0], matchedBy: 'fuzzy' };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Several model variables are set rather than one. Claude Code has used
 * different names across versions for the small/background model, and an
 * unrecognised variable is ignored, so setting all of them is how this keeps
 * working across upgrades instead of silently falling back to a Claude model
 * the key cannot buy.
 */
function routingEnv(key, main, opus, contextTokens) {
  return {
    ANTHROPIC_BASE_URL: API_ROOT,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_MODEL: main,
    ANTHROPIC_SMALL_FAST_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
    CLAUDE_CODE_SUBAGENT_MODEL: main,
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code only knows the context window of models in its own catalogue.
    // An OpenRouter slug is not in it, so without this it assumes 200k and
    // auto-compacts a 1.3M-token model at a sixth of its real window. The number
    // comes from the same catalogue response the models were chosen from.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens || 200000),
    // Extended thinking off. This is a correctness fix, not a preference.
    //
    // With it on, a turn that calls a tool comes back with a thinking block and
    // no text block at all: the work happens, nothing is printed. OpenRouter
    // returns thinking blocks with an empty signature, and once Claude Code
    // echoes one back on the following request the model stops producing text.
    // Reproduced on a clean machine — "run a shell command and tell me the
    // count" printed nothing, and printed the answer with this set to 0.
    //
    // It is also much cheaper. These models reason server-side regardless, and
    // in a measured request 57 of 63 output tokens were thinking.
    MAX_THINKING_TOKENS: '0',
  };
}

const ROUTING_KEYS = Object.keys(routingEnv('', '', '', 0));

function writeClaudeSettings(key, main, opus, contextTokens, mutate) {
  const prev = readJson(CLAUDE_SETTINGS, {});
  const bak = backup(CLAUDE_SETTINGS);

  const env = { ...(prev.env || {}) };
  // Remove anything a previous proxy-based install left pointing at localhost.
  if (typeof env.ANTHROPIC_BASE_URL === 'string' && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) {
    info('replacing a stale local proxy URL from an older install');
  }
  Object.assign(env, routingEnv(key, main, opus, contextTokens));

  const next = { ...prev, env };
  next.statusLine = { type: 'command', command: `"${process.execPath}" "${STATUSLINE}"`, padding: 0 };
  if (typeof mutate === 'function') mutate(next);

  if (next.model) {
    next.__parkedModel = next.model;
    delete next.model;
    info(`parked settings.model = "${next.__parkedModel}" (restored by --off)`);
  }

  writeJson(CLAUDE_SETTINGS, next);
  if (bak) info(`previous settings backed up to ${path.basename(bak)}`);
}

// ---------------------------------------------------------------------------
// Statusline
// ---------------------------------------------------------------------------

const STATUSLINE_SOURCE = String.raw`#!/usr/bin/env node
/**
 * statusline-openrouter.js — generated by setup.js. Re-run the installer to change it.
 *
 * Reads the documented status line payload on stdin and prints one line:
 *
 *   ● mimo-v2.6-pro (default) | ctx 12% | cache 91% | proj | main | v59f677b
 *
 * Every field here is one Claude Code documents for status lines
 * (context_window.used_percentage, prompt_cache.hit_ratio, cost.total_cost_usd,
 * effort.level), rather than anything this project invents. The two numbers
 * worth watching are context usage, which decides when compaction kicks in, and
 * cache hit rate, which decides whether resending the conversation every turn is
 * cheap or expensive.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m',
};

const USD = String.fromCharCode(36);

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {}
  const env = settings.env || {};
  const routed = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.includes('openrouter');

  const reported = (input.model && (input.model.id || input.model.display_name)) || '';
  const configured = env.ANTHROPIC_MODEL || '';
  const looksClaude = /^claude[-.]/i.test(reported);
  const model = routed ? (looksClaude ? configured : reported || configured) : reported || 'anthropic';
  const short = String(model).split('/').pop() || '?';
  const opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL || '';
  const tier = routed && opus && model === opus ? 'opus' : routed ? 'default' : 'anthropic';

  const parts = [];

  // caveman, when installed, writes a flag file. Show its state rather than let
  // two status lines fight over the same row.
  try {
    const level = fs.readFileSync(path.join(os.homedir(), '.claude', '.caveman-active'), 'utf8').trim();
    if (level) {
      const tag = level.toUpperCase() === 'FULL' ? '' : ':' + level.toUpperCase();
      parts.push(C.yellow + '[CAVEMAN' + tag + ']' + C.reset);
    }
  } catch {}

  parts.push(
    (routed ? C.green : C.yellow) + '*' + C.reset + ' ' +
    C.bold + short + C.reset + C.dim + ' (' + tier + ')' + C.reset
  );

  // Context window: what drives compaction.
  const cw = input.context_window || {};
  if (typeof cw.used_percentage === 'number') {
    const pct = Math.round(cw.used_percentage);
    const colour = pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.dim;
    parts.push(colour + 'ctx ' + pct + '%' + C.reset);
  }

  // Prompt cache: whether the resent conversation is billed cheaply.
  const pc = input.prompt_cache || {};
  if (pc.caching_observed && typeof pc.hit_ratio === 'number') {
    const pct = Math.round(pc.hit_ratio * 100);
    const colour = pct >= 70 ? C.green : pct >= 40 ? C.yellow : C.red;
    parts.push(colour + 'cache ' + pct + '%' + C.reset + (pc.warm ? '' : C.dim + ' cold' + C.reset));
  } else if (pc.caching_observed === false) {
    parts.push(C.dim + 'cache off' + C.reset);
  }

  const effort = (input.effort && input.effort.level) || settings.effortLevel || null;
  if (effort) parts.push(C.magenta + effort + C.reset);

  const dir = (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) || process.cwd();
  parts.push(C.blue + path.basename(dir) + C.reset);

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 400,
    }).trim();
    if (branch) parts.push(C.cyan + branch + C.reset);
  } catch {}

  const cost = input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;
  if (cost !== null && cost > 0) parts.push(C.dim + USD + cost.toFixed(4) + C.reset);

  // This project's installed version, and whether an update is pending.
  try {
    const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'openrouter-setup-state.json'), 'utf8'));
    if (st.sha) {
      const v = 'v' + String(st.sha).slice(0, 7);
      parts.push(st.outdated ? C.yellow + v + ' up!' + C.reset : C.dim + v + C.reset);
    }
  } catch {}

  process.stdout.write(parts.join(C.dim + ' | ' + C.reset));
}

try {
  main();
} catch (err) {
  process.stdout.write('\x1b[31m* statusline error\x1b[0m ' + String(err && err.message).slice(0, 60));
}
`;

function writeStatusline() {
  writeGenerated(STATUSLINE, STATUSLINE_SOURCE, 'statusline');
  ok(`statusline written to ${STATUSLINE}`);
}

// ---------------------------------------------------------------------------
// Extras: a plain-language CLAUDE.md and the token savers
// ---------------------------------------------------------------------------

// '[\s\S]' written inside a single-quoted JS string collapses to '[sS]' and
// matches only the letters s and S. Build it from character codes once and use
// it everywhere a "any character including newlines" class is needed.
const ANY_CHAR = '[' + String.fromCharCode(92) + 's' + String.fromCharCode(92) + 'S]';
const NEWLINE_RE = String.fromCharCode(92) + 'n';

const LANG_BEGIN = '<!-- BEGIN claude-openrouter: language -->';
const LANG_END = '<!-- END claude-openrouter: language -->';

// Models whose training is heavily Chinese and which drift into it mid-answer.
// Observed: a reply to an English question about a slash command came back
// entirely in Chinese, in the visible answer rather than a reasoning block.
const DRIFTS_LANGUAGE = /^(deepseek|z-ai|qwen|moonshot|baidu|01-ai|tencent)\//i;

const LANG_BODY = [
  LANG_BEGIN,
  '# Language',
  '',
  'Always write your replies in English, whatever language you reason in.',
  'This is not a style preference: the configured model is trained heavily on',
  'Chinese and will otherwise sometimes answer an English question in Chinese.',
  LANG_END,
].join(String.fromCharCode(10));

/**
 * Pin the reply language when the configured model is one that drifts.
 *
 * There is no request parameter for this — no env var, nothing in the settings
 * schema — so an instruction in CLAUDE.md is the only lever available. It is
 * written in its own marked block, separate from the optional prompt extras, so
 * it can be removed on its own and does not depend on --extras.
 */
function writeLanguageHint(modelId) {
  if (!DRIFTS_LANGUAGE.test(modelId)) return false;

  let existing = '';
  try {
    existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {}

  if (existing.includes(LANG_BEGIN)) {
    const re = new RegExp(escapeRe(LANG_BEGIN) + ANY_CHAR + '*?' + escapeRe(LANG_END), 'g');
    fs.writeFileSync(CLAUDE_MD, existing.replace(re, LANG_BODY));
    ok('refreshed the English-replies note in CLAUDE.md');
    return true;
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (existing.trim()) {
    backup(CLAUDE_MD);
    fs.writeFileSync(CLAUDE_MD, existing.replace(/\s*$/, String.fromCharCode(10, 10)) + LANG_BODY + String.fromCharCode(10));
    ok(`added an English-replies note to ${CLAUDE_MD}`);
  } else {
    fs.writeFileSync(CLAUDE_MD, LANG_BODY + String.fromCharCode(10));
    ok(`wrote ${CLAUDE_MD} with an English-replies note`);
  }
  return true;
}

function removeLanguageHint() {
  try {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    if (!md.includes(LANG_BEGIN)) return;
    // Built from character classes written out longhand. '[\s\S]' inside a
    // single-quoted JS string is just '[sS]', which silently matches the letters
    // s and S and nothing else — the block then survives every uninstall.
    const re = new RegExp(
      NEWLINE_RE + '*' + escapeRe(LANG_BEGIN) + ANY_CHAR + '*?' + escapeRe(LANG_END) + NEWLINE_RE + '*',
      'g'
    );
    const stripped = md.replace(re, String.fromCharCode(10));
    if (stripped.trim()) fs.writeFileSync(CLAUDE_MD, stripped);
    else fs.unlinkSync(CLAUDE_MD);
  } catch {}
}

const CLAUDE_MD_BEGIN = '<!-- BEGIN ccr-openrouter: plain language rules -->';
const CLAUDE_MD_END = '<!-- END ccr-openrouter -->';

// The style rules that used to live here were removed at the owner request.
// CLAUDE_MD_BEGIN/END above are kept deliberately: an install still strips the
// block from any machine that already received it.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove anything this script previously added that shapes the model's replies.
 *
 * Both the bundled prompt-compression hook and the plain-language CLAUDE.md
 * block change how the model is instructed, and on a small model that showed up
 * as a turn which ran tools and then printed nothing at all. Instructions that
 * can cost you the answer are not a sensible default, so unless they are asked
 * for explicitly the installer takes them back off.
 */
function removePromptExtras(settings, cavemanSrc) {
  const removed = [];

  // Unregister the caveman hooks, leaving every other hook untouched.
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const before = JSON.stringify(settings.hooks[event] || []);
      settings.hooks[event] = (settings.hooks[event] || []).filter(
        (entry) => !JSON.stringify(entry).includes('caveman')
      );
      if (JSON.stringify(settings.hooks[event]) !== before) removed.push(`${event} hook`);
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
  }

  // Delete only the copies this script put there. Someone may have been running
  // their own build of these hooks long before it was bundled here, and deleting
  // a file we did not write is not ours to do — so a file is removed only when
  // it is byte-identical to the bundled copy. Anything else is left on disk and
  // reported; unregistered, it is inert either way.
  const bundled = cavemanSrc || path.join(__dirname, 'extras', 'caveman');
  const kept = [];
  for (const f of CAVEMAN_FILES) {
    const installed = path.join(HOOKS_DIR, f);
    if (!fs.existsSync(installed)) continue;
    try {
      const src = path.join(bundled, f);
      const same =
        fs.existsSync(src) && fs.readFileSync(src).equals(fs.readFileSync(installed));
      if (same) {
        fs.unlinkSync(installed);
        removed.push(f);
      } else {
        kept.push(f);
      }
    } catch {
      kept.push(f);
    }
  }
  if (kept.length) {
    info(`left your own copies in place (unregistered, not deleted): ${kept.join(', ')}`);
  }

  // Strip only our own marked block; anything the user wrote around it stays.
  try {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    if (md.includes(CLAUDE_MD_BEGIN)) {
      const re = new RegExp(
        '\\n*' + escapeRe(CLAUDE_MD_BEGIN) + '[\\s\\S]*?' + escapeRe(CLAUDE_MD_END) + '\\n*',
        'g'
      );
      const stripped = md.replace(re, '\n');
      if (stripped.trim()) fs.writeFileSync(CLAUDE_MD, stripped);
      else fs.unlinkSync(CLAUDE_MD);
      removed.push('CLAUDE.md block');
    }
  } catch {}

  if (removed.length) ok(`removed prompt extras: ${removed.join(', ')}`);
  return removed.length;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const CLAUDE_JSON = path.join(HOME, '.claude.json');

function installedSha() {
  const st = readJson(STATE_FILE, null) || readJson(LEGACY_STATE_FILE, {});
  return st.sha || null;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : 'unknown';
}

async function modeVersion() {
  const local = installedSha();
  const remote = await currentSha();
  const line = (k, v) => console.log(`${C.bold}${(k + ':').padEnd(12)}${C.reset}${v}`);

  line('installed', shortSha(local));
  line('github', remote ? shortSha(remote) : `${C.yellow}unreachable${C.reset}`);

  if (!remote) {
    console.log(`
${C.yellow}Could not reach GitHub, so this cannot be compared.${C.reset}`);
    return;
  }
  if (!local) {
    console.log(`
${C.yellow}No installed version recorded.${C.reset} Re-run the setup to record one.`);
    return;
  }
  if (local === remote) {
    console.log(`
${C.green}Up to date${C.reset} — installed matches ${REPO}@main.`);
  } else {
    console.log(`
${C.yellow}Out of date.${C.reset} ${shortSha(local)} installed, ${shortSha(remote)} on GitHub.`);
    console.log(`Update now:  ${C.cyan}node setup.js --key <your-key>${C.reset}`);
    console.log(`${C.dim}Or wait — the session-start hook picks it up within six hours.${C.reset}`);
  }
  console.log(`${C.dim}https://github.com/${REPO}/commits/main${C.reset}`);
}

// ---------------------------------------------------------------------------
// MCP trimming
// ---------------------------------------------------------------------------

/**
 * Every enabled MCP server's tool schemas are sent with every request, whatever
 * the question is. That is the largest avoidable per-request cost, but which
 * servers matter is the user's call — silently disabling someone's notes or
 * database access to save tokens is not a trade this script gets to make.
 */
function mcpServers() {
  const cfg = readJson(CLAUDE_JSON, {});
  return Object.keys(cfg.mcpServers || {});
}

function reportMcp() {
  const names = mcpServers();
  if (!names.length) return;
  info(`${names.length} MCP server${names.length === 1 ? '' : 's'} enabled: ${names.join(', ')}`);
  info('each one adds its tool schemas to every request — `node setup.js --trim` to pick');
}

function modeTrim() {
  const cfg = readJson(CLAUDE_JSON, {});
  const servers = cfg.mcpServers || {};
  const names = Object.keys(servers);

  if (!names.length) {
    console.log('No MCP servers are configured, so there is nothing to trim.');
    return;
  }

  // Positional arguments name the servers to keep — but --key takes a value,
  // and without this the key itself is read as a server name and the command
  // dies with "No such MCP server: sk-or-v1-...".
  const VALUE_FLAGS = ['--key'];
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    return !VALUE_FLAGS.includes(argv[i - 1]);
  });
  const keep = hasFlag('--none') ? [] : positional;
  if (!keep.length && !hasFlag('--none')) {
    console.log(`${C.bold}MCP servers currently enabled${C.reset}
`);
    for (const n of names) console.log(`  ${n}`);
    console.log(`
Each sends its tool schemas with ${C.bold}every${C.reset} request, whatever you ask.`);
    console.log(`
Keep only the ones you name:`);
    console.log(`  ${C.cyan}node setup.js --trim ${names[0]}${C.reset}`);
    console.log(`Disable all of them:`);
    console.log(`  ${C.cyan}node setup.js --trim --none${C.reset}`);
    console.log(`Put everything back:`);
    console.log(`  ${C.cyan}node setup.js --untrim${C.reset}`);
    return;
  }

  const unknown = keep.filter((k) => !names.includes(k));
  if (unknown.length) {
    die(`No such MCP server: ${unknown.join(', ')}`, `Configured: ${names.join(', ')}`);
  }

  const bak = backup(CLAUDE_JSON);
  const stash = readJson(STATE_FILE, {});
  stash.trimmedMcp = stash.trimmedMcp || {};

  const removed = [];
  for (const n of names) {
    if (keep.includes(n)) continue;
    stash.trimmedMcp[n] = servers[n];
    delete servers[n];
    removed.push(n);
  }
  cfg.mcpServers = servers;
  writeJson(CLAUDE_JSON, cfg);
  writeJson(STATE_FILE, stash);

  console.log(removed.length
    ? `${C.green}Disabled:${C.reset} ${removed.join(', ')}`
    : 'Nothing to disable.');
  console.log(`${C.green}Kept:${C.reset} ${keep.join(', ') || '(none)'}`);
  if (bak) console.log(`${C.dim}backup: ${path.basename(bak)}${C.reset}`);
  console.log(`Restore with: ${C.cyan}node setup.js --untrim${C.reset}`);
}

function modeUntrim() {
  const stash = readJson(STATE_FILE, {});
  const saved = stash.trimmedMcp || {};
  if (!Object.keys(saved).length) {
    console.log('Nothing was trimmed, so there is nothing to restore.');
    return;
  }
  const cfg = readJson(CLAUDE_JSON, {});
  cfg.mcpServers = { ...(cfg.mcpServers || {}), ...saved };
  writeJson(CLAUDE_JSON, cfg);
  delete stash.trimmedMcp;
  writeJson(STATE_FILE, stash);
  console.log(`${C.green}Restored:${C.reset} ${Object.keys(saved).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Usage logging
// ---------------------------------------------------------------------------

/**
 * A Stop hook that appends one line per assistant turn to a JSONL file.
 *
 * Claude Code's hook payload is not a stable published schema, so rather than
 * hard-coding field names this walks the object and keeps anything that looks
 * like a token count, a cost or a duration. That way it keeps working when the
 * shape changes, and an unfamiliar field shows up in the log instead of being
 * silently dropped.
 */
const USAGE_HOOK_SOURCE = String.raw`#!/usr/bin/env node
/**
 * openrouter-usage.js — generated by setup.js. Re-run the installer to change it.
 * Stop hook: appends one JSON line per turn to ~/.claude/openrouter-usage.jsonl
 *
 * Stdin is drained asynchronously and the process is never killed with
 * process.exit(). An earlier version read stdin synchronously and exited
 * immediately, which closed the pipe while Claude Code was still writing to it;
 * the turn died with the pipe and the assistant's reply was never printed. That
 * showed up as roughly one in three tool-using turns producing no output at all.
 * A hook must consume everything it is given and then end on its own.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(os.homedir(), '.claude', 'openrouter-usage.jsonl');
const INTERESTING = /token|cost|usd|duration|cache/i;

function collect(obj, into, prefix, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return into;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (typeof v === 'number' && INTERESTING.test(key)) into[key] = v;
    else if (v && typeof v === 'object') collect(v, into, key, depth + 1);
  }
  return into;
}

function record(raw) {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const numbers = collect(input, {}, '', 0);
    if (!Object.keys(numbers).length) return;
    const row = {
      ts: new Date().toISOString(),
      session: input.session_id || null,
      model: (input.model && (input.model.id || input.model.display_name)) || null,
      cwd: (input.workspace && input.workspace.current_dir) || null,
      ...numbers,
    };
    fs.appendFileSync(LOG, JSON.stringify(row) + String.fromCharCode(10));
  } catch {
    // Accounting must never break a turn.
  }
}

let buf = '';
let done = false;
function finish() {
  if (done) return;
  done = true;
  record(buf);
  // Let go of stdin so the process can exit. Without this it stays alive for as
  // long as the writer holds the pipe open, which is what trips the host's hook
  // timeout. The payload has already been received by this point; this is not
  // the same as the earlier bug, which killed the process mid-write.
  try { process.stdin.pause(); } catch {}
}

// Wait for stdin, but never wait long. Claude Code gives a hook a few seconds
// and reports a hook error if it outlives that, so this writes what it has and
// ends rather than holding the turn open waiting for a stream to close.
const guard = setTimeout(finish, 1500);
if (typeof guard.unref === 'function') guard.unref();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('error', finish);
process.stdin.on('end', () => { clearTimeout(guard); finish(); });
`;

const USAGE_HOOK = path.join(CLAUDE_DIR, 'hooks', 'openrouter-usage.js');
const USAGE_LOG = path.join(CLAUDE_DIR, 'openrouter-usage.jsonl');

function installUsageLog(settings) {
  writeGenerated(USAGE_HOOK, USAGE_HOOK_SOURCE, 'usage hook');

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];
  if (!JSON.stringify(settings.hooks.Stop).includes('openrouter-usage')) {
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: `"${process.execPath}" "${USAGE_HOOK}"`, timeout: 5 }],
    });
  }
  ok(`usage logging installed -> ${USAGE_LOG}`);
}

function removeUsageLog(settings) {
  let touched = false;
  if (settings.hooks && settings.hooks.Stop) {
    const before = JSON.stringify(settings.hooks.Stop);
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (e) => !JSON.stringify(e).includes('openrouter-usage')
    );
    if (JSON.stringify(settings.hooks.Stop) !== before) touched = true;
    if (!settings.hooks.Stop.length) delete settings.hooks.Stop;
  }
  try {
    if (fs.existsSync(USAGE_HOOK)) {
      fs.unlinkSync(USAGE_HOOK);
      touched = true;
    }
  } catch {}
  if (touched) ok('per-turn usage logging removed (--usagelog to keep it)');
}

/** Live spend straight from OpenRouter, which is the authoritative number. */
async function openrouterUsage(key) {
  try {
    const res = await fetch(`${API_ROOT}/v1/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()).data || null;
  } catch {
    return null;
  }
}

async function modeUsage() {
  const money = (n) => '$' + Number(n || 0).toFixed(4);
  const line = (k, v) => console.log(`${C.bold}${(k + ':').padEnd(18)}${C.reset}${v}`);
  console.log(`${C.bold}Token and spend usage${C.reset}\n`);

  const env = (readJson(CLAUDE_SETTINGS, {}).env) || {};
  const key = flagValue('--key') || process.env.OPENROUTER_API_KEY || env.ANTHROPIC_AUTH_TOKEN;

  if (key && key.startsWith('sk-or-')) {
    const d = await openrouterUsage(key);
    if (d) {
      console.log(`${C.cyan}OpenRouter (authoritative)${C.reset}`);
      line('  spent total', money(d.usage));
      line('  today', money(d.usage_daily));
      line('  this week', money(d.usage_weekly));
      line('  this month', money(d.usage_monthly));
      if (d.limit != null) {
        line('  credit limit', money(d.limit));
        line('  remaining', money(d.limit_remaining));
      }
      console.log('');
    } else {
      warn('could not reach OpenRouter for live spend');
    }
  }

  // Local per-turn log.
  let rows = [];
  try {
    rows = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}

  if (!rows.length) {
    console.log(`${C.dim}No local turns logged yet at ${USAGE_LOG}.`);
    console.log(`Start a Claude Code session and this fills in.${C.reset}`);
    return;
  }

  const totals = {};
  const byModel = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
    }
    const m = r.model || 'unknown';
    byModel[m] = (byModel[m] || 0) + 1;
  }

  console.log(`${C.cyan}This machine${C.reset}`);
  line('  turns logged', rows.length);
  line('  first', rows[0].ts);
  line('  last', rows[rows.length - 1].ts);
  for (const [k, v] of Object.entries(totals)) {
    // Key-name matching has to be specific: "cost.total_duration_ms" contains
    // "cost", and printing a millisecond count as dollars is worse than useless.
    let pretty;
    if (/usd/i.test(k)) pretty = money(v);
    else if (/duration_ms|_ms$/i.test(k)) pretty = (v / 1000).toFixed(1) + ' s';
    else pretty = Math.round(v).toLocaleString();
    line('  ' + k, pretty);
  }
  // The question this answers: am I paying full price for the system prompt and
  // tool schemas on every turn, or is the provider's cache absorbing them?
  const inTok = totals['usage.input_tokens'] || 0;
  const cached =
    (totals['usage.cache_read_input_tokens'] || 0) + (totals['usage.cache_read_tokens'] || 0);
  if (inTok) {
    const pct = (cached / inTok) * 100;
    console.log(`\n${C.cyan}Cache${C.reset}`);
    line('  input tokens', Math.round(inTok).toLocaleString());
    line('  from cache', `${Math.round(cached).toLocaleString()} (${pct.toFixed(1)}%)`);

    if (cached === 0) {
      console.log(`  ${C.yellow}No cache hits recorded.${C.reset} ${C.dim}Every turn is paying full price for the`);
      console.log(`  system prompt and tool schemas. Normal for the first turns of a session;`);
      console.log(`  if it stays at zero over many turns, something is changing the start of`);
      console.log(`  the prompt each time.${C.reset}`);
    } else if (pct < 50) {
      console.log(`  ${C.dim}Below half. One long session caches better than many short ones.${C.reset}`);
    }

    const perTurn = inTok / rows.length;
    line('  input per turn', Math.round(perTurn).toLocaleString());
    if (perTurn > 20000) {
      console.log(`  ${C.yellow}That is a lot of fixed overhead per turn.${C.reset}`);
      console.log(`  ${C.dim}Every enabled MCP server adds its tool schemas to every single request,`);
      console.log(`  whatever you are asking. Turning off the ones this project does not need is`);
      console.log(`  the single biggest saving available.${C.reset}`);
    }
  }

  console.log(`\n${C.cyan}Turns per model${C.reset}`);
  for (const [m, n] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
    line('  ' + m, n);
  }
  console.log(`\n${C.dim}Raw log: ${USAGE_LOG}${C.reset}`);
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/**
 * A SessionStart hook that keeps this setup current.
 *
 * Hooks block the start of a Claude Code session, so this one does almost
 * nothing: it rate-limits itself, then detaches a child process and returns.
 * The child does the network call and any reinstall, and the result lands on
 * the next session. Nothing here can delay, or fail, the session you are
 * starting — every path swallows its errors on purpose.
 */
const AUTOUPDATE_SOURCE = String.raw`#!/usr/bin/env node
/**
 * openrouter-autoupdate.js — generated by setup.js. Re-run the installer to change it.
 *
 * SessionStart: checks GitHub for a newer commit of the setup and reapplies it.
 * Detaches immediately so it can never slow down or break a session.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = '__REPO__';
const RAW_BASE = '__RAW_BASE__';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // six hours
const DIR = path.join(os.homedir(), '.claude');
const STATE = path.join(DIR, 'openrouter-setup-state.json');
const LOG = path.join(DIR, 'openrouter-autoupdate.log');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); } catch {}
}
function log(msg) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

// --- child: the part that is allowed to take time -------------------------
async function runCheck() {
  const state = readState();
  state.lastCheck = Date.now();
  writeState(state);

  let sha;
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/commits/main', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-openrouter-autoupdate' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return log('check failed: HTTP ' + res.status);
    sha = (await res.json()).sha;
  } catch (err) {
    return log('check failed: ' + err.message);
  }
  if (!sha) return log('check failed: no sha in response');

  if (sha === state.sha) {
    state.sha = sha;
    state.outdated = false;
    writeState(state);
    return log('up to date (' + sha.slice(0, 7) + ')');
  }

  // Flag it immediately so the statusline says so even if the reinstall below
  // fails or the machine is offline for the rest of the session.
  state.outdated = true;
  state.latest = sha;
  writeState(state);

  log('update available: ' + String(state.sha).slice(0, 7) + ' -> ' + sha.slice(0, 7));

  // Pinned to the commit, not to /main/. The branch URL is served from a CDN
  // that lags behind the API by minutes, so downloading it can fetch the
  // previous file while recording the new sha — installing stale code and never
  // retrying, because the versions then look equal. A commit URL is immutable.
  const url = 'https://raw.githubusercontent.com/' + REPO + '/' + sha + '/setup.js';
  let code;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return log('download failed: HTTP ' + res.status);
    code = await res.text();
  } catch (err) {
    return log('download failed: ' + err.message);
  }
  // Guard against a proxy handing back an error page.
  if (code.length < 5000 || !code.includes('ANTHROPIC_BASE_URL')) {
    return log('downloaded file did not look like setup.js');
  }

  const tmp = path.join(os.tmpdir(), 'claude-openrouter-update-' + Date.now() + '.js');
  try {
    fs.writeFileSync(tmp, code);
  } catch (err) {
    return log('could not write temp file: ' + err.message);
  }

  await new Promise((resolve) => {
    // Replay the options this machine was installed with. Without them the
    // update quietly reinstalls the defaults, undoing --reliable, --extras and
    // --usagelog on a machine whose owner explicitly asked for them.
    const saved = Array.isArray(state.options) ? state.options.filter((f) => /^--[a-z-]+$/.test(f)) : [];
    const args = [tmp, '--no-verify', '--no-launch', '--quiet'].concat(saved);
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (c) => {
      log('reinstall exited ' + c);
      if (out.trim()) log('  ' + out.trim().split('\n').slice(-4).join('\n  '));
      if (c === 0) {
        const s = readState();
        s.sha = sha;
        s.outdated = false;
        writeState(s);
      }
      resolve();
    });
    child.on('error', (err) => { log('reinstall failed: ' + err.message); resolve(); });
  });

  try { fs.unlinkSync(tmp); } catch {}
}

// --- parent: must return instantly ----------------------------------------
if (process.argv includes_marker) {}
`;

function autoupdateSource() {
  // Assembled rather than templated so the child-mode dispatch stays readable.
  const body = AUTOUPDATE_SOURCE
    .replace('__REPO__', REPO)
    .replace('__RAW_BASE__', RAW_BASE)
    .replace('if (process.argv includes_marker) {}', `
if (process.argv[2] === '--run') {
  runCheck().catch((err) => log('unexpected: ' + err.message));
} else {
  // Parent path: rate-limit, detach, exit. Never block the session.
  try {
    const state = readState();
    const due = !state.lastCheck || Date.now() - state.lastCheck > CHECK_EVERY_MS;
    if (due) {
      const child = spawn(process.execPath, [__filename, '--run'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch {}
  // Consume the session payload, then let go so the process can end.
  //
  // Exiting immediately breaks the pipe while the host is still writing. Waiting
  // for the stream to close is no better: it keeps the process alive as long as
  // the host holds the pipe open, which trips the hook timeout and is reported
  // as a startup hook error. So read whatever arrives, and release stdin shortly
  // afterwards either way.
  process.stdin.resume();
  process.stdin.on('error', () => {});
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => { try { process.stdin.pause(); } catch {} });
  const release = setTimeout(() => { try { process.stdin.pause(); } catch {} }, 800);
  if (typeof release.unref === 'function') release.unref();
}`.trim());
  return body;
}

function installAutoupdate(settings, sha) {
  writeGenerated(AUTOUPDATE, autoupdateSource(), 'auto-update hook');

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  const already = JSON.stringify(settings.hooks.SessionStart).includes('openrouter-autoupdate');
  if (!already) {
    settings.hooks.SessionStart.push({
      hooks: [{
        type: 'command',
        command: `"${process.execPath}" "${AUTOUPDATE}"`,
        timeout: 5,
        statusMessage: 'Checking for setup updates...',
      }],
    });
  }

  const state = readJson(STATE_FILE, {});
  state.sha = sha || state.sha || null;
  state.outdated = false;
  state.lastCheck = Date.now();
  // Remember the choices, so an unattended update reapplies them instead of
  // resetting the machine to defaults.
  state.options = ['--reliable', '--extras', '--efficient', '--usagelog'].filter(hasFlag);
  writeJson(STATE_FILE, state);

  ok(`auto-update installed${sha ? ` (pinned at ${sha.slice(0, 7)})` : ''}`);
}

/** Current commit on main, or null if GitHub is unreachable. */
async function currentSha() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-openrouter-setup' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()).sha || null;
  } catch {
    return null;
  }
}

/**
 * caveman — a prompt-compression hook. It strips articles, filler and
 * pleasantries from replies while leaving code, commands and error strings
 * exactly as they are, which cuts output tokens without losing substance.
 *
 * Shipped in extras/caveman and copied into ~/.claude/hooks. Pure Node
 * builtins, no dependencies.
 */
const CAVEMAN_FILES = [
  'caveman-activate.js',
  'caveman-mode-tracker.js',
  'caveman-config.js',
  'cavecrew-model-overrides.js',
  'caveman-stats.js',
  'caveman-statusline.ps1',
  'caveman-statusline.sh',
  'package.json',
];

const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');

/**
 * Fetch the bundled extras when this copy does not have them.
 *
 * The bootstrappers download setup.js on its own, and so does the auto-updater,
 * so `extras/` is present only when running from a clone or through npx. Asking
 * for --extras on the headline install path therefore did nothing but print a
 * skip notice. Rather than make the flag a lie on the most common path, the
 * files are fetched from the same commit the rest of the install came from.
 */
async function ensureCavemanFiles() {
  const local = path.join(__dirname, 'extras', 'caveman');
  if (fs.existsSync(local)) return local;

  const dest = path.join(os.tmpdir(), 'claude-openrouter-extras-' + Date.now());
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch {
    return null;
  }

  let got = 0;
  for (const f of CAVEMAN_FILES) {
    try {
      const res = await fetch(`${RAW_BASE}/extras/caveman/${f}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      // A proxy error page would otherwise be installed as a hook.
      if (!text.trim() || /^\s*<(!doctype|html)/i.test(text)) continue;
      fs.writeFileSync(path.join(dest, f), text);
      got++;
    } catch {}
  }

  if (!got) {
    warn('could not download the caveman files — continuing without them');
    return null;
  }
  info(`downloaded ${got} caveman files (not bundled with this copy)`);
  return dest;
}

function installCaveman(settings, srcDir) {
  const src = srcDir || path.join(__dirname, 'extras', 'caveman');
  if (!fs.existsSync(src)) {
    info('caveman not bundled with this copy — skipping');
    return false;
  }

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  let copied = 0;
  for (const f of CAVEMAN_FILES) {
    const from = path.join(src, f);
    if (!fs.existsSync(from)) continue;
    const to = path.join(HOOKS_DIR, f);
    // Never clobber a newer local copy the user has edited themselves.
    try {
      if (fs.existsSync(to) && fs.statSync(to).mtimeMs > fs.statSync(from).mtimeMs) continue;
      fs.copyFileSync(from, to);
      copied++;
    } catch (err) {
      warn(`could not install ${f}: ${err.message}`);
    }
  }

  // Register the two hooks, without disturbing any the user already has.
  const node = process.execPath;
  const wanted = [
    ['SessionStart', path.join(HOOKS_DIR, 'caveman-activate.js'), 'Loading caveman mode...'],
    ['UserPromptSubmit', path.join(HOOKS_DIR, 'caveman-mode-tracker.js'), 'Tracking caveman mode...'],
  ];

  settings.hooks = settings.hooks || {};
  for (const [event, script, statusMessage] of wanted) {
    settings.hooks[event] = settings.hooks[event] || [];
    const already = JSON.stringify(settings.hooks[event]).includes(path.basename(script));
    if (already) continue;
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: 5, statusMessage }],
    });
  }

  ok(`caveman installed (${copied} files) — /caveman lite|full|ultra, or "stop caveman"`);
  return true;
}

/**
 * rtk is a separate tool and deliberately not bundled. The binary on the
 * author's machine is a third-party Windows executable with no public source,
 * and the name `rtk` on both npm and crates.io belongs to an unrelated project
 * (reachingforthejack/rtk, "Rust Type Kit"). Installing that by name would give
 * you the wrong program, so this only wires up a source you supply yourself.
 */
function installRtk() {
  if (run('rtk', ['--version']).code === 0) {
    ok('rtk already present');
    return true;
  }
  const source = process.env.RTK_INSTALL_URL;
  if (!source) {
    info('rtk not installed — set RTK_INSTALL_URL to a package or git URL to enable it');
    info('(do not `npm i -g rtk`: that name belongs to an unrelated project)');
    return false;
  }
  const res = run('npm', ['install', '-g', source], { stdio: 'inherit' });
  if (res.code !== 0) {
    warn('rtk install failed — continuing without it');
    return false;
  }
  ok('rtk installed');
  return true;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

async function verify(key, model) {
  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: routed' }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
  }
  if (body.type !== 'message') throw new Error(`unexpected response shape: ${text.slice(0, 200)}`);
  return body;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function modeOff() {
  const s = readJson(CLAUDE_SETTINGS, {});
  if (!s.env || !s.env.ANTHROPIC_BASE_URL) {
    console.log('Routing is already off.');
    return;
  }
  const parked = {};
  for (const k of ROUTING_KEYS) {
    if (k in s.env) {
      parked[k] = s.env[k];
      delete s.env[k];
    }
  }
  if (s.__parkedModel) {
    s.model = s.__parkedModel;
    delete s.__parkedModel;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: true, parked, at: new Date().toISOString() });
  console.log(`${C.green}Routing off.${C.reset} Claude Code is back on your Anthropic account.`);
  console.log(`${C.dim}Open a new terminal, or reload the VSCode window.${C.reset}`);
}

function modeOn() {
  const state = readJson(STATE_FILE, null) || readJson(LEGACY_STATE_FILE, {});
  if (!state.parked || !state.parked.ANTHROPIC_AUTH_TOKEN) {
    die('Nothing saved to switch back to.', 'Run a full install:  node setup.js --key sk-or-v1-...');
  }
  const s = readJson(CLAUDE_SETTINGS, {});
  s.env = { ...(s.env || {}), ...state.parked };
  if (s.model) {
    s.__parkedModel = s.model;
    delete s.model;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: false, parked: state.parked, at: new Date().toISOString() });
  console.log(`${C.green}Routing on.${C.reset} Open a new terminal, or reload the VSCode window.`);
}

function modeStatus() {
  const s = readJson(CLAUDE_SETTINGS, {});
  const env = s.env || {};
  const on = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.includes('openrouter');
  const line = (k, v) => console.log(`${C.bold}${(k + ':').padEnd(14)}${C.reset}${v}`);

  line('routing', on ? `${C.green}ON -> ${env.ANTHROPIC_BASE_URL}${C.reset}`
                     : `${C.yellow}OFF (using your Anthropic account)${C.reset}`);
  line('default', env.ANTHROPIC_MODEL || '-');
  line('background', env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '-');
  line('opus slot', env.ANTHROPIC_DEFAULT_OPUS_MODEL || '-');
  line('thinking', env.MAX_THINKING_TOKENS === '0' ? 'off (required — see README)' : env.MAX_THINKING_TOKENS || 'default');
  line('context', env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    ? Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toLocaleString() + ' tokens' : '-');
  line('key', env.ANTHROPIC_AUTH_TOKEN ? env.ANTHROPIC_AUTH_TOKEN.slice(0, 12) + '...' : '-');
  line('statusline', (s.statusLine && s.statusLine.command) || '-');
  if (env.ANTHROPIC_BASE_URL && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) {
    console.log(`\n${C.red}This points at a local proxy that this version no longer installs.${C.reset}`);
    console.log(`Re-run the setup to fix it, or ${C.bold}node setup.js --off${C.reset} to go back to Anthropic.`);
  }
}

async function modeDoctor() {
  const line = (k, v, good) =>
    console.log(`${C.bold}${(k + ':').padEnd(16)}${C.reset}` +
      `${good === undefined ? '' : good ? C.green : C.red}${v}${C.reset}`);

  console.log(`${C.bold}openrouter setup doctor${C.reset}\n`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line('platform', `${process.platform} ${process.arch}`);
  line('node', process.versions.node, nodeMajor >= 18);
  const npmV = run('npm', ['--version']).stdout;
  line('npm', npmV || 'MISSING', Boolean(npmV));
  const cc = probeClaude();
  line('claude code', cc ? `${cc.version}  ${cc.path}` : 'MISSING', Boolean(cc));

  const s = readJson(CLAUDE_SETTINGS, {});
  const env = s.env || {};
  line('settings', fs.existsSync(CLAUDE_SETTINGS) ? CLAUDE_SETTINGS : 'not present', fs.existsSync(CLAUDE_SETTINGS));
  line('base url', env.ANTHROPIC_BASE_URL || 'unset',
    Boolean(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL.includes('openrouter')));
  line('default model', env.ANTHROPIC_MODEL || 'unset', Boolean(env.ANTHROPIC_MODEL));
  if (env.ANTHROPIC_MODEL) {
    try {
      const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const all = (await res.json()).data || [];
        const m = all.find((x) => x.id === env.ANTHROPIC_MODEL);
        if (m) {
          const img = takesImages(m);
          line('images', img ? 'supported' : 'NOT supported by this model', img);
        }
      }
    } catch {}
  }
  line('statusline', fs.existsSync(STATUSLINE) ? STATUSLINE : 'not present', fs.existsSync(STATUSLINE));
  line('CLAUDE.md', fs.existsSync(CLAUDE_MD) ? CLAUDE_MD : 'not present', fs.existsSync(CLAUDE_MD));

  let net = false;
  try {
    net = (await fetch(MODELS_URL, { signal: AbortSignal.timeout(15000) })).ok;
  } catch {}
  line('openrouter', net ? 'reachable' : 'UNREACHABLE', net);

  if (env.ANTHROPIC_AUTH_TOKEN) {
    let auth = 'unknown';
    let good = false;
    try {
      const r = await fetch(`${API_ROOT}/v1/key`, {
        headers: { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      });
      auth = r.ok ? 'accepted' : `REJECTED (HTTP ${r.status})`;
      good = r.ok;
    } catch (e) {
      auth = `could not check: ${e.message}`;
    }
    line('key', auth, good);
  }

  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[v]) line(v.toLowerCase(), process.env[v]);
  }
  console.log(`\n${C.dim}Safe to paste into an issue — it prints no keys.${C.reset}`);
}

function modeUninstall() {
  const baks = (() => {
    try {
      return fs.readdirSync(CLAUDE_DIR)
        .filter((f) => f.startsWith('settings.json.bak.'))
        .sort();
    } catch {
      return [];
    }
  })();

  // Every install writes a backup, so after installing twice the newest backup
  // is itself a routed configuration and restoring it leaves the machine
  // exactly where it started. Restore the newest backup that is NOT routed.
  const clean = baks
    .slice()
    .reverse()
    .find((f) => {
      const cfg = readJson(path.join(CLAUDE_DIR, f), {});
      const url = (cfg.env || {}).ANTHROPIC_BASE_URL || '';
      return !/openrouter|127\.0\.0\.1|localhost/.test(url);
    });

  if (clean) {
    fs.copyFileSync(path.join(CLAUDE_DIR, clean), CLAUDE_SETTINGS);
    console.log(`restored ${CLAUDE_SETTINGS} from ${clean}`);
  } else if (baks.length) {
    warn('every backup is itself routed — removing the routing keys instead');
    const s2 = readJson(CLAUDE_SETTINGS, {});
    if (s2.env) for (const k of ROUTING_KEYS) delete s2.env[k];
    if (s2.__parkedModel) {
      s2.model = s2.__parkedModel;
      delete s2.__parkedModel;
    }
    writeJson(CLAUDE_SETTINGS, s2);
  } else {
    warn('no settings backup found — removing the routing keys instead');
    const s = readJson(CLAUDE_SETTINGS, {});
    if (s.env) for (const k of ROUTING_KEYS) delete s.env[k];
    if (s.__parkedModel) {
      s.model = s.__parkedModel;
      delete s.__parkedModel;
    }
    writeJson(CLAUDE_SETTINGS, s);
  }

  removeLanguageHint();

  for (const f of [STATUSLINE, USAGE_HOOK, AUTOUPDATE]) {
    try {
      fs.unlinkSync(f);
      console.log(`removed ${f}`);
    } catch {}
  }
  console.log(`kept your usage log at ${USAGE_LOG}`);

  try {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    if (md.includes(CLAUDE_MD_BEGIN)) {
      const re = new RegExp('\\n*' + escapeRe(CLAUDE_MD_BEGIN) + '[\\s\\S]*?' + escapeRe(CLAUDE_MD_END) + '\\n*', 'g');
      const stripped = md.replace(re, '\n');
      if (stripped.trim()) fs.writeFileSync(CLAUDE_MD, stripped);
      else fs.unlinkSync(CLAUDE_MD);
      console.log(`cleaned ${CLAUDE_MD}`);
    }
  } catch {}

  console.log(`${C.green}Uninstalled.${C.reset} Open a new terminal, or reload the VSCode window.`);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function install() {
  out(`${C.bold}Claude Code -> OpenRouter${C.reset}\n`);

  say('Checking prerequisites');
  checkNode();
  const claudeBin = ensureClaudeCode();

  const key = resolveKey();

  say('Checking the key');
  await checkKey(key);

  say('Resolving models against the live OpenRouter catalogue');
  const catalogue = await fetchCatalogue(key);
  const first = pickModel(catalogue, WANTED.a);
  const second = pickModel(catalogue, WANTED.b);

  // Cheap vs expensive still comes from live prices, so a reprice cannot invert
  // the labels. Price does not pick the default, though: WANTED.a does.
  const [cheap, dear] = [first, second].sort((x, y) => blendedPrice(x) - blendedPrice(y));

  // --reliable still means "the pricier model as the default", and --cheap is
  // accepted and does nothing, so anyone who scripted either is not broken.
  const main = hasFlag('--reliable') ? dear : first;
  const secondary = main === first ? second : first;
  ok(`default -> ${main.id}  ${C.dim}${priceLabel(main)}${C.reset}`);
  ok(`other   -> ${secondary.id}  ${C.dim}${priceLabel(secondary)}${C.reset}`);
  // Pasting a screenshot at a text-only model fails with a 400 that says
  // nothing about the model, so say it here instead of letting it be
  // discovered later.
  if (!takesImages(main)) {
    const alt = takesImages(secondary) ? secondary.id : null;
    warn(`${main.id} cannot accept images — pasting a screenshot returns`);
    warn('  API Error 400: "Could not process image"');
    if (alt) info(`for a turn with an image, switch first: /model opus  ->  ${alt}`);
    info(alt ? 'or install with --reliable to make that the default' : 'pick an image-capable model in the WANTED table');
  }

  for (const m of [first, second]) {
    if (m.matchedBy === 'fuzzy') warn(`${m.id} was a fuzzy match — the exact slug is gone`);
  }

  say('Writing the statusline');
  writeStatusline();

  say('Pointing Claude Code at OpenRouter (covers the CLI and the VSCode extension)');
  // Opt-in, not opt-out. These change how the model is instructed, and a
  // machine that answers nothing is worse than one that answers verbosely.
  // --efficient is the token-saving variant: reply compression plus the
  // plain-language rules, which together cut output tokens noticeably. It is a
  // separate choice from routing because it changes how the model is instructed.
  const extras = hasFlag('--extras') || hasFlag('--efficient');
  // The smaller of the two windows: one setting covers both models, and
  // over-stating it would let a session grow past what the other can accept.
  const contextTokens = Math.min(
    cheap.context_length || 200000,
    dear.context_length || 200000
  );
  const sha = await currentSha();
  const cavemanSrc = extras ? await ensureCavemanFiles() : null;
  writeClaudeSettings(key, main.id, secondary.id, contextTokens, (settings) => {
    if (extras) installCaveman(settings, cavemanSrc);
    else removePromptExtras(settings);
    // Opt-in. It is only accounting, and it has already cost two user-visible
    // problems — a broken pipe that ate replies, and hook timeouts. Nothing
    // that merely reports on the work should be able to disturb the work.
    if (hasFlag('--usagelog')) installUsageLog(settings);
    else removeUsageLog(settings);
    if (!hasFlag('--no-autoupdate')) installAutoupdate(settings, sha);
  });
  ok(`${CLAUDE_SETTINGS} -> env.ANTHROPIC_BASE_URL = ${API_ROOT}`);
  info(`default ${main.id} | opus slot ${secondary.id}`);
  info(`context window ${contextTokens.toLocaleString()} tokens`);

  if (!hasFlag('--no-language-hint')) writeLanguageHint(main.id);

  reportMcp();
  if (hasFlag('--efficient')) {
    const servers = mcpServers();
    if (servers.length) {
      info(`biggest remaining saving: node setup.js --trim <servers to keep>`);
    }
  }

  if (extras) {
    say('Token savers');
    installRtk();
  }

  if (!hasFlag('--no-verify')) {
    say('Verifying with one real request');
    try {
      const body = await verify(key, main.id);
      const said = (body.content || []).map((b) => b.text || '').join('').trim();
      ok(`${body.model} replied${said ? `: ${JSON.stringify(said.slice(0, 40))}` : ' (thinking-only, still a success)'}`);
      if (body.usage) info(`billed ${body.usage.input_tokens} in / ${body.usage.output_tokens} out`);
    } catch (err) {
      warn(`verification failed: ${err.message}`);
      warn('Settings are written. Fix the error above and run --doctor.');
    }
  }

  const target = claudeBin ? claudeBin.path : 'claude';

  out(`\n${C.green}${C.bold}Done.${C.reset}\n`);
  out(`  ${C.bold}version:${C.reset}            ${shortSha(installedSha())}  ${C.dim}(github.com/${REPO})${C.reset}`);
  out(`  ${C.bold}claude:${C.reset}             ${target}`);
  out(`  ${C.bold}settings:${C.reset}           ${CLAUDE_SETTINGS}`);
  out(`  everyday model     : ${main.id}`);
  out(`  the other one      : ${C.cyan}/model opus${C.reset} -> ${secondary.id}`);
  out(`  back to Anthropic  : node setup.js --off`);
  out(`  ${C.bold}VSCode:${C.reset}             reload the window (Ctrl+Shift+P -> "Developer: Reload Window")`);
  out(`\n  ${C.dim}No proxy, no background service, nothing to keep running.${C.reset}`);

  // Auto-launch. The point of this script is that one pasted line ends with a
  // working Claude Code, so finishing at a shell prompt with homework ("now
  // open a new terminal") is a worse ending than simply starting it.
  if (hasFlag('--no-launch') || QUIET) {
    out(`\n  ${C.dim}Start it with:${C.reset} ${C.cyan}claude${C.reset}`);
    return;
  }
  if (!process.stdout.isTTY) {
    out(`\n  ${C.dim}Not an interactive terminal, so not launching. Run:${C.reset} ${C.cyan}claude${C.reset}`);
    return;
  }

  out(`\n  ${C.cyan}Starting Claude Code...${C.reset}\n`);
  const res = spawnSync(target, [], {
    stdio: 'inherit',
    // The settings file is written already and a fresh process reads it, but
    // passing the same variables here means this very first session is routed
    // even if something is odd about how settings are picked up.
    env: { ...process.env, ...routingEnv(key, main.id, secondary.id, contextTokens) },
    shell: IS_WIN && !/\.exe$/i.test(target),
  });
  if (res.error) {
    warn(`could not start Claude Code automatically: ${res.error.message}`);
    out(`  Start it yourself with: ${C.cyan}claude${C.reset}`);
  }
}

// ---------------------------------------------------------------------------

(async () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?|^ \*/gm, ''));
    return;
  }
  if (hasFlag('--version') || hasFlag('-v')) return modeVersion();
  if (hasFlag('--trim')) return modeTrim();
  if (hasFlag('--untrim')) return modeUntrim();
  if (hasFlag('--usage')) return modeUsage();
  if (hasFlag('--doctor')) return modeDoctor();
  if (hasFlag('--status')) return modeStatus();
  if (hasFlag('--off')) return modeOff();
  if (hasFlag('--on')) return modeOn();
  if (hasFlag('--uninstall')) return modeUninstall();
  await install();
})().catch((err) => die(err.stack || err.message));
