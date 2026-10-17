// The model behind AI dictation (#157), called straight from the browser with
// the user's own key. A provider is `generate(turns, signal)`: the
// conversation so far in, the model's text out. @noprod/pattern's
// generateDictation does the checking and the retry around it. Gemini is the
// only one so far; the interface is where another goes.

import { dictationSystemPrompt, type DictationTurn } from '@noprod/pattern';
import { STRUDEL_DRUM_NAMES, STRUDEL_SYNTHS } from '@noprod/sound';

export type ErrorKind = 'key' | 'quota' | 'network' | 'refused' | 'busy' | 'cancelled' | 'other';

// An error with a message a user can act on
export class DictationError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'DictationError';
    this.kind = kind;
  }
}

export interface DictationProvider {
  id: string;
  label: string;
  keyUrl: string;   // where to get a key
  host: string;     // the only host the key is sent to
  generate(turns: DictationTurn[], signal?: AbortSignal): Promise<string>;
  test(signal?: AbortSignal): Promise<void>;  // one cheap call; throws a DictationError
}

// What a request may carry and what a reply may be
export const LIMITS = { promptChars: 500, codeChars: 4000, outputTokens: 2048 };

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest';

const SYSTEM_PROMPT = dictationSystemPrompt({ drums: STRUDEL_DRUM_NAMES, synths: STRUDEL_SYNTHS });

// The failure a status code stands for
function httpError(status: number, body: any): DictationError {
  const detail = String(body?.error?.message ?? '');
  if (status === 429) return new DictationError('quota', 'Gemini says this key has run out of quota. Wait a little, or check the plan and billing of your Google account.');
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) {
    return new DictationError('key', 'Gemini did not accept this key. Check that you pasted all of it, and that it is switched on for the Gemini API.');
  }
  if (status === 503 || status === 500) return new DictationError('busy', 'Gemini is busy right now. Try again in a moment.');
  return new DictationError('other', `Gemini answered with an error (${status}${detail ? `: ${detail.slice(0, 160)}` : ''}).`);
}

// fetch, with its failures named: no connection, cancelled, or an HTTP error
async function call(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') throw new DictationError('cancelled', 'Cancelled.');
    throw new DictationError('network', 'Could not reach Gemini. Check your connection (and any blocker that stops requests to googleapis.com).');
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* an error page, or nothing */ }
  if (!res.ok) {
    const e = httpError(res.status, body);
    const key = (init.headers as Record<string, string>)['x-goog-api-key'];
    if (key) e.message = e.message.replaceAll(key, '…'); // an error never repeats the key
    throw e;
  }
  return body;
}

export const gemini = (getKey: () => string): DictationProvider => ({
  id: 'gemini',
  label: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  host: 'generativelanguage.googleapis.com',

  async generate(turns, signal) {
    const key = getKey();
    if (!key) throw new DictationError('key', 'Add your API key to dictate.');
    const body = await call(`${GEMINI}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: LIMITS.outputTokens }
      })
    }, signal);
    const blocked = body?.promptFeedback?.blockReason;
    const candidate = body?.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (blocked || !text.trim()) {
      throw new DictationError('refused', 'Gemini declined to answer that. Try describing it differently.');
    }
    if (text.length > LIMITS.codeChars) {
      throw new DictationError('refused', `Gemini's answer was too long to use (over ${LIMITS.codeChars} characters). Ask for something shorter.`);
    }
    return text;
  },

  // Model metadata: validates the key and bills nothing
  async test(signal) {
    const key = getKey();
    if (!key) throw new DictationError('key', 'Paste a key first.');
    await call(GEMINI, { method: 'GET', headers: { 'x-goog-api-key': key } }, signal);
  }
});
