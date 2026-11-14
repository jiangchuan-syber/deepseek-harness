/** Bounded input for the tool-free acknowledgement request. */
export const QUICK_SYSTEM = '结合本轮需求，用自然口语接一句，最多30字。例如“稍等，我去查一下。”或“好的，我立刻处理。”。只接话，不解答、不判断能力权限、不路由分派、不声称已执行完成。不用固定开场，不输出路径、代码或工具标记。近期对话仅作背景。';

/** Build a backwards-looking character window; no tool history or main system enters it. */
export function quickInput(history, input, limits) {
  const latest = Array.from(input).slice(-limits.inputChars).join('');
  let remaining = limits.contextChars;
  const selected = [];
  for (let i = history.length - 1; i >= 0 && remaining > 0; i--) {
    const line = `${history[i].role}：${history[i].text}`;
    const chars = Array.from(line);
    const tail = chars.slice(-remaining).join('');
    selected.unshift(tail); remaining -= Array.from(tail).length;
  }
  return { system: QUICK_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text',
    text: (selected.length ? '近期对话（仅供参考）：\n' + selected.join('\n') + '\n' : '') + '本轮输入：\n' + latest }] }],
    historyChars: limits.contextChars - remaining, inputChars: Array.from(latest).length };
}

/** Stop at one sentence or the spoken character cap without inventing an acknowledgement. */
export function shortReply(current, delta, maxChars) {
  let text = current, done = false;
  for (const c of delta) {
    if (c === '<' || c === '\n') { done = true; break; }
    // Leading whitespace or stray punctuation is not speech; a stray sentence end just stops the reply.
    if (!text && /[\s。！？!?，、；：]/u.test(c)) {
      if (/[。！？!?]/u.test(c)) { done = true; break; }
      continue;
    }
    if (Array.from(text).length >= maxChars - 1) { text += '。'; done = true; break; }
    text += c;
    if (/[。！？!?]/u.test(c)) { done = true; break; }
  }
  return { text, done };
}

/** Cancellation of an acknowledgement, never of its original user goal. */
export class QuickSupersededError extends Error {
  constructor() { super('Quick acknowledgement superseded'); this.name = 'QuickSupersededError'; this.code = 'QUICK_SUPERSEDED'; }
}

/** Serial quick calls run independently of the native parent's execution queue.
 * Optional scopeOf identifies a native conversation. With no scope, legacy FIFO
 * is retained; a newer job in the same nonempty scope retires older quick work.
 * Original inputs settle once with an empty quickReply, not a cancelled goal.
 * cancelGraceMs bounds the wait before retaining an unresolved owned call.
 * maxOutstanding bounds active plus retained provider calls; saturation reports
 * a quick failure and preserves the goal. close awaits every owned cleanup.
 */
