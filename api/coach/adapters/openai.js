/* Any server that speaks the OpenAI chat-completions API.
 *
 * The base URL, key and model are configuration, not code, so the same adapter reaches OpenAI,
 * OpenRouter, Ollama, LM Studio, vLLM and the rest. A missing key is allowed: local servers
 * often ignore Authorization. The key is a header, never part of the URL. */
import { postJson, asInvoke } from './http.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
const SYSTEM = 'You are the openGym Coach. Answer only the supplied task and return exactly the requested JSON. No tools, no markdown fences.';

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join('');
  }
  return '';
}

export default {
  id: 'openai',

  async check(_cfg, env) {
    const base = String(env.OPENAI_BASE_URL || '').trim();
    if (!base) return { ok: false, error: 'set an OpenAI-compatible base URL' };
    try {
      const url = new URL(base);
      return { ok: true, version: url.host };
    } catch {
      return { ok: false, error: 'the base URL is not a valid http(s) URL' };
    }
  },

  async invoke({ prompt, env, model, timeoutMs }) {
    const base = String(env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return { code: 1, text: '', stderr: 'no base URL configured', timedOut: false, spawnError: false };
    const headers = { 'Content-Type': 'application/json' };
    if (env.OPENAI_API_KEY) headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
    const result = await postJson(`${base}/chat/completions`, {
      headers,
      timeoutMs,
      body: {
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt }
        ]
      }
    });
    let text = '';
    if (result.ok) {
      try {
        const json = JSON.parse(result.text);
        text = messageText(json.choices?.[0]?.message?.content).trim();
      } catch {
        return { code: 1, text: '', stderr: 'the endpoint did not return JSON', timedOut: false, spawnError: false };
      }
    }
    return asInvoke(result, text);
  }
};
