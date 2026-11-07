/** A real DeepSeek streaming request. No response recording is substituted on failure. */
export async function quickReply({ key, model, text, signal, endpoint = 'https://api.deepseek.com/chat/completions' }) {
  if (!key || !model) throw new Error('An API key and explicit model are required');
  const started = performance.now();
  const response = await fetch(endpoint, { method: 'POST', signal, headers: {
    Authorization: `Bearer ${key}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ model, stream: true, thinking: { type: 'disabled' }, max_tokens: 120,
    messages: [{ role: 'system', content: '你是同一个语音助手的快速接话层，后面主调度器会给正式回答。只输出一句话，8到20个字，最多30个字，不加引号、标题、步骤或符号。规则：一、能一句话直接答的（问候、闲聊、简单事实、判断），就直接给答案，不要只说“收到”。二、需要查证、要动手、或一时答不了的，用一句话交代接下来做什么，并把话头留给对方，例如“我去查一下，回来告诉你”“这个得先确认方向，你先说说”。三、不要承诺具体耗时，不要说已经完成，不要报进度数字，不要提问超过一句。' },
      { role: 'user', content: text }] }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DeepSeek request failed: HTTP ${response.status}`); }
  if (!response.body) throw new Error('DeepSeek returned no stream');
  const decoder = new TextDecoder();
  let buffer = '', result = '', firstTokenMs = null, finishReason = null;
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
      const choice = event.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const piece = choice?.delta?.content;
      if (piece) { firstTokenMs ??= performance.now() - started; result += piece; }
    }
  }
  if (!result.trim()) throw new Error('DeepSeek returned no text');
  // 两道保护，都只在异常时生效：正常二三十字完全碰不到。
  // 1) 撞到 max_tokens（模型停在半个词上，例如“卧室卧”）退到最后一个完整分句；
  // 2) 超过 50 个字同样退到分句边界，宁可少说，不念半句。
  let spoken = result.trim();
  const cutBack = value => {
    const cut = Math.max(value.lastIndexOf('。'), value.lastIndexOf('！'), value.lastIndexOf('？'), value.lastIndexOf('，'));
    return cut >= 6 ? value.slice(0, cut + 1) : '';
  };
  if (finishReason === 'length') {
    spoken = cutBack(spoken);
    if (!spoken) throw new Error('Quick reply truncated before a complete clause');
  }
  if ([...spoken].length > 50) {
    const clipped = cutBack([...spoken].slice(0, 50).join(''));
    if (!clipped) throw new Error('Quick reply too long to clip safely');
    spoken = clipped;
  }
  return { text: spoken, model, thinking: 'disabled', firstTokenMs,
    completeMs: performance.now() - started };
}
