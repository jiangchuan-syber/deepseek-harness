/** Project only visible messages and tool traffic; never expose thinking blocks. */
export function visibleText(content) {
  return (Array.isArray(content) ? content : []).filter(item => item.type === 'text').map(item => item.text).join('\n');
}

/** The local bridge receives visible settlements, never native reasoning streams or replay state. */
export function publicSessionEvent(event) {
  if (event.type !== 'assistant/message') return event;
  return { type: event.type, seq: event.seq, time: event.time, data: {
    turn: event.data.turn, step: event.data.step,
    message: { id: event.data.message.id, role: 'assistant',
      content: event.data.message.content.filter(block => ['text', 'tool-call'].includes(block.type)) },
  } };
}

export function traceState(state) {
  return { sessionId: state.sessionId, status: state.status, phase: state.phase, queue: state.queue,
    children: (state.children ?? []).map(child => ({ id: child.id, ended: child.ended,
      stopReason: child.stopReason, provider: child.provider })) };
}

export function nativeTrace(record, parentSessionId) {
  const base = { at: record.time, nativeSequence: record.sequence };
  if (record.type === 'child.started' || record.type === 'child.ended') {
    const ended = record.type === 'child.ended';
    return { ...base, kind: ended ? 'child.ended' : 'child.started', actor: '子代理',
      title: ended ? '子代理运行结束' : '原生子代理已启动', childId: record.data.id,
      text: ended ? visibleText(record.data.lastAssistantMessage) : '',
      details: { provider: record.data.provider, stopReason: record.data.stopReason, runId: record.data.runId } };
  }
  if (record.type !== 'session') return null;
  const { sessionId, event } = record.data;
  const parent = sessionId === parentSessionId;
  const actor = parent ? '主调度器' : '子代理';
  const data = event.data;
  const shared = { ...base, sessionId, childId: parent ? undefined : sessionId, actor,
    nativeType: event.type, nativeEventSequence: event.seq };
  if (event.type === 'assistant/message') {
    const text = visibleText(data.message.content); if (!text) return null;
    if (text.trim() === '无需补充') return null;
    const quick = parent && record.data.phase === 'quick';
    return { ...shared, messageId: data.message.id, kind: quick ? 'front.reply' : parent ? 'scheduler.reply' : 'child.reply',
      title: quick ? '主调度快速回应（思考关闭）' : parent ? '主调度器生成回复' : '子代理生成结果', text };
  }
  if (event.type === 'tool/call') {
    let args; try { args = JSON.parse(data.arguments); } catch { args = data.arguments; }
    return { ...shared, kind: parent && data.name === 'subagent' ? 'task.dispatch' : 'tool.call',
      title: parent && data.name === 'subagent' ? '主调度器通过 subagent 工具委派任务' : `${actor}调用 ${data.name}`,
      callId: data.callId, tool: data.name, details: args };
  }
  if (event.type === 'tool/result') {
    return { ...shared, kind: 'tool.result', title: `${actor}收到工具返回`,
      callId: data.message.toolCallId, text: visibleText(data.message.content),
      details: { isError: data.message.isError } };
  }
  if (event.type === 'user/message' && ['agent-message', 'subagent-settled'].includes(data.source?.kind)) {
    return { ...shared, actor: '子代理 → 主调度器', kind: 'child.relay', title: '子代理消息已进入主调度上下文',
      childId: data.source.senderSessionId, text: visibleText(data.content), details: data.source };
  }
  if (event.type === 'llm/retry') return { ...shared, kind: 'model.retry', title: `${actor}模型重试` };
  return null;
}
