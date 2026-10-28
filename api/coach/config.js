/* Coach instance configuration — the one place that knows whether this instance offers the
   AI Coach at all, which provider drives it, and how to authenticate to it.

   The admin dashboard writes ./data/coach.json so enabling the Coach usually needs no file
   edit and no restart. Environment variables override that file when they are set, which is
   how a deployment switches provider, model, base URL or API key from `.env`. A key supplied
   that way is injected into the job environment and is never copied into coach.json.

   COACH_DISABLED force-disables the feature regardless of what is stored or which other
   COACH_* variables are set — a fleet operator's kill switch, not a configuration step.

   Provider credentials normally live encrypted at rest with a key derived from ./data/secret
   (the same file that already signs session cookies, generated 0600 on first boot). ChatGPT
   sign-in is the exception: Codex owns its refreshable CLI credential in a separate private
   cache, rather than OpenGym importing or duplicating an OAuth token. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unprivilegedIds } from './adapters/spawn.js';

const DATA = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA, 'coach.json');
const coachCodexHome = process.env.COACH_CODEX_HOME || path.join(DATA, 'codex');
// This file is deliberately owned by OpenGym, not a person's normal Codex configuration. It
// gives spawned agent commands only their temporary workspace and the minimal runtime paths;
// specifically, `:root = "deny"` prevents a Coach prompt from reading /codex/auth.json.
const COACH_CODEX_CONFIG = `# Managed by openGym; do not add plugins, MCP servers, or broad permissions here.\ncli_auth_credentials_store = "file"\nallow_login_shell = false\napproval_policy = "never"\nweb_search = "disabled"\ndefault_permissions = "coach"\n\n[features]\nauth_elicitation = false\nshell_tool = false\nunified_exec = false\nshell_snapshot = false\nbrowser_use = false\nbrowser_use_external = false\nbrowser_use_full_cdp_access = false\nin_app_browser = false\ncomputer_use = false\napps = false\nplugins = false\nplugin_sharing = false\nremote_plugin = false\nmulti_agent = false\nskill_search = false\nskill_mcp_dependency_install = false\nworkspace_dependencies = false\nimage_generation = false\nhooks = false\ncode_mode_host = false\ntool_suggest = false\n\n[agents]\nenabled = false\n\n[permissions.coach.filesystem]\n":root" = "deny"\n":minimal" = "read"\n\n[permissions.coach.filesystem.":workspace_roots"]\n"." = "read"\n\n[permissions.coach.network]\nenabled = false\n`;
export const COACH_DISABLED = /^(1|true|yes|on)$/i.test(process.env.COACH_DISABLED || '');

// Providers this build can drive. `runtime` is what the adapter runs; the credential fields
// describe how an encrypted instance credential reaches that isolated runtime. Adding one is
// an adapter file plus a row here — nothing else in the codebase branches on provider identity.
export const PROVIDERS = {
  claude: { label: 'Claude Code', runtime: 'Claude Agent SDK', setupToken: true, apiKeyEnv: 'ANTHROPIC_API_KEY', oauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN' },
  codex: { label: 'OpenAI Codex CLI', runtime: 'OpenAI Codex CLI', deviceLogin: true, apiKeyEnv: null, oauthEnv: null },
  cursor: {
    label: 'Cursor Agent',
    runtime: 'Cursor CLI',
    apiKeyEnv: 'CURSOR_API_KEY',
    oauthEnv: null,
    apiKeyHint: 'cursor_…',
    apiKeyHelp: 'Create an API key in the Cursor dashboard (Dashboard → API Keys), then paste it here. It is stored encrypted and passed to the Cursor CLI only while a job runs.'
  },
  openai: {
    label: 'OpenAI-compatible',
    runtime: 'OpenAI-compatible API',
    apiKeyEnv: 'OPENAI_API_KEY',
    oauthEnv: null,
    baseUrl: true,
    apiKeyOptional: true,
    defaultModel: 'gpt-4o-mini',
    apiKeyHint: 'sk-…',
    apiKeyHelp: 'Optional for local servers such as Ollama and LM Studio. Required for OpenAI, OpenRouter, and most hosted endpoints. Stored encrypted, and never shown again.',
    baseUrlHelp: 'Root URL that serves /chat/completions. Examples: https://api.openai.com/v1, https://openrouter.ai/api/v1, http://host.docker.internal:11434/v1.'
  },
  gemini: {
    label: 'Google Gemini',
    runtime: 'Gemini API',
    apiKeyEnv: 'GEMINI_API_KEY',
    oauthEnv: null,
    defaultModel: 'gemini-2.5-flash',
    apiKeyHint: 'AIza…',
    apiKeyHelp: 'Create a key in Google AI Studio, then paste it here. It is stored encrypted and sent only as a request header while a job runs.'
  },
  // Test-only: drives the in-repo fixture CLI. Selectable so an instance can be exercised
  // end-to-end (and demoed) without any AI account at all.
  fixture: { label: 'Fixture (testing)', runtime: 'Fixture', apiKeyEnv: null, oauthEnv: null }
};

const DEFAULTS = {
  enabled: false,
  provider: 'claude',
  model: null,
  openaiBaseUrl: null,
  auth: null,                                    // { type:'cli-token'|'oauth'|'apikey', data:<encrypted> }
  caps: { perProfileDaily: 10, instanceDaily: 0 },   // 0 = unlimited
  log: []
};
const LOG_MAX = 100;

/* ---------- at-rest encryption ---------- */

