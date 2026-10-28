/* Small JSON POST helper for API providers.
 *
 * These providers never spawn a tool-using agent. The request is one shot, the body is capped,
 * and a timeout aborts the socket. Callers turn the result into the adapter contract. */
const CAP = 4 * 1024 * 1024;

async function readLimited(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.length > CAP ? text.slice(0, CAP) : text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks).subarray(0, CAP).toString('utf8');
}

/** POST JSON. Never throws: network failures and timeouts come back as fields. */
export async function postJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await readLimited(res);
    return { ok: res.ok, status: res.status, text, timedOut: false, error: '' };
  } catch (e) {
    const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    return {
      ok: false,
      status: 0,
      text: '',
      timedOut,
      error: timedOut ? 'the request timed out' : (e instanceof Error ? e.message : String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a postJson result onto the adapter invoke shape. `text` is the model answer. */
export function asInvoke(result, text) {
  if (result.timedOut) return { code: -1, text: '', stderr: result.error || 'the request timed out', timedOut: true, spawnError: false };
  if (result.error && !result.status) return { code: 1, text: '', stderr: result.error, timedOut: false, spawnError: false };
  if (!result.ok) return { code: 1, text: '', stderr: `HTTP ${result.status}: ${String(result.text || '').slice(0, 500)}`, timedOut: false, spawnError: false };
  if (!text) return { code: 1, text: '', stderr: 'the endpoint returned no message', timedOut: false, spawnError: false };
  return { code: 0, text, stderr: '', timedOut: false, spawnError: false };
}
