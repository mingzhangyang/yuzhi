import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';

const roots = [];
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

function png(red) {
  const chunk = (type, data) => {
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

it('cleans only previously generated diff PNGs on successful or missing-image reruns', () => {
  const { before, after } = dirs();
  const diff = join(before, '..', 'diff');
  mkdirSync(diff);
  writeFileSync(join(diff, 'notes.txt'), 'keep me');
  writeFileSync(join(before, 'sample.png'), png(20));
  writeFileSync(join(after, 'sample.png'), png(21));

  const run = () => spawnSync(process.execPath, [command, before, after, diff], { encoding: 'utf8' });
  expect(run().status).toBe(1);
  expect(existsSync(join(diff, 'sample.png'))).toBe(true);
  expect(existsSync(join(diff, '.shot-diff-output.json'))).toBe(true);

  writeFileSync(join(after, 'sample.png'), png(20));
  expect(run().status).toBe(0);
  expect(existsSync(join(diff, 'sample.png'))).toBe(false);
  expect(existsSync(join(diff, 'notes.txt'))).toBe(true);

  writeFileSync(join(after, 'sample.png'), png(21));
  expect(run().status).toBe(1);
  expect(existsSync(join(diff, 'sample.png'))).toBe(true);
  unlinkSync(join(after, 'sample.png'));
  expect(run().status).toBe(1);
  expect(existsSync(join(diff, 'sample.png'))).toBe(false);
});

it('refuses to delete unowned PNGs or input screenshots when diffDir is unsafe', () => {
  const { before, after } = dirs();
  writeFileSync(join(before, 'sample.png'), png(20));
  writeFileSync(join(after, 'sample.png'), png(20));

  const alias = spawnSync(process.execPath, [command, before, after, before], { encoding: 'utf8' });
  expect(alias.status).not.toBe(0);
  expect(alias.stderr).toContain('must not be an input directory');
  expect(existsSync(join(before, 'sample.png'))).toBe(true);

  const diff = join(before, '..', 'diff');
  mkdirSync(diff);
  writeFileSync(join(diff, 'personal.png'), png(11));
  const unowned = spawnSync(process.execPath, [command, before, after, diff], { encoding: 'utf8' });
  expect(unowned.status).not.toBe(0);
  expect(unowned.stderr).toContain('not owned by shot-diff');
  expect(existsSync(join(diff, 'personal.png'))).toBe(true);
});
