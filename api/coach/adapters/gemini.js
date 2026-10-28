/* Google Gemini API (generateContent), API key + model.
 *
 * The key is sent as the x-goog-api-key header, not a query parameter, so it does not land in
 * a proxy access log. Model ids are a single path segment; anything else is rejected before
 * the request is built. */
import { postJson, asInvoke } from './http.js';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
const SYSTEM = 'You are the openGym Coach. Answer only the supplied task and return exactly the requested JSON. No tools, no markdown fences.';

// COACH_GEMINI_API_BASE is a test seam. Production always uses the public Gemini API.
function geminiHost() {
  return (process.env.COACH_GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
}

function modelId(model) {
  const name = String(model || DEFAULT_MODEL).trim().replace(/^models\//, '');
  if (!/^[\w.-]+$/.test(name)) return null;
  return name;
}

function answerText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part?.text || '').join('').trim();
}

export default {
  id: 'gemini',

  async check() {
    return { ok: true, version: 'Gemini API' };
  },

  async invoke({ prompt, env, model, timeoutMs }) {
    const key = String(env.GEMINI_API_KEY || '').trim();
    if (!key) return { code: 1, text: '', stderr: 'missing Gemini API key', timedOut: false, spawnError: false };
    const name = modelId(model);
    if (!name) return { code: 1, text: '', stderr: 'the Gemini model name is not valid', timedOut: false, spawnError: false };
    const result = await postJson(`${geminiHost()}/models/${encodeURIComponent(name)}:generateContent`, {
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      timeoutMs,
      body: {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      }
    });
    let text = '';
    if (result.ok) {
      try {
        const json = JSON.parse(result.text);
        if (json.promptFeedback?.blockReason) {
          return { code: 1, text: '', stderr: `Gemini blocked the request: ${json.promptFeedback.blockReason}`, timedOut: false, spawnError: false };
        }
        text = answerText(json);
      } catch {
        return { code: 1, text: '', stderr: 'Gemini did not return JSON', timedOut: false, spawnError: false };
      }
    } else if (result.text) {
      try {
        const json = JSON.parse(result.text);
        if (json.error?.message) result.text = json.error.message;
      } catch { /* keep the raw body in the HTTP error */ }
    }
    return asInvoke(result, text);
  }
};
