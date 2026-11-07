import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { RotatingLog } from '../rotating-log.mjs';
test('diagnostic logs keep current bytes and a bounded set of backups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-log-'));
  try {
    const file = join(dir, 'runtime.log'), log = new RotatingLog(file, 4, 2);
    for (const text of ['1111', '2222', '3333', '4444']) log.write(text);
    log.end(); await finished(log);
    assert.equal(readFileSync(file, 'utf8'), '4444');
    assert.equal(readFileSync(file + '.1', 'utf8'), '3333');
    assert.equal(readFileSync(file + '.2', 'utf8'), '2222');
    assert.equal(readdirSync(dir).length, 3);
  } finally { rmSync(dir, { recursive: true }); }
});
