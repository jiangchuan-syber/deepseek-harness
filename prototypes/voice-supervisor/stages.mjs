/** Serialize one native parent; quick inputs precede pending deep continuations. */
export class StageQueue {
  constructor({ run, observe }) {
    this.run = run; this.observe = observe;
    this.inputs = []; this.continuations = []; this.current = null;
    this.running = null; this.closed = false; this.seen = new Set(); this.lastError = null;
  }
  snapshot() {
    return { phase: this.current?.phase ?? 'idle', requestId: this.current?.job.requestId,
      queuedInputs: this.inputs.length, pendingContinuations: this.continuations.length, lastError: this.lastError };
  }
  publish(kind, job, extra = {}) { this.observe({ kind, job, ...this.snapshot(), ...extra }); }
  enqueue(job) {
    if (this.closed) throw new Error('Stage queue closed');
    if (this.seen.has(job.requestId)) throw new Error('Duplicate request');
    if (this.inputs.length >= 32) throw new Error('Input queue full');
    this.publish('input.queued', job, { queuedInputs: this.inputs.length + 1 });
    this.seen.add(job.requestId); this.inputs.push(job);
    if (!this.running) this.running = this.drain().catch(error => {
      this.lastError = error.message; this.closed = true; this.current = null;
    }).finally(() => { this.running = null; });
  }
  async drain() {
    while (!this.closed && (this.inputs.length || this.continuations.length)) {
      const phase = this.inputs.length ? 'quick' : 'thinking';
      const batch = phase === 'quick' ? [this.inputs.shift()] : this.continuations.splice(0);
      const job = batch.at(-1);
      this.lastError = null; this.current = { phase, job }; this.publish('phase.started', job, { mergedRequests: batch.map(j => j.requestId) });
      try {
        await this.run(phase, job, batch);
        if (phase === 'quick') this.continuations.push(job);
        this.publish('phase.completed', job);
      } catch (error) { this.lastError = error.message; this.publish('phase.error', job, { error: error.message }); }
      finally { this.current = null; }
    }
    this.publish('queue.idle', null);
  }
  async close() { this.closed = true; await this.running; }
}
