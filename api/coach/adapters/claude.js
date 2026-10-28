/* Claude Agent SDK adapter.
 *
 * This is deliberately the SDK rather than a hand-built `claude --print` invocation. The SDK
 * brings its matching Claude Code runtime with it, receives the owner-created setup token only
 * through the child environment, and keeps the model in a text-in / JSON-out lane: no tools,
 * no settings files, no MCP servers, and no persisted session history. */
import { spawn } from 'node:child_process';
import { unprivilegedIds } from './spawn.js';

// Loaded on use, not at import. The Coach stays optional: a process that never selects Claude
// does not need the SDK installed, and the admin card's runtime check is what reports it missing.
async function loadQuery() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query;
}

const SDK_VERSION = 'Claude Agent SDK 0.3.220';
const OUTPUT_CAP = 4 * 1024 * 1024;
const SYSTEM_PROMPT = [
  'You are the openGym Coach.',
  'Answer only the supplied task and return exactly the requested JSON.',
  'You have no tools, filesystem access, external services, or persistent memory.'
].join(' ');

// The SDK owns the protocol, but Coach still owns the process boundary: its native runtime is
// launched as the same unprivileged `coach` user as the older CLI adapter.
function spawnAsCoach({ command, args, cwd, env, signal }) {
  const ids = unprivilegedIds();
  return spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], ...(ids || {}) });
}

export default {
  id: 'claude',
  runtime: 'Claude Agent SDK',

  async check() {
    // The real round-trip in testRun() then verifies the bundled native runtime and the owner
    // credential together. This only proves the SDK package can be loaded.
    try {
      await loadQuery();
      return { ok: true, version: SDK_VERSION };
    } catch {
      return { ok: false, error: 'the Claude Agent SDK is not installed in this container' };
    }
  },

  async invoke({ prompt, jobDir, env, model, timeoutMs }) {
    let query;
    try { query = await loadQuery(); }
    catch (e) {
      return { code: -1, text: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false, spawnError: true };
    }
    let text = '';
    let failure = '';
    let stderr = '';
    let timedOut = false;
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);

    try {
      for await (const message of query({
        prompt,
        options: {
          abortController,
          cwd: jobDir,
          // `env` replaces rather than extends the SDK subprocess environment. config.jobEnv()
          // creates it from scratch, so this adds no server secrets to the model process.
          env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'opengym-coach/1.2.3' },
          model: model || undefined,
          maxTurns: 1,
          tools: [],
          permissionMode: 'dontAsk',
          settingSources: [],
          skills: [],
          strictMcpConfig: true,
          persistSession: false,
          systemPrompt: SYSTEM_PROMPT,
          stderr: data => { if (stderr.length < OUTPUT_CAP) stderr += data; },
          spawnClaudeCodeProcess: spawnAsCoach
        }
      })) {
        if (message.type !== 'result') continue;
        if (message.subtype === 'success') text = message.result;
        else failure = message.errors?.join('\n') || `Agent SDK stopped: ${message.subtype}`;
      }
    } catch (e) {
      if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
      return {
        code: -1,
        text: '',
        stderr: stderr || (e instanceof Error ? e.message : String(e)),
        timedOut: false,
        spawnError: true
      };
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
    if (failure) return { code: 1, text: '', stderr: failure || stderr, timedOut: false, spawnError: false };
    if (!text) return { code: 1, text: '', stderr: stderr || 'the Agent SDK returned no result', timedOut: false, spawnError: false };
    return { code: 0, text, stderr, timedOut: false, spawnError: false };
  }
};
