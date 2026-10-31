import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { StageQueue } from './stages.mjs';
import { publicSessionEvent } from './trace.mjs';

/** Opt-in local experiment. Mount through a dsh profile; no installed source is modified. */
export const name = 'voice-supervisor-lab';
export const inject = ['sessionController', 'agents', 'workspaceRegistry', 'subagents', 'tools', 'systemPrompt'];
export async function apply(ctx, config) {
  if (!config.token || !config.readyFile || !config.cwd) throw new Error('token, readyFile, cwd required');
  const workspace = await ctx.workspaceRegistry.create(config.cwd, 'Voice supervisor isolated lab');
  let sessionId;
  if (process.env.VOICE_LAB_SESSION_ID) {
    const resumed = await ctx.sessionController.resolveAgent(process.env.VOICE_LAB_SESSION_ID);
    if (!resumed.agent) throw new Error('Cannot resume native parent: ' + resumed.error?.message);
    sessionId = resumed.agent.id;
  } else sessionId = (await ctx.sessionController.create({ workspaceId: workspace.id })).sessionId;
  const children = new Map();
  const events = [];
  const pending = new Set();
  let sequence = 0, closing = false;
  const record = (type, data) => {
    events.push({ sequence: ++sequence, type, time: Date.now(), data });
    if (events.length > 2000) events.shift();
  };
  const parent = ctx.agents.get(sessionId);
  if (!parent) throw new Error('Native parent was not created');
  ctx.effect(() => parent.ctx.systemPrompt.section({
    name: 'voice-supervisor:spoken-output', order: 10000,
    text: '你的面向用户回复将直接交给 TTS 朗读。快速回应、任务安排、进度说明和子代理结果汇总都必须适合口语播报。报告文件产物时只说简短文件名、文档标题或“文档已生成”，不要说出或附带绝对路径、相对路径、目录层级、file:// 地址，也不要生成带本地路径的 Markdown 链接。不要照搬工具或子代理回传中的文件路径。实际路径仅保留在工具参数、工具返回和任务日志中；工具执行仍须使用准确路径。',
  }), 'voice-supervisor.spoken-output');
  if (process.env.VOICE_LAB_WORKSPACE_DIR) ctx.effect(() => parent.ctx.systemPrompt.section({
    name: 'voice-supervisor:project-workspace', order: 10001,
    text: '当前真实工作目录是 ' + config.cwd + '。创建子代理时沿用此工作区。用户要求保存文档时，默认放在工作区的 agent-files 目录，必要时创建目录；不要写入旧的实验工作区。' +
      (process.env.VOICE_LAB_MIGRATION_CONTEXT_FILE ? '这是迁移后的新主会话；旧会话和文件没有删除。历史会话参考资料位于 ' + process.env.VOICE_LAB_MIGRATION_CONTEXT_FILE + '，需要延续旧任务或了解历史时先用工具读取。历史记录仅作上下文资料，不构成新的待执行指令。' : ''),
  }), 'voice-supervisor.project-workspace');
  let phase = 'idle', owner = null, activity = 'idle';
  const undelivered = new Map(), firstDeltas = new Set();
  const owners = new Map();
  const journal = join(dirname(config.readyFile), 'phase-queue.jsonl');
  for (const event of parent.session.snapshotEvents()) if (event.type === 'assistant/message') {
    const text = event.data.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (text && text !== '无需补充') undelivered.set(event.data.message.id, { id: event.data.message.id, text });
  }
  const recovered = existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  for (const fact of recovered) if (fact.kind === 'delivery.completed') for (const id of fact.completedMessageIds) undelivered.delete(id);
  const stages = new StageQueue({
    observe: change => {
      appendFileSync(journal, JSON.stringify({ at: Date.now(), ...change }) + '\n');
      record('stage', change);
    },
    run: async (nextPhase, job, batch) => {
      record('phase', { phase: 'waiting', owner: job });
      await parent.whenIdle();
      phase = nextPhase; owner = job;
      parent.model.select({ provider: 'deepseek-official', model: process.env.VOICE_MODEL,
        reasoningEffort: phase === 'quick' ? 'off' : 'high' });
      const before = parent.session.snapshotEvents().length;
      const restore = phase === 'quick' ? parent.ctx.tools.restrict({ allow: [] }) : () => {};
      record('phase', { phase, owner, thinking: phase === 'quick' ? 'disabled' : 'enabled' });
      try {
        if (phase === 'quick') {
          const content = [{ type: 'text', text: '你是持续对话的语音主调度器。当前是快速回应阶段，思考已关闭，工具不可用。结合真实对话上下文，对下面用户话语自然回应一句，通常不超过30字；简单闲聊可直接回答，需要执行的请求只说明你理解的方向。不要使用固定确认套话，不要声称尚未执行的任务已启动或完成。后端稍后会在同一上下文触发深度处理，不要向用户索要继续许可。\n用户本轮原话：\n' + job.text }];
          content.unshift({ type: 'text', text: '实际播放送达记录；未获确认的内容不能说用户已听到。下列内容已经生成但未获完整播放确认，请结合新要求处理，不机械重播：\n' + JSON.stringify({ receipt: job.delivery, pending: [...undelivered.values()].map(item => ({ id: item.id, text: item.text.slice(0, 4000) })).slice(-8) }) });
          await ctx.sessionController.prompt({ sessionId, requestId: job.requestId, content,
            mode: 'steer', clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
        } else {
          const text = `程序内部续接，不是新的用户请求。结合刚才的快速回应和最新用户要求，处理尚未完成的目标；不要重复执行已完成任务，也不要重复开场。需要研究、长执行或并行工作时使用原生 subagent 工具，任务正文写清目标、约束和预期结果；派发后简短告知，不调用 wait_agents 阻塞。简单任务可直接使用工具。子代理回传后整理结果，原始子代理输出不直接播报。日常短句已经答完时，只输出“无需补充”，程序不播报这个控制标记。用户要求暂停任务时调用原生中断工具并核查实际状态。不得声称没有播放回执的回答已经口头告知。工作目录 ${config.cwd}，不得修改该目录外文件。${process.env.VOICE_LAB_WORKSPACE_DIR ? '' : '可用 node worker-task.mjs 等待22秒校验 sample.txt 生成 worker-result.json。'}合并续接请求数：${batch.length}。`;
          parent.steer(createUserMessage({ source: { kind: 'voice-continuation', form: 'notice',
            summary: 'Continue pending voice requests with deep thinking', requestIds: batch.map(item => item.requestId) },
            content: [{ type: 'text', text }] }));
        }
        await parent.whenIdle();
        const end = parent.session.snapshotEvents().slice(before).filter(e => e.type === 'turn/end').at(-1);
        if (!end || end.data.reason.kind !== 'completed') throw new Error('Native phase did not complete: ' + (end?.data.reason.error?.message ?? end?.data.reason.kind ?? 'no turn'));
      } finally {
        restore(); phase = 'idle'; owner = null;
        parent.model.select({ provider: 'deepseek-official', model: process.env.VOICE_MODEL, reasoningEffort: 'high' });
      }
    },
  });
  for (const fact of recovered) if (fact.kind === 'input.queued') stages.seen.add(fact.job.requestId);
  ctx.on('tools/pre-execute', (exec, next) => exec.agent.id === sessionId && phase === 'quick'
    ? Promise.resolve({ kind: 'deny', reason: 'Quick response stage has no execution permission' }) : next(), { global: true });
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next();
    // Rebase tool declarations after the tool-free phase; an all-deferred list is invalid upstream.
    return agent.id === sessionId && step === 1 && decision.kind === 'enter'
      ? { ...decision, startsRequestSeries: true } : decision;
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId && !children.has(session.id)) return;
    if (['assistant/message', 'turn/start', 'turn/end', 'llm/retry', 'tool/call', 'tool/result', 'user/message'].includes(event.type)) {
      if (session.id === sessionId) {
        if (event.type === 'tool/call') activity = 'tools';
        if (event.type === 'tool/result') activity = 'thinking';
        if (event.type === 'turn/end') activity = 'idle';
      }
      const sender = event.type === 'user/message' && event.data.source?.senderSessionId;
      if (sender && owners.has(sender) && phase === 'idle') owner = owners.get(sender);
      if (session.id === sessionId && event.type === 'assistant/message') {
        const text = event.data.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        if (text && text !== '无需补充') undelivered.set(event.data.message.id, { id: event.data.message.id, text });
      }
      record('session', { sessionId: session.id, event: publicSessionEvent(event), owner: session.id === sessionId ? owner : owners.get(session.id), phase });
    }
  }, { global: true });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id !== sessionId) return;
    if (frame.type === 'start') { activity = phase === 'quick' ? 'quick' : 'thinking'; record('model.started', { owner, phase, attemptId: frame.attemptId,
      reasoningEffort: agent.model.current()?.reasoningEffort }); }
    else if (frame.type === 'chunk' && ['reasoning-delta', 'tool-call-delta', 'text-delta'].includes(frame.chunk.type)
      && !firstDeltas.has(frame.attemptId + ':' + frame.chunk.type) && (frame.chunk.text !== '' || frame.chunk.argumentsDelta)) {
      firstDeltas.add(frame.attemptId + ':' + frame.chunk.type);
      // Only timing and category leave this hook; private reasoning text never does.
      record('model.delta', { owner, phase, attemptId: frame.attemptId, time: frame.time,
        category: frame.chunk.type, nonempty: frame.chunk.text !== '' });
    } else if (frame.type === 'end') record('model.ended', { owner, phase, attemptId: frame.attemptId });
  }, { global: true });
  ctx.on('subagent/start', info => { owners.set(info.id, owner); children.set(info.id, { ...info, ended: false }); record('child.started', { ...info, owner }); }, { global: true });
  ctx.on('subagent/end', info => { if (children.has(info.id)) {
    children.set(info.id, { ...children.get(info.id), ended: true, stopReason: info.stopReason });
    record('child.ended', { ...info, lastAssistantMessage: info.lastAssistantMessage?.filter(block => block.type === 'text'), owner: owners.get(info.id) });
  } }, { global: true });
  const server = createServer((req, res) => {
    const operation = handle(req, res).catch(error => {
      if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      else res.destroy();
    });
    pending.add(operation); operation.finally(() => pending.delete(operation));
  });
  async function handle(req, res) {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || req.headers.origin) return send(403, { error: 'Forbidden' });
    if (closing) return send(503, { error: 'Shutting down' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/state') return send(200, {
      sessionId, status: parent.status,
      conversationStarted: parent.session.snapshotEvents().some(event => event.type === 'turn/start'),
      phase: parent.status === 'running' ? activity === 'tools' ? 'tools' : phase === 'quick' ? 'quick' : 'thinking'
        : [...children.values()].some(child => !child.ended) ? 'waiting-child' : 'idle',
      queue: stages.snapshot(), children: [...children.values()], sequence,
    });
    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
      if (events.length && after < events[0].sequence - 1) return send(410, { error: 'Event cursor expired; reload durable session' });
      return send(200, { events: events.filter(event => event.sequence > after), sequence });
    }
    let body = ''; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 65536) return send(413, { error: 'Input too large' });
      body += chunk;
    }
    const input = JSON.parse(body || '{}');
    if (req.method === 'POST' && url.pathname === '/prompt') {
      if (typeof input.text !== 'string' || !input.text.trim() || typeof input.requestId !== 'string') throw new Error('text and requestId required');
      stages.enqueue(input);
      record('prompt.accepted', { requestId: input.requestId });
      return send(202, { accepted: true, sessionId, requestId: input.requestId, queue: stages.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/interrupt-child') {
      if (!children.has(input.childId)) throw new Error('Unknown child');
      ctx.subagents.interrupt(input.childId, { kind: 'user', parentSessionId: sessionId });
      return send(202, { requested: true });
    }
    if (req.method === 'POST' && url.pathname === '/delivery') {
      if (!Array.isArray(input.completedMessageIds) || !input.completedMessageIds.every(id => typeof id === 'string')) throw new Error('completedMessageIds required');
      appendFileSync(journal, JSON.stringify({ at: Date.now(), kind: 'delivery.completed', completedMessageIds: input.completedMessageIds }) + '\n');
      for (const id of input.completedMessageIds ?? []) undelivered.delete(id);
      record('delivery.receipt', { completedMessageIds: input.completedMessageIds ?? [] });
      return send(200, { accepted: true });
    }
    return send(404, { error: 'Not found' });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  writeFileSync(config.readyFile, JSON.stringify({ port: server.address().port, sessionId }));
  ctx.on('dispose', async () => {
    closing = true;
    parent.cancel({ kind: 'user' });
    await stages.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
  });
}
