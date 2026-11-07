import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { Writable } from 'node:stream';

/** Bound diagnostic output only; durable Session logs are never rotated here. */
export class RotatingLog extends Writable {
  constructor(path, maxBytes = 5242880, backups = 3) {
    super(); this.path = path; this.maxBytes = maxBytes; this.backups = backups;
    this.bytes = existsSync(path) ? statSync(path).size : 0;
  }
  _write(chunk, encoding, done) {
    try {
      if (this.bytes && this.bytes + chunk.length > this.maxBytes) {
        for (let i = this.backups; i >= 1; i--) {
          const target = `${this.path}.${i}`, source = i === 1 ? this.path : `${this.path}.${i - 1}`;
          if (i === this.backups && existsSync(target)) unlinkSync(target);
          if (existsSync(source)) renameSync(source, target);
        }
        this.bytes = 0;
      }
      appendFileSync(this.path, chunk); this.bytes += chunk.length; done();
    } catch (error) { done(error); }
  }
}