export class QuickLane {
  constructor({ run, settle, observe, capacity, scopeOf, cancelGraceMs = 0, maxOutstanding = 1 }) {
    this.run = run; this.settle = settle; this.observe = observe; this.capacity = capacity;
    this.jobs = []; this.seen = new Set(); this.running = null; this.closed = false;
    this.controllers = new Set(); this.scopeOf = scopeOf; this.scopes = new WeakMap(); this.executing = null;
    this.cancelGraceMs = cancelGraceMs; this.maxOutstanding = maxOutstanding;
    this.owned = new Set(); this.retired = new Set(); this.probeExecution = null;
  }
  enqueue(job) {
    if (this.closed) throw new Error('Quick lane closed');
    if (this.seen.has(job.requestId)) throw new Error('Duplicate request');
    const scope = this.scopeOf?.(job);
    const sameScope = candidate => typeof scope === 'string' && scope.length > 0 && this.scopes.get(candidate) === scope;
    const retired = this.jobs.filter(sameScope);
    if (this.jobs.length - retired.length >= this.capacity) throw new Error('Quick input queue full');
    this.observe('quick.admitted', job);
    this.seen.add(job.requestId); this.scopes.set(job, scope);
    this.jobs = this.jobs.filter(candidate => !sameScope(candidate)); this.jobs.push(job);
    for (const skipped of retired) this.finish(skipped, '', 'superseded', job.requestId);
    if (this.closed) throw new Error('Quick continuation failed');
    for (const execution of [this.executing, this.probeExecution])
      if (execution && sameScope(execution.job) && !execution.supersededBy) {
        execution.supersededBy = job.requestId;
        execution.controller.abort(new QuickSupersededError());
        if (execution === this.executing) execution.releaseCancellation();
      }
    this.start();
  }
  own(execution, run) {
    this.controllers.add(execution.controller); this.owned.add(execution);
    execution.promise = Promise.resolve().then(run)
      .then(reply => { execution.reply = reply; }, error => { execution.error = error; })
      .finally(() => {
        execution.finished = true; this.controllers.delete(execution.controller);
        this.owned.delete(execution); this.retired.delete(execution);
        if (this.probeExecution === execution) this.probeExecution = null;
      });
  }
  /** Diagnostics require an idle lane and share its tracked provider budget. */
  async probe(job, run) {
    if (this.closed || this.running || this.jobs.length || this.controllers.size)
      throw new Error('Quick diagnostic requires an idle lane');
    const execution = { job, controller: new AbortController(), supersededBy: null, finished: false, error: null };
    this.scopes.set(job, this.scopeOf?.(job)); this.probeExecution = execution;
    const isCurrent = () => !this.closed && this.probeExecution === execution && !execution.supersededBy;
    const disposition = () => execution.supersededBy ? 'superseded' : this.closed ? 'closed' : null;
    this.own(execution, () => run(job, execution.controller, isCurrent, disposition));
    await execution.promise;
    if (execution.error) throw execution.error;
    if (execution.supersededBy || this.closed) throw new QuickSupersededError();
    return execution.reply;
  }
  async waitForRun(execution) {
    const complete = execution.promise.then(() => true);
    const cancelled = execution.cancelled.then(async () => {
      let timer;
      try {
        return await Promise.race([complete, new Promise(resolve => { timer = setTimeout(() => resolve(false), this.cancelGraceMs); })]);
      } finally { clearTimeout(timer); }
    });
    return Promise.race([complete, cancelled]);
  }
  start() {
    if (!this.running && !this.closed) this.running = Promise.resolve().then(() => this.drain()).catch(error => {
      this.closed = true; this.lastError = error.name;
    }).finally(() => { this.running = null; if (!this.closed && this.jobs.length) this.start(); });
  }
  finish(job, reply, outcome, supersededBy) {
    try {
      this.settle({ ...job, quickReply: reply, quickOutcome: outcome, ...(supersededBy ? { supersededBy } : {}) });
      if (outcome === 'superseded') this.observe('quick.superseded', job, { supersededBy });
    } catch (error) {
      this.closed = true; this.lastError = error.name;
      for (const controller of this.controllers) controller.abort();
      this.observe('quick.continuation_failed', job, { errorType: error.name });
    }
  }
  async drain() {
    while (!this.closed && this.jobs.length) {
      const job = this.jobs.shift(), controller = new AbortController();
      if (this.controllers.size >= this.maxOutstanding) {
        this.observe('quick.failed', job, { errorType: 'QuickCleanupBusyError', reason: 'cleanup_capacity',
          outstanding: this.controllers.size });
        this.finish(job, '', 'cleanup_blocked');
        continue;
      }
      const execution = { job, controller, supersededBy: null, finished: false, reply: '', error: null };
      execution.cancelled = new Promise(resolve => { execution.releaseCancellation = resolve; });
      this.executing = execution;
      const isCurrent = () => !this.closed && this.executing === execution && !execution.supersededBy;
      const disposition = () => execution.supersededBy ? 'superseded' : this.closed ? 'closed' : null;
      this.own(execution, () => this.run(job, controller, isCurrent, disposition));
      const complete = await this.waitForRun(execution);
      if (!complete && !execution.finished) {
        this.retired.add(execution);
        this.observe('quick.cleanup_pending', job, { supersededBy: execution.supersededBy,
          outstanding: this.controllers.size, cancelGraceMs: this.cancelGraceMs });
      }
      if (!this.closed) {
        if (execution.supersededBy) this.finish(job, '', 'superseded', execution.supersededBy);
        else {
          if (execution.error) this.observe('quick.failed', job, { errorType: execution.error.name });
          this.finish(job, execution.reply, execution.error ? 'failed' : 'completed');
        }
      }
      this.executing = null;
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await this.running;
    await Promise.allSettled([...this.owned].map(execution => execution.promise));
  }
}
