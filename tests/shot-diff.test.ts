import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const command = resolve(process.cwd(), 'browser-tests/shot-diff.mjs');

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'yuzhi-shots-'));
  roots.push(root);
  const before = join(root, 'before');
  const after = join(root, 'after');
  mkdirSync(before);
  mkdirSync(after);
  return { before, after };
}

function png(red: number) {
  const chunk = (type: string, data: Buffer) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(data.length);
    return Buffer.concat([n, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 20, 30, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('rejects empty screenshot inputs instead of reporting a false match', () => {
  const { before, after } = dirs();
  const result = spawnSync(process.execPath, [command, before, after], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('non-empty PNG sets');
});

it('rejects one-sided or differing PNGs and accepts a true pixel match', () => {
  const { before, after } = dirs();
  writeFileSync(join(before, 'sample.png'), png(20));
  expect(spawnSync(process.execPath, [command, before, after]).status).toBe(1);
  writeFileSync(join(after, 'sample.png'), png(20));
  expect(spawnSync(process.execPath, [command, before, after]).status).toBe(0);
  writeFileSync(join(after, 'sample.png'), png(21));
  expect(spawnSync(process.execPath, [command, before, after]).status).toBe(1);
});
