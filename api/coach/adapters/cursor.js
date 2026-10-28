/* Cursor Agent CLI.
 *
 * Headless print mode, ask (read-only) so the agent is not invited to edit the workspace, and
 * the prompt is a file in the job directory rather than an argv string. Coach payloads include
 * the exercise library and can exceed a single argument's length limit; the user's words also
 * stay out of the process list. The API key arrives only as CURSOR_API_KEY in the child
 * environment, which is built from scratch in config.jobEnv. */
import fs from 'node:fs';
import path from 'node:path';
import { run } from './spawn.js';

export const CURSOR_BIN = process.env.COACH_CURSOR_BIN || 'agent';

const TASK = [
  'Read the file prompt.md in this workspace and follow it exactly.',
  'Your entire reply must be the JSON object that file requests, with no markdown fence and no other text.',
  'Do not edit or create any files.'
].join(' ');

function parseCursor(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return { text: '', error: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.is_error || parsed.error) {
        const message = typeof parsed.error === 'string' ? parsed.error : (parsed.result || 'Cursor agent failed');
        return { text: '', error: String(message) };
      }
      if (typeof parsed.result === 'string') return { text: parsed.result.trim(), error: '' };
    }
  } catch { /* text format, or a result that is itself the coach JSON */ }
  return { text: raw, error: '' };
}

export default {
  id: 'cursor',
  cli: CURSOR_BIN,

  async check(_cfg, env) {
    const r = await run(CURSOR_BIN, ['--disable-auto-update', '--version'], { env, timeoutMs: 20000 });
    if (r.spawnError) return { ok: false, error: 'the Cursor CLI is not installed in this container' };
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 200) || 'the Cursor CLI could not be run' };
    return { ok: true, version: (r.stdout || '').trim().split('\n')[0] };
  },

  async invoke({ prompt, jobDir, env, model, timeoutMs }) {
    const file = path.join(jobDir, 'prompt.md');
    fs.writeFileSync(file, prompt, { mode: 0o644 });
    const argv = [
      '--disable-auto-update',
      '-p',
      '--output-format', 'json',
      '--mode', 'ask',
      '--trust',
      '--sandbox', 'disabled',
      '--workspace', jobDir
    ];
    if (model) argv.push('--model', String(model));
    argv.push(TASK);
    const r = await run(CURSOR_BIN, argv, { env, cwd: jobDir, timeoutMs });
    const parsed = parseCursor(r.stdout);
    if (r.timedOut || r.spawnError || r.code !== 0) return { ...r, text: parsed.text };
    if (parsed.error) return { ...r, code: 1, text: '', stderr: parsed.error || r.stderr };
    return { ...r, text: parsed.text };
  }
};