let keyCache = null;
function key() {
  if (keyCache) return keyCache;
  // Read the secret lazily: server.js creates it at boot, and this module may be imported first.
  const secret = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  keyCache = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('opengym-coach-v1'), 32));
  return keyCache;
}
export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob) {
  try {
    const buf = Buffer.from(String(blob || ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }   // wrong key (restored ./data without the secret), or tampered file
}

/* ---------- load / save ---------- */

let cache = null;
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
export function load() {
  if (cache) return cache;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* absent = feature off */ }
  const { customCommand: _customCommand, ...storedWithoutCustomCommand } = stored;
  cache = { ...DEFAULTS, ...storedWithoutCustomCommand, caps: { ...DEFAULTS.caps, ...(stored.caps || {}) } };
  // A retired provider must not leave the admin page in a state where no chip is selected, or
  // continue using its old credential. The next normal save also removes its legacy fields.
  if (!PROVIDERS[cache.provider]) {
    cache.provider = DEFAULTS.provider;
    cache.auth = null;
  }
  return cache;
}
export function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  atomicWrite(FILE, JSON.stringify(next, null, 2), 0o600);
  return next;
}
// Test seam: forget the in-memory copy so the next load() re-reads from disk.
export function reset() { cache = null; keyCache = null; }

/* ---------- Codex's isolated ChatGPT credential cache ---------- */

/** The cache is a separate bind mount in Docker, owned by the unprivileged Coach user. */
export const codexHome = () => coachCodexHome;
export const codexAuthFile = () => path.join(codexHome(), 'auth.json');

/** Create the cache with ownership that lets a provider job refresh its own CLI session. */
export function ensureCodexHome() {
  const dir = codexHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* bind-mounted host path may reject chmod */ }
  const ids = unprivilegedIds();
  if (ids) {
    try { fs.chownSync(dir, ids.uid, ids.gid); } catch { /* local development need not have this user */ }
  }
  const configFile = path.join(dir, 'config.toml');
  let existing = null;
  try { existing = fs.readFileSync(configFile, 'utf8'); } catch { /* write the managed file below */ }
  if (existing !== COACH_CODEX_CONFIG) {
    const tmp = configFile + '.tmp';
    fs.writeFileSync(tmp, COACH_CODEX_CONFIG, { mode: 0o600 });
    fs.renameSync(tmp, configFile);
  }
  try { fs.chmodSync(configFile, 0o600); } catch { /* bind-mounted host path may reject chmod */ }
  if (ids) {
    try { fs.chownSync(configFile, ids.uid, ids.gid); } catch { /* local development need not have this user */ }
  }
  return dir;
}

