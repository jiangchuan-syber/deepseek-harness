const headers = { 'x-lab-token': '__TOKEN__', 'content-type': 'application/json' };
const el = id => document.getElementById(id);
async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function send(text) {
  try { el('notice').textContent = ''; await post('/send', { text }); el('input').value = ''; }
  catch (error) { el('notice').textContent = error.message; }
}
el('form').addEventListener('submit', event => { event.preventDefault(); void send(el('input').value); });
el('sample').onclick = () => send('请创建后台子任务，用 node worker-task.mjs 校验样例文件。立即告诉我已安排，完成后告诉我真实结果。');
el('progress').onclick = () => send('现在进度怎么样？如果我刚才打断了你，请结合播放回执说明我已经听到了哪部分，然后简短告诉我后台任务状态。');
async function interrupt() { try { await post('/interrupt'); } catch (error) { el('notice').textContent = error.message; } }
el('interrupt').onclick = interrupt;
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void interrupt(); } });
function block(parent, title, text) {
  const item = document.createElement('article'), label = document.createElement('strong'), content = document.createElement('p');
  label.textContent = title; content.textContent = text; item.append(label, content); parent.append(item); return item;
}
let renderedMessages = 0;
async function refresh() {
  try {
    const response = await fetch('/state', { headers }); if (!response.ok) throw new Error('连接失败');
    const state = await response.json();
    el('status').textContent = state.alive ? `已连接 · 主调度器：${state.nativeState.status ?? '准备中'}${state.lastError ? ' · ' + state.lastError : ''}` : '服务已停止：' + state.lastError;
    for (const id of ['send', 'sample', 'progress']) el(id).disabled = state.busy || !state.alive;
    for (const message of state.messages.slice(renderedMessages)) block(el('messages'), message.role, message.text);
    renderedMessages = state.messages.length;
    el('playback').replaceChildren();
    for (const output of state.delivery) {
      const item = block(el('playback'), `${output.role === 'intro' ? '快速接话' : '调度器'} · ${output.state}`, '');
      const played = document.createElement('span'), unplayed = document.createElement('span');
      played.className = 'played'; unplayed.className = 'unplayed'; played.textContent = output.playedText; unplayed.textContent = output.unplayedText;
      item.lastChild.append(played, unplayed);
    }
    el('children').replaceChildren();
    for (const child of state.nativeState.children ?? []) {
      const item = block(el('children'), child.ended ? '已结束' : '执行中', child.id);
      if (!child.ended) { const button = document.createElement('button'); button.textContent = '请求停止此任务'; button.onclick = () => post('/interrupt-child', { childId: child.id }).catch(e => { el('notice').textContent = e.message; }); item.append(button); }
    }
    el('metrics').textContent = state.metrics.map(m => m.firstTokenMs !== undefined ? `接话首字 ${m.firstTokenMs.toFixed(0)} ms · 完整短句 ${m.completeMs.toFixed(0)} ms` : `输入接收 ${m.promptAcceptedMs.toFixed(0)} ms`).join('\n');
    el('workspace').textContent = state.workspace;
  } catch (error) { el('status').textContent = '连接中断：' + error.message; }
  setTimeout(refresh, 200);
}
void refresh();
