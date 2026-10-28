/* Adapter tests for Cursor, OpenAI-compatible and Gemini.
 *
 * No live provider account: Cursor is a fake executable, and the two HTTP providers talk to a
 * loopback server. What is pinned here is the contract — where the prompt goes, where the key
 * goes, and the shape of the request — not a vendor's uptime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tempData } from './helpers.mjs';

for (const name of [
  'COACH_PROVIDER', 'COACH_ENABLED', 'COACH_MODEL',
  'COACH_CURSOR_API_KEY', 'COACH_CURSOR_MODEL',
  'COACH_OPENAI_BASE_URL', 'COACH_OPENAI_API_KEY', 'COACH_OPENAI_MODEL',
  'COACH_GEMINI_API_KEY', 'COACH_GEMINI_MODEL', 'COACH_GEMINI_API_BASE'
]) delete process.env[name];

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bin-'));
const bin = path.join(binDir, 'agent');
fs.writeFileSync(bin, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "cursor-agent test"
    exit 0
  fi
done
printf '%s\\n' "$*" > "$PWD/argv.txt"
if [ ! -f prompt.md ]; then
  echo "missing prompt.md" >&2
  exit 1
fi
if printf '%s' "$*" | grep -q SECRET_PAYLOAD; then
  echo "prompt leaked onto argv" >&2
  exit 1
fi
echo '{"result":"{\\"ok\\":true}"}'
`, { mode: 0o755 });
process.env.COACH_CURSOR_BIN = bin;

tempData();
const cfg = await import('../coach/config.js');
const adapters = (await import('../coach/adapters/index.js')).default;

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('the cursor adapter sends the prompt as a file and the key only in the environment', async () => {
  cfg.save({
    enabled: true, provider: 'cursor', model: null, openaiBaseUrl: null,
    auth: { type: 'apikey', data: cfg.encrypt({ token: 'cursor-secret' }) }
  });
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-job-'));
  const env = cfg.jobEnv(jobDir);
  const check = await adapters.cursor.check(null, env);
  assert.equal(check.ok, true);
  assert.equal(check.version, 'cursor-agent test');
  const result = await adapters.cursor.invoke({
    prompt: 'SECRET_PAYLOAD return {"ok":true}',
    jobDir,
    env,
    model: 'composer-2',
    timeoutMs: 5000
  });
  assert.equal(result.code, 0);
  assert.equal(result.text, '{"ok":true}');
  const argv = fs.readFileSync(path.join(jobDir, 'argv.txt'), 'utf8');
  assert.match(argv, /--mode ask/);
  assert.match(argv, /--output-format json/);
  assert.match(argv, /--disable-auto-update/);
  assert.match(argv, /composer-2/);
  assert.doesNotMatch(argv, /SECRET_PAYLOAD/);
  assert.doesNotMatch(argv, /cursor-secret/);
  assert.match(fs.readFileSync(path.join(jobDir, 'prompt.md'), 'utf8'), /SECRET_PAYLOAD/);
  assert.equal(env.CURSOR_API_KEY, 'cursor-secret');
  assert.equal(env.HOME, jobDir);
});

test('an OpenAI-compatible server receives chat completions and the key only as a header', async () => {
  let seen = null;
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    seen = { url: req.url, auth: req.headers.authorization || '', body: JSON.parse(raw) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  try {
    cfg.save({
      enabled: true, provider: 'openai', model: 'local-model',
      openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      auth: { type: 'apikey', data: cfg.encrypt({ token: 'sk-local' }) }
    });
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-job-'));
    const env = cfg.jobEnv(jobDir);
    const check = await adapters.openai.check(null, env);
    assert.equal(check.ok, true);
    assert.equal(check.version, `127.0.0.1:${server.port}`);
    const result = await adapters.openai.invoke({
      prompt: 'reply with json', jobDir, env, model: 'local-model', timeoutMs: 5000
    });
    assert.equal(result.code, 0);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer sk-local');
    assert.equal(seen.body.model, 'local-model');
    assert.equal(seen.body.messages.at(-1).content, 'reply with json');
    assert.ok(!seen.url.includes('sk-local'));
  } finally {
    await server.close();
  }
});

test('a keyless OpenAI-compatible server is called without an Authorization header', async () => {
  let auth = 'unset';
  const server = await listen(async (req, res) => {
    auth = req.headers.authorization || '';
    await readBody(req);
    res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] } }] }));
  });
  try {
    cfg.save({
      enabled: true, provider: 'openai', model: null, auth: null,
      openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`
    });
    const env = cfg.jobEnv('/tmp/openai-keyless');
    assert.equal(env.OPENAI_API_KEY, undefined);
    const result = await adapters.openai.invoke({
      prompt: 'hi', jobDir: '/tmp', env, model: null, timeoutMs: 5000
    });
    assert.equal(result.code, 0);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(auth, '');
  } finally {
    await server.close();
  }
});

test('Gemini is called with the key in a header and a rejected model never leaves the box', async () => {
  let seen = null;
  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    seen = { url: req.url, key: req.headers['x-goog-api-key'] || '', body: JSON.parse(raw) };
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
  });
  process.env.COACH_GEMINI_API_BASE = `http://127.0.0.1:${server.port}/v1beta`;
  try {
    cfg.save({
      enabled: true, provider: 'gemini', model: 'gemini-2.5-flash', auth: null, openaiBaseUrl: null
    });
    process.env.COACH_GEMINI_API_KEY = 'AIza-test';
    const env = cfg.jobEnv('/tmp/gemini-job');
    const bad = await adapters.gemini.invoke({
      prompt: 'nope', jobDir: '/tmp', env, model: '../other', timeoutMs: 5000
    });
    assert.equal(bad.code, 1);
    assert.equal(seen, null, 'an illegal model name makes no request');
    const result = await adapters.gemini.invoke({
      prompt: 'reply with json', jobDir: '/tmp', env, model: 'gemini-2.5-flash', timeoutMs: 5000
    });
    assert.equal(result.code, 0);
    assert.equal(result.text, '{"ok":true}');
    assert.equal(seen.url, '/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(seen.key, 'AIza-test');
    assert.equal(seen.body.contents[0].parts[0].text, 'reply with json');
    assert.ok(!seen.url.includes('AIza-test'));
  } finally {
    delete process.env.COACH_GEMINI_API_KEY;
    delete process.env.COACH_GEMINI_API_BASE;
    await server.close();
  }
});

test('a Gemini auth failure is reported as an HTTP error and not a missing runtime', async () => {
  const server = await listen(async (req, res) => {
    await readBody(req);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.', code: 400 } }));
  });
  process.env.COACH_GEMINI_API_BASE = `http://127.0.0.1:${server.port}/v1beta`;
  try {
    const result = await adapters.gemini.invoke({
      prompt: 'hi',
      jobDir: '/tmp',
      env: { GEMINI_API_KEY: 'bad-key' },
      model: 'gemini-2.5-flash',
      timeoutMs: 5000
    });
    assert.equal(result.code, 1);
    assert.equal(result.spawnError, false);
    assert.match(result.stderr, /API key not valid/);
    assert.match(result.stderr, /400/);
  } finally {
    delete process.env.COACH_GEMINI_API_BASE;
    await server.close();
  }
});