/** We deliberately inspect only the presence of Codex's cache, never its token contents. */
export function hasCodexAuth() {
  try { return fs.statSync(codexAuthFile()).isFile(); } catch { return false; }
}

/* ---------- derived state ---------- */

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || '');
}
function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Non-secret and secret Coach settings coming from the process environment. Secrets are
 *  returned to jobEnv only; they are never written into coach.json. */
export function readEnv() {
  const provider = envValue('COACH_PROVIDER').toLowerCase();
  return {
    enabled: envFlag('COACH_ENABLED'),
    provider: PROVIDERS[provider] ? provider : '',
    model: envValue('COACH_MODEL'),
    openaiBaseUrl: envValue('COACH_OPENAI_BASE_URL'),
    openaiModel: envValue('COACH_OPENAI_MODEL'),
    openaiKey: envValue('COACH_OPENAI_API_KEY'),
    cursorModel: envValue('COACH_CURSOR_MODEL'),
    cursorKey: envValue('COACH_CURSOR_API_KEY'),
    geminiModel: envValue('COACH_GEMINI_MODEL'),
    geminiKey: envValue('COACH_GEMINI_API_KEY')
  };
}

/** The model an environment variable forces for this provider, or '' when the dashboard wins. */
export function modelFromEnv(provider, env = readEnv()) {
  if (env.model) return env.model;
  if (provider === 'openai' && env.openaiModel) return env.openaiModel;
  if (provider === 'cursor' && env.cursorModel) return env.cursorModel;
  if (provider === 'gemini' && env.geminiModel) return env.geminiModel;
  return '';
}

/**
 * Accept only an http(s) origin plus path. Credentials, queries and non-HTTP schemes are
 * rejected so a base URL cannot smuggle a key or point at a file. A trailing /chat/completions
 * is stripped so pasting the full endpoint still works.
 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.length > 300) return null;
  let url;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  return url.origin + path;
}

/** Stored config with environment overrides applied. Does not mutate the cached file copy. */
export function effective(cfg = load()) {
  const env = readEnv();
  const provider = PROVIDERS[env.provider] ? env.provider : cfg.provider;
  const safeProvider = PROVIDERS[provider] ? provider : DEFAULTS.provider;
  const openaiBaseUrl = env.openaiBaseUrl
    ? normalizeBaseUrl(env.openaiBaseUrl)
    : normalizeBaseUrl(cfg.openaiBaseUrl);
  return {
    ...cfg,
    enabled: env.enabled ? true : !!cfg.enabled,
    provider: safeProvider,
    model: modelFromEnv(safeProvider, env) || cfg.model || null,
    openaiBaseUrl
  };
}

/** Which fields the dashboard must not fight, because the environment already set them. */
export function envLocks() {
  const env = readEnv();
  const provider = effective().provider;
  return {
    enabled: env.enabled,
    provider: !!env.provider,
    model: !!modelFromEnv(provider, env),
    openaiBaseUrl: !!env.openaiBaseUrl,
    cursorKey: !!env.cursorKey,
    openaiKey: !!env.openaiKey,
    geminiKey: !!env.geminiKey
  };
}

function apiKeyToken(cfg) {
  if (cfg.auth?.type !== 'apikey') return '';
  return decrypt(cfg.auth.data)?.token || '';
}

export const providerMeta = cfg => PROVIDERS[(cfg || effective()).provider] || PROVIDERS.claude;

