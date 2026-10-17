// The dictation box's state: one request at a time, cancellable, and its
// result for the AI Dictation tab (#157). The model's code is checked and
// retried by @noprod/pattern; applyDictation turns it into tracks.

import { generateDictation } from '@noprod/pattern';
import type { DictationResult } from '../audio/dictation';
import { useDAWStore } from '../store/useDAWStore';
import { getKey } from './key';
import { DictationError, LIMITS, gemini, type DictationProvider } from './provider';

export interface DictationState {
  status: 'idle' | 'sending' | 'done' | 'error';
  code: string | null;
  result: DictationResult | null;
  error: string | null;
}

let state: DictationState = { status: 'idle', code: null, result: null, error: null };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;

export const provider: DictationProvider = gemini(getKey);

export const subscribeDictation = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getDictation = () => state;

const set = (next: DictationState) => { state = next; listeners.forEach((fn) => fn()); };

export function cancelDictation() {
  controller?.abort();
}

export async function dictate(text: string) {
  const prompt = text.trim();
  if (!prompt || controller) return; // one at a time
  if (prompt.length > LIMITS.promptChars) {
    set({ status: 'error', code: null, result: null, error: `That is too long: ${prompt.length} characters, and the limit is ${LIMITS.promptChars}.` });
    return;
  }
  const mine = new AbortController();
  controller = mine;
  set({ status: 'sending', code: null, result: null, error: null });
  try {
    const { code, error } = await generateDictation(prompt, (turns) => provider.generate(turns, mine.signal));
    if (error) {
      set({ status: 'error', code, result: null, error: `The generated code doesn't parse: ${error}` });
    } else {
      const { applyDictation } = await import('../audio/dictation'); // the library loads when first used
      set({ status: 'done', code, result: applyDictation(useDAWStore, code), error: null });
    }
  } catch (e) {
    if (e instanceof DictationError && e.kind === 'cancelled') set({ status: 'idle', code: null, result: null, error: null });
    else set({ status: 'error', code: null, result: null, error: e instanceof Error ? e.message : String(e) });
  } finally {
    controller = null;
  }
}
