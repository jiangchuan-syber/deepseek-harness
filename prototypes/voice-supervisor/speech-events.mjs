/** Bounded stream of visible parent text. Expired cursors fail closed. */
export class SpeechEvents {
  constructor(limit = 2000) { this.limit = limit; this.sequence = 0; this.events = []; this.clients = new Set(); this.closed = false; }
  push(event) {
    const item = { ...event, sequence: ++this.sequence };
    this.events.push(item); if (this.events.length > this.limit) this.events.shift();
    for (const client of this.clients) {
      if (!client.write(`id: ${item.sequence}\ndata: ${JSON.stringify(item)}\n\n`)) client.destroy();
    }
    return item;
  }
  subscribe(after, res) {
    if (this.closed) { res.writeHead(503); res.end(); return; }
    if (!Number.isSafeInteger(after) || after < 0) { res.writeHead(400); res.end(); return; }
    if (this.events.length && after < this.events[0].sequence - 1) { res.writeHead(410); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': connected\n\n');
    for (const item of this.events) if (item.sequence > after) res.write(`id: ${item.sequence}\ndata: ${JSON.stringify(item)}\n\n`);
    this.clients.add(res);
    const heartbeat = setInterval(() => res.write(': alive\n\n'), 10000);
    res.on('close', () => { clearInterval(heartbeat); this.clients.delete(res); });
  }
  close() {
    this.closed = true;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
