import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempData, sampleState } from './helpers.mjs';

for (const name of [
  'COACH_PROVIDER', 'COACH_ENABLED', 'COACH_MODEL',
  'COACH_CURSOR_API_KEY', 'COACH_CURSOR_MODEL',
  'COACH_OPENAI_BASE_URL', 'COACH_OPENAI_API_KEY', 'COACH_OPENAI_MODEL',
  'COACH_GEMINI_API_KEY', 'COACH_GEMINI_MODEL', 'COACH_GEMINI_API_BASE'
]) delete process.env[name];

const DIR = tempData();
const cfg = await import('../coach/config.js');
const auth = await import('../coach/oauth.js');
const cadence = await import('../coach/cadence.js');

/* ---------------- configuration ---------------- */

test('an unconfigured instance offers nothing at all', () => {
  assert.equal(cfg.isEnabled(), false);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.publicConfig(), null, 'no coach key in /api/config ⇒ no Coach UI anywhere');
});

test('a provider that is enabled but not signed in is still not offered', () => {
  cfg.save({ enabled: true, provider: 'claude' });
  assert.equal(cfg.isEnabled(), true);
  assert.equal(cfg.isConnected(), false);
  assert.equal(cfg.publicConfig(), null, 'half-configured is off, not broken');
});

test('credentials survive a round-trip and are unreadable in the file', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: { type: 'cli-token', data: cfg.encrypt({ token: 'cli-setup-secret' }) } });
  assert.equal(cfg.isConnected(), true);
  const onDisk = fs.readFileSync(`${DIR}/coach.json`, 'utf8');
  assert.ok(!onDisk.includes('cli-setup-secret'), 'the token is not sitting in the file in the clear');
  assert.equal(cfg.decrypt(cfg.load().auth.data).token, 'cli-setup-secret');
});

test('a credential encrypted under a different secret fails closed', () => {
  const blob = cfg.encrypt({ token: 'sk-ant-secret' });
  fs.writeFileSync(`${DIR}/secret`, 'b'.repeat(64));
  cfg.reset();
  assert.equal(cfg.decrypt(blob), null, 'restoring ./data without its secret does not leak the token');
  fs.writeFileSync(`${DIR}/secret`, 'a'.repeat(64));
  cfg.reset();
});

test('a Claude Code setup token is encrypted and reaches only the Agent SDK environment', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: null });
  auth.setSetupToken('cli-setup-tok');
  assert.equal(cfg.load().auth.type, 'cli-token');
  assert.equal(auth.authStatus().type, 'cli-token');
  process.env.RP_ID = 'gym.example.com';
  process.env.ADMIN_UIDS = 'someadmin';
  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'cli-setup-tok');
  assert.equal(env.HOME, '/tmp/jobdir', 'the Agent SDK writes any transient state into the job dir');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/jobdir');
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.RP_ID, undefined, 'nothing is inherited from this process');
  assert.equal(env.ADMIN_UIDS, undefined);
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'TMPDIR']);
});

test('the built-in providers are claude, codex, cursor, openai, gemini and the fixture', () => {
  assert.deepEqual(Object.keys(cfg.PROVIDERS).sort(), ['claude', 'codex', 'cursor', 'fixture', 'gemini', 'openai']);
});

test('an unknown provider and a custom command reset to unconfigured Claude', () => {
  cfg.save({
    enabled: true,
    provider: 'custom',
    customCommand: '/usr/local/bin/my-coach',
    auth: { type: 'apikey', data: cfg.encrypt({ token: 'custom-key' }) }
  });
  cfg.reset();
  const current = cfg.load();
  assert.equal(current.provider, 'claude');
  assert.equal(current.auth, null);
  assert.equal(Object.hasOwn(current, 'customCommand'), false);
  assert.equal(cfg.isConnected(), false);
});

