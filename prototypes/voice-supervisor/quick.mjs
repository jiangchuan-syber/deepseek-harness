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

/** Serial quick calls run independently of the native parent's execution queue. */
export class QuickLane {
  constructor({ run, settle, observe, capacity }) {
    this.run = run; this.settle = settle; this.observe = observe; this.capacity = capacity;
    this.jobs = []; this.seen = new Set(); this.running = null; this.closed = false;
    this.controllers = new Set();
  }
  enqueue(job) {
    if (this.closed) throw new Error('Quick lane closed');
    if (this.seen.has(job.requestId)) throw new Error('Duplicate request');
    if (this.jobs.length >= this.capacity) throw new Error('Quick input queue full');
    this.observe('quick.admitted', job);
    this.seen.add(job.requestId); this.jobs.push(job);
    this.start();
  }
  start() {
    if (!this.running) this.running = this.drain().catch(error => {
      this.closed = true; this.lastError = error.name;
    }).finally(() => { this.running = null; if (!this.closed && this.jobs.length) this.start(); });
  }
  async drain() {
    while (!this.closed && this.jobs.length) {
      const job = this.jobs.shift(), controller = new AbortController();
      this.controllers.add(controller);
      let reply = '';
      try { reply = await this.run(job, controller); }
      catch (error) { this.observe('quick.failed', job, { errorType: error.name }); }
      finally { this.controllers.delete(controller); }
      if (!this.closed) {
        try { this.settle({ ...job, quickReply: reply }); }
        catch (error) { this.closed = true; this.observe('quick.continuation_failed', job, { errorType: error.name }); }
      }
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await this.running;
  }
}
