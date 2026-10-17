// Library work off the main thread (see libraryJobs.ts). Same code, same
// results, as on the main thread. A job that throws answers with its error,
// so the request fails and the next one runs.

import { runJob, type LibraryJob } from './libraryJobs';

type Message = LibraryJob & { id: number };

self.onmessage = (e: MessageEvent<Message>) => {
  const post = (data: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(data, transfer);
  const m = e.data;
  try {
    const { data, transfer } = runJob(m);
    post({ ...data, id: m.id }, transfer);
  } catch (error) {
    post({ id: m.id, error: error instanceof Error ? error.message : String(error) });
  }
};
