import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { quickReply } from '../front.mjs';

async function withServer(handle, run) {
  const server = createServer(handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/chat/completions`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('streamed front replies disable thinking and preserve split Unicode chunks', async () => {
  await withServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.thinking.type, 'disabled'); assert.equal(input.model, 'configured-model');
    assert.equal(input.messages[1].content, '检查一下');
    const data = Buffer.from('data: {"choices":[{"delta":{"content":"收到，我看看。"}}]}\n\ndata: [DONE]\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(data.subarray(0, 45)); res.end(data.subarray(45));
  }, async endpoint => {
    const result = await quickReply({ key: 'synthetic-test-key', model: 'configured-model', text: '检查一下', endpoint });
    assert.equal(result.text, '收到，我看看。'); assert.ok(result.firstTokenMs >= 0);
    assert.ok(result.completeMs >= result.firstTokenMs);
  });
});
test('provider errors do not print sensitive response bodies or fabricate success', async () => {
  await withServer((_req, res) => { res.writeHead(401); res.end('private response body'); }, async endpoint => {
    await assert.rejects(quickReply({ key: 'synthetic', model: 'm', text: 'x', endpoint }), /^Error: DeepSeek request failed: HTTP 401$/);
  });
});
test('an empty provider stream fails rather than passing as an acknowledgement', async () => {
  await withServer((_req, res) => { res.writeHead(200); res.end('data: [DONE]\n\n'); }, async endpoint => {
    await assert.rejects(quickReply({ key: 'synthetic', model: 'm', text: 'x', endpoint }), /no text/);
  });
});
test('caller cancellation closes a pending front request', async () => {
  await withServer((_req, _res) => {}, async endpoint => {
    await assert.rejects(quickReply({ key: 'synthetic', model: 'm', text: 'x', endpoint,
      signal: AbortSignal.timeout(30) }), /abort|timeout/i);
  });
});
