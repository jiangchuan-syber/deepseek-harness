/** A real DeepSeek streaming request. No response recording is substituted on failure. */
export async function quickReply({ key, model, text, signal, endpoint = 'https://api.deepseek.com/chat/completions' }) {
  if (!key || !model) throw new Error('An API key and explicit model are required');
  const started = performance.now();
  const response = await fetch(endpoint, { method: 'POST', signal, headers: {
    Authorization: `Bearer ${key}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ model, stream: true, thinking: { type: 'disabled' }, max_tokens: 64,
    messages: [{ role: 'system', content: '你是同一个语音助手的快速接话层，后面主调度器会给正式回答。只说一句8到20字的自然中文确认听到，不提问、不说抱歉、不回答实质内容、不宣布执行状态、不承诺结果、不调用工具。不加引号或标题。例如用户问进度，可以说：收到，我来确认一下当前进展。用户补充要求，可以说：收到，我听到了你的补充。' },
      { role: 'user', content: text }] }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DeepSeek request failed: HTTP ${response.status}`); }
  if (!response.body) throw new Error('DeepSeek returned no stream');
  const decoder = new TextDecoder();
  let buffer = '', result = '', firstTokenMs = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const event = JSON.parse(payload);
      if (event.error) throw new Error('DeepSeek stream returned an error');
      const piece = event.choices?.[0]?.delta?.content;
      if (piece) { firstTokenMs ??= performance.now() - started; result += piece; }
    }
  }
  if (!result.trim()) throw new Error('DeepSeek returned no text');
  return { text: result.trim(), model, thinking: 'disabled', firstTokenMs,
    completeMs: performance.now() - started };
}