test('a stored Gemini API key is encrypted and reaches only the Gemini job', () => {
  cfg.save({ enabled: true, provider: 'gemini', auth: null, model: 'gemini-2.5-flash', openaiBaseUrl: null });
  auth.setApiKey('AIza-secret');
  assert.equal(cfg.load().provider, 'gemini');
  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().type, 'apikey');
  const onDisk = fs.readFileSync(`${DIR}/coach.json`, 'utf8');
  assert.ok(!onDisk.includes('AIza-secret'));
  process.env.RP_ID = 'gym.example.com';
  const env = cfg.jobEnv('/tmp/gemini-job');
  assert.equal(env.GEMINI_API_KEY, 'AIza-secret');
  assert.equal(env.RP_ID, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CURSOR_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('Cursor accepts an API key and an environment key overrides it without being stored', () => {
  cfg.save({ enabled: true, provider: 'cursor', auth: null, model: null, openaiBaseUrl: null });
  auth.setApiKey('cursor-saved');
  assert.equal(cfg.jobEnv('/tmp/cursor-job').CURSOR_API_KEY, 'cursor-saved');
  process.env.COACH_CURSOR_API_KEY = 'cursor-from-env';
  process.env.COACH_CURSOR_MODEL = 'composer-2';
  try {
    assert.equal(cfg.effective().model, 'composer-2');
    assert.equal(cfg.jobEnv('/tmp/cursor-job').CURSOR_API_KEY, 'cursor-from-env');
    assert.equal(auth.authStatus().type, 'env');
    cfg.save({ log: cfg.load().log });
    assert.ok(!fs.readFileSync(`${DIR}/coach.json`, 'utf8').includes('cursor-from-env'));
  } finally {
    delete process.env.COACH_CURSOR_API_KEY;
    delete process.env.COACH_CURSOR_MODEL;
  }
});

test('OpenAI-compatible is reachable with only a base URL, and the env key stays out of the file', () => {
  cfg.save({ enabled: true, provider: 'openai', auth: null, model: null, openaiBaseUrl: 'https://api.openai.com/v1/' });
  assert.equal(cfg.effective().openaiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().state, 'not-required');
  let env = cfg.jobEnv('/tmp/openai-job');
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
  assert.equal(env.OPENAI_API_KEY, undefined);
  process.env.COACH_OPENAI_API_KEY = 'sk-from-env';
  process.env.COACH_OPENAI_MODEL = 'llama3.1';
  try {
    assert.equal(cfg.effective().model, 'llama3.1');
    env = cfg.jobEnv('/tmp/openai-job');
    assert.equal(env.OPENAI_API_KEY, 'sk-from-env');
    assert.equal(auth.authStatus().type, 'env');
    assert.ok(!fs.readFileSync(`${DIR}/coach.json`, 'utf8').includes('sk-from-env'));
  } finally {
    delete process.env.COACH_OPENAI_API_KEY;
    delete process.env.COACH_OPENAI_MODEL;
  }
});

test('COACH_PROVIDER switches the running provider without leaking the previous credential', () => {
  cfg.save({
    enabled: false,
    provider: 'claude',
    model: 'claude-sonnet',
    auth: { type: 'cli-token', data: cfg.encrypt({ token: 'claude-setup-tok' }) }
  });
  process.env.COACH_ENABLED = '1';
  process.env.COACH_PROVIDER = 'openai';
  process.env.COACH_OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
  process.env.COACH_MODEL = 'demo-model';
  try {
    assert.equal(cfg.isEnabled(), true);
    assert.equal(cfg.effective().provider, 'openai');
    assert.equal(cfg.effective().model, 'demo-model');
    assert.equal(cfg.publicConfig().providerLabel, 'OpenAI-compatible');
    const env = cfg.jobEnv('/tmp/switched');
    assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:9/v1');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CURSOR_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
  } finally {
    delete process.env.COACH_ENABLED;
    delete process.env.COACH_PROVIDER;
    delete process.env.COACH_OPENAI_BASE_URL;
    delete process.env.COACH_MODEL;
  }
  assert.equal(cfg.effective().provider, 'claude');
});

test('base URLs have to be http(s) and cannot carry credentials', () => {
  assert.equal(cfg.normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(cfg.normalizeBaseUrl('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1');
  assert.equal(cfg.normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(cfg.normalizeBaseUrl('http://user:pass@example.com/v1'), null);
  assert.equal(cfg.normalizeBaseUrl('file:///etc/passwd'), null);
  assert.equal(cfg.normalizeBaseUrl('ftp://example.com/v1'), null);
  assert.equal(cfg.normalizeBaseUrl(''), null);
});

test('Codex uses its own ChatGPT CLI cache and never receives an API key', () => {
  cfg.save({ enabled: true, provider: 'codex', auth: { type: 'apikey', data: cfg.encrypt({ token: 'legacy-openai-key' }) } });
  cfg.ensureCodexHome();
  const codexConfig = fs.readFileSync(`${cfg.codexHome()}/config.toml`, 'utf8');
  assert.match(codexConfig, /shell_tool = false/);
  assert.match(codexConfig, /":root" = "deny"/);
  fs.writeFileSync(cfg.codexAuthFile(), '{}', { mode: 0o600 });

  assert.equal(cfg.isConnected(), true);
  assert.equal(auth.authStatus().type, 'chatgpt-cli');
  assert.throws(() => auth.setApiKey('sk-not-used'), /ChatGPT/);

  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.CODEX_HOME, cfg.codexHome());
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.HOME, '/tmp/jobdir', 'the agent has no access to the persistent cache through HOME');
  fs.unlinkSync(cfg.codexAuthFile());
  assert.equal(cfg.isConnected(), false, 'a removed Codex cache fails closed');
});

test('legacy Claude credentials are disabled until replaced with a setup token', () => {
  cfg.save({ enabled: true, provider: 'claude', auth: { type: 'apikey', data: cfg.encrypt({ token: 'sk-ant-key' }) } });
  assert.equal(cfg.isConnected(), false);
  assert.equal(auth.authStatus().state, 'replace-required');
  const env = cfg.jobEnv('/tmp/jobdir');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.throws(() => auth.setApiKey('sk-ant-key'), /setup token/);
});

test('the instance job log records outcomes, never contents', () => {
  cfg.save({ log: [] });
  cfg.logJob({ at: new Date().toISOString(), uid: 'u1', kind: 'review', outcome: 'ready', ms: 1200 });
  cfg.logJob({ at: new Date().toISOString(), uid: 'u1', kind: 'review', outcome: 'failed', errorClass: 'auth', ms: 400 });
  const log = cfg.load().log;
  assert.equal(log.length, 2);
  assert.equal(cfg.lastError().errorClass, 'auth');
  assert.equal(cfg.lastSuccess().outcome, 'ready');
  assert.ok(!JSON.stringify(log).includes('changes'), 'no proposal content ever reaches the instance log');
});

/* ---------------- cadence ---------------- */

const coachWith = over => ({ consent: { agreedAt: '2026-01-01T00:00:00Z' }, ...over });

test('cadence off never fires', () => {
  assert.equal(cadence.isDue(coachWith({ cadence: 'off' }), sampleState(), null), false);
  assert.equal(cadence.isDue(coachWith({}), sampleState(), null), false);
});

test('no new training since the last review means nothing to review', () => {
  const S = sampleState();
  const coach = coachWith({ cadence: { everyWorkouts: 1 }, lastReview: { at: Date.now() } });
  assert.equal(cadence.isDue(coach, S, null), false);
});

test('every-N-workouts fires once the count is met', () => {
  const S = sampleState();
  S.workouts = [1, 2, 3].map(i => ({ id: 'w' + i, d: '2026-07-2' + i, end: Date.now(), entries: [] }));
  assert.equal(cadence.isDue(coachWith({ cadence: { everyWorkouts: 4 } }), S, null), false);
  assert.equal(cadence.isDue(coachWith({ cadence: { everyWorkouts: 3 } }), S, null), true);
});

test('weekly fires on the chosen weekday and minute, in the user\'s own timezone', () => {
  const S = sampleState();
  S.workouts = [{ id: 'w1', d: '2026-07-25', end: Date.now(), entries: [] }];
  const coach = coachWith({ cadence: { weekly: { day: 0, time: '18:00' } } });
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '18:00', weekday: 0 }), true);
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '17:59', weekday: 0 }), false);
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-27', hhmm: '18:00', weekday: 1 }), false);
});

test('weekly does not fire twice on the same day', () => {
  const S = sampleState();
  S.workouts = [{ id: 'w1', d: '2026-07-25', end: Date.now(), entries: [] }];
  const coach = coachWith({
    cadence: { weekly: { day: 0, time: '18:00' } },
    lastReview: { at: new Date('2026-07-26T18:00:00Z').getTime() }
  });
  assert.equal(cadence.isDue(coach, S, { date: '2026-07-26', hhmm: '18:00', weekday: 0 }), false);
});
