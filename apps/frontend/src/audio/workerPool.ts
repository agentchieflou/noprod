// Workers that can't stall the app (#137). Requests wait in priority order
// (lowest first) for the next free worker. A request that fails rejects on
// its own and the queue moves on; a worker that crashes or runs past a
// request's time limit is replaced, and its request rejected. A pool whose
// workers keep dying without finishing anything stops making them, and
// rejects what's left, so callers fall back.

interface Job {
  id: number;
  message: Record<string, unknown>;
  transfer: Transferable[];
  priority: number;
  timeout: number;
  tag?: string;
  resolve: (data: any) => void;
  reject: (error: Error) => void;
}

interface Slot { worker: Worker; job: Job | null; timer?: ReturnType<typeof setTimeout> }

const MAX_FAILURES = 5; // in a row, with nothing finished between

export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 0;
  private failures = 0;
  private broken = false;
  // How many times a worker was replaced (for the tests)
  replaced = 0;
  // Called whenever a worker frees up
  onIdle: () => void = () => {};

  private make: () => Worker;
  private size: number;
  constructor(make: () => Worker, size: number) {
    this.make = make;
    this.size = size;
  }

  // Whether workers can run here at all (they start on first use)
  get available() {
    this.start();
    return !this.broken && this.slots.length > 0;
  }

  get busy() { return this.slots.filter((s) => s.job).length; }
  get queued() { return this.queue.length; }
  get workers() { return this.slots.length; }

  private start() {
    if (this.slots.length || this.broken) return;
    for (let i = 0; i < this.size; i++) {
      const slot = this.spawn();
      if (!slot) { this.broken = true; this.slots = []; return; }
      this.slots.push(slot);
    }
  }

  private spawn(): Slot | null {
    let worker: Worker;
    try {
      worker = this.make();
    } catch {
      return null;
    }
    const slot: Slot = { worker, job: null };
    worker.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => {
      const job = slot.job;
      if (!job || e.data?.id !== job.id) return;
      this.finish(slot);
      this.failures = 0;
      if (e.data.error !== undefined) job.reject(new Error(e.data.error));
      else job.resolve(e.data);
      this.pump();
    };
    worker.onerror = (e) => { e.preventDefault?.(); this.crash(slot, `worker crashed: ${e.message || 'error'}`); };
    worker.onmessageerror = () => this.crash(slot, 'worker message could not be read');
    return slot;
  }

  private finish(slot: Slot) {
    clearTimeout(slot.timer);
    slot.job = null;
  }

  // A worker died or hung: its request fails, a new worker takes its place
  private crash(slot: Slot, reason: string) {
    const job = slot.job;
    this.finish(slot);
    slot.worker.terminate();
    this.failures++;
    const index = this.slots.indexOf(slot);
    const fresh = this.failures < MAX_FAILURES ? this.spawn() : null;
    if (fresh && index >= 0) {
      this.slots[index] = fresh;
      this.replaced++;
    } else if (index >= 0) {
      this.slots.splice(index, 1);
    }
    job?.reject(new Error(reason));
    if (!this.slots.length) {
      this.broken = true;
      for (const j of this.queue.splice(0)) j.reject(new Error('no workers'));
    }
    this.pump();
  }

  // Sends `message` (plus an id) to a worker; resolves with its reply
  run<T = any>(message: Record<string, unknown>, opts: { priority?: number; transfer?: Transferable[]; timeout?: number; tag?: string } = {}): Promise<T> {
    this.start();
    if (this.broken) return Promise.reject(new Error('no workers'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++, message, transfer: opts.transfer ?? [], priority: opts.priority ?? 0,
        timeout: opts.timeout ?? 20000, tag: opts.tag, resolve, reject
      };
      this.enqueue(job);
      this.pump();
    });
  }

  // In priority order, first come first served among equals
  private enqueue(job: Job) {
    let at = this.queue.length;
    while (at > 0 && this.queue[at - 1].priority > job.priority) at--;
    this.queue.splice(at, 0, job);
  }

  // A queued request (by its tag) is wanted sooner
  raise(tag: string, priority: number) {
    const index = this.queue.findIndex((j) => j.tag === tag);
    if (index < 0 || this.queue[index].priority <= priority) return;
    const [job] = this.queue.splice(index, 1);
    job.priority = priority;
    this.enqueue(job);
  }

  private pump() {
    for (const slot of this.slots) {
      if (!this.queue.length) break;
      if (slot.job) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.timer = setTimeout(() => this.crash(slot, `worker took longer than ${job.timeout} ms`), job.timeout);
      try {
        slot.worker.postMessage({ ...job.message, id: job.id }, job.transfer);
      } catch (e) {
        this.finish(slot);
        job.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    if (this.busy < this.slots.length) this.onIdle();
  }
}
