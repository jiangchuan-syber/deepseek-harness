import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Opt-in local experiment. Mount through a dsh profile; no installed source is modified. */
export const name = 'voice-supervisor-lab';
export const inject = ['sessionController', 'agents', 'workspaceRegistry', 'subagents'];
export async function apply(ctx, config) {
  if (!config.token || !config.readyFile || !config.cwd) throw new Error('token, readyFile, cwd required');
  const workspace = await ctx.workspaceRegistry.create(config.cwd, 'Voice supervisor isolated lab');
  const created = await ctx.sessionController.create({ workspaceId: workspace.id });
  const sessionId = created.sessionId;
  const children = new Map();
  const events = [];
  const pending = new Set();
  let sequence = 0, closing = false;
  const record = (type, data) => {
    events.push({ sequence: ++sequence, type, time: Date.now(), data });
    if (events.length > 2000) events.shift();
  };
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId && !children.has(session.id)) return;
    if (['assistant/message', 'turn/start', 'turn/end', 'llm/retry', 'tool/call', 'tool/result', 'user/message'].includes(event.type)) {
      record('session', { sessionId: session.id, event });
    }
  }, { global: true });
  ctx.on('subagent/start', info => { children.set(info.id, { ...info, ended: false }); record('child.started', info); }, { global: true });
  ctx.on('subagent/end', info => { if (children.has(info.id)) {
    children.set(info.id, { ...children.get(info.id), ...info, ended: true }); record('child.ended', info);
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
      sessionId, status: ctx.agents.get(sessionId)?.status ?? 'unloaded', children: [...children.values()], sequence,
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
      const content = [];
      if (input.delivery) content.push({ type: 'text', text: '应用提供的语音播放送达记录。playedText表示设备已播放，不表示用户理解；unplayedText没有播放，不能当作用户已知。保留此记录，不覆盖原始执行历史：\n' + JSON.stringify(input.delivery) });
      content.push({ type: 'text', text: input.text });
      const receipt = await ctx.sessionController.prompt({ sessionId, requestId: input.requestId,
        content, mode: 'steer', clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
      record('prompt.accepted', { requestId: input.requestId });
      return send(202, { ...receipt, sessionId, requestId: input.requestId });
    }
    if (req.method === 'POST' && url.pathname === '/interrupt-child') {
      if (!children.has(input.childId)) throw new Error('Unknown child');
      ctx.subagents.interrupt(input.childId, { kind: 'user', parentSessionId: sessionId });
      return send(202, { requested: true });
    }
    return send(404, { error: 'Not found' });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  writeFileSync(config.readyFile, JSON.stringify({ port: server.address().port, sessionId }));
  ctx.on('dispose', async () => {
    closing = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending]);
  });
}