/** Is the feature switched on at all (before asking whether it can actually reach a model)? */
export function isEnabled() {
  if (COACH_DISABLED) return false;
  const cfg = effective();
  return !!cfg.enabled && !!PROVIDERS[cfg.provider];
}
/** Credentials present? The fixture carries its own auth (or needs none). */
export function isConnected() {
  const cfg = effective();
  if (!isEnabled()) return false;
  if (cfg.provider === 'fixture') return true;
  // Codex's ChatGPT credential remains in Codex's own auth.json cache, not coach.json.
  if (cfg.provider === 'codex') return hasCodexAuth();
  const env = readEnv();
  if (cfg.provider === 'cursor') return !!(env.cursorKey || apiKeyToken(cfg));
  if (cfg.provider === 'gemini') return !!(env.geminiKey || apiKeyToken(cfg));
  // A local OpenAI-compatible server often has no key. The base URL is the thing that
  // makes the provider usable; a missing key fails later, at request time, if it is required.
  if (cfg.provider === 'openai') return !!cfg.openaiBaseUrl;
  // Claude is intentionally setup-token only. Do not silently retain the old browser OAuth or
  // API-key paths after the instance has been upgraded to the Agent SDK flow.
  if (cfg.provider === 'claude' && cfg.auth?.type !== 'cli-token') return false;
  return !!(cfg.auth && decrypt(cfg.auth.data));
}
/** What /api/config tells every client. Absent ⇒ no Coach UI exists anywhere (FR-55/56). */
export function publicConfig() {
  if (!isEnabled() || !isConnected()) return null;
  const cfg = effective();
  return { enabled: true, provider: cfg.provider, providerLabel: providerMeta(cfg).label };
}

/**
 * The environment a job's provider process gets. Deliberately built from nothing rather than
 * filtered from process.env: the child must not inherit RP_ID, ADMIN_UIDS, VAPID material or
 * anything else this server happens to hold.
 */
export function jobEnv(jobDir) {
  const cfg = effective();
  const meta = providerMeta(cfg);
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: jobDir, TMPDIR: jobDir };
  if (cfg.provider === 'claude') {
    // The Agent SDK may otherwise read global Claude Code configuration. Keep every possible
    // file it touches inside the short-lived, unprivileged job directory instead.
    env.CLAUDE_CONFIG_DIR = jobDir;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }
  if (cfg.provider === 'codex') {
    // This is the only persistent state a Codex job receives. The directory is a dedicated
    // bind mount owned by `coach`; /data and every OpenGym secret remain inaccessible.
    env.CODEX_HOME = ensureCodexHome();
  }
  if (cfg.provider === 'cursor') {
    // The CLI writes its compile cache and any local config under HOME. Point the XDG dirs
    // at the job directory too, so a fallback path cannot land in /root.
    env.XDG_CONFIG_HOME = jobDir;
    env.XDG_CACHE_HOME = jobDir;
  }
  const auth = cfg.auth ? decrypt(cfg.auth.data) : null;
  if (auth && auth.token && (cfg.provider !== 'claude' || cfg.auth.type === 'cli-token')) {
    const name = (cfg.auth.type === 'cli-token' || cfg.auth.type === 'oauth')
      ? meta.oauthEnv
      : cfg.auth.type === 'apikey' ? meta.apiKeyEnv : null;
    if (name) env[name] = auth.token;
  }
  // Environment keys win over a saved key so rotating `.env` does not require the dashboard.
  // They are applied only for the provider that is actually running.
  const fromEnv = readEnv();
  if (cfg.provider === 'cursor' && fromEnv.cursorKey) env.CURSOR_API_KEY = fromEnv.cursorKey;
  if (cfg.provider === 'gemini' && fromEnv.geminiKey) env.GEMINI_API_KEY = fromEnv.geminiKey;
  if (cfg.provider === 'openai') {
    if (cfg.openaiBaseUrl) env.OPENAI_BASE_URL = cfg.openaiBaseUrl;
    if (fromEnv.openaiKey) env.OPENAI_API_KEY = fromEnv.openaiKey;
  }
  return env;
}

/* ---------- instance-level job log (counts and outcomes only, never contents — FR-12/42) ---------- */

export function logJob(entry) {
  const cfg = load();
  const log = [...(cfg.log || []), entry].slice(-LOG_MAX);
  save({ log });
}
export const lastError = () => [...(load().log || [])].reverse().find(e => e.outcome === 'failed') || null;
export const lastSuccess = () => [...(load().log || [])].reverse().find(e => e.outcome === 'ready' || e.outcome === 'nochange') || null;
