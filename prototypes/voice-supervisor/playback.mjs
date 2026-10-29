/** Deterministic virtual audio queue. Device integration must supply its own sample alignment. */
export class PlaybackQueue {
  constructor({ charsPerSecond }) {
    if (!(charsPerSecond > 0)) throw new Error('charsPerSecond must be positive');
    this.speed = charsPerSecond;
    this.now = 0;
    this.epoch = 0;
    this.outputs = [];
    this.events = [];
    this.turns = new Map();
    this.playing = null;
  }
  begin(turnId) {
    if (this.turns.has(turnId)) throw new Error('duplicate turn');
    this.turns.set(turnId, { intro: 'pending' });
    return this.epoch;
  }
  offer({ turnId, role, text, epoch }) {
    if (epoch !== this.epoch) return null;
    const turn = this.turns.get(turnId);
    if (!turn || !['intro', 'answer'].includes(role) || !text.trim()) throw new Error('invalid output');
    if (role === 'intro') {
      if (turn.intro !== 'pending') throw new Error('duplicate intro');
      turn.intro = 'queued';
    }
    const output = { id: `output-${this.outputs.length + 1}`, turnId, role, text,
      epoch, state: 'queued', playedChars: 0, elapsed: 0, readyAt: this.now };
    this.outputs.push(output);
    return output.id;
  }
  failIntro(turnId) {
    const turn = this.turns.get(turnId);
    if (turn?.intro === 'pending') turn.intro = 'failed';
  }
  next() {
    for (const item of this.outputs) {
      if (item.state !== 'queued' || item.epoch !== this.epoch) continue;
      const turn = this.turns.get(item.turnId);
      if (item.role === 'answer' && !['completed', 'failed'].includes(turn.intro)) continue;
      return item;
    }
    return null;
  }
  advance(milliseconds) {
    if (!(milliseconds >= 0)) throw new Error('negative advance');
    let remaining = milliseconds;
    for (;;) {
      if (!this.playing) {
        this.playing = this.next();
        if (!this.playing) { this.now += remaining; return; }
        this.playing.state = 'playing';
        this.playing.startedAt = this.now;
        this.events.push({ type: 'started', id: this.playing.id, role: this.playing.role, at: this.now });
      }
      const item = this.playing;
      const duration = Array.from(item.text).length / this.speed * 1000;
      const consumed = Math.min(remaining, duration - item.elapsed);
      item.elapsed += consumed;
      this.now += consumed;
      remaining -= consumed;
      item.playedChars = Math.min(Array.from(item.text).length, Math.floor(item.elapsed * this.speed / 1000 + 1e-8));
      if (item.elapsed + 1e-8 < duration) return;
      item.state = 'completed';
      item.completedAt = this.now;
      if (item.role === 'intro') this.turns.get(item.turnId).intro = 'completed';
      this.events.push({ type: 'completed', id: item.id, role: item.role, at: this.now });
      this.playing = null;
      if (remaining <= 0) return;
    }
  }
  interrupt() {
    const priorEpoch = this.epoch;
    if (this.playing) {
      this.playing.state = 'interrupted';
      this.events.push({ type: 'interrupted', id: this.playing.id, at: this.now,
        playedChars: this.playing.playedChars });
      this.playing = null;
    }
    for (const item of this.outputs) if (item.state === 'queued') item.state = 'dropped';
    this.epoch += 1;
    return { priorEpoch, epoch: this.epoch, outputs: this.delivery() };
  }
  delivery() {
    return this.outputs.map(item => {
      const chars = Array.from(item.text);
      return { outputId: item.id, turnId: item.turnId, role: item.role, state: item.state,
        playedText: chars.slice(0, item.playedChars).join(''),
        unplayedText: chars.slice(item.playedChars).join(''),
        alignment: 'virtual-character-clock', epoch: item.epoch };
    });
  }
}
