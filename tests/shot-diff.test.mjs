import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

it('owns only actually generated diff images, never every input filename', () => {
  const { before, after } = dirs();
  const diff = join(before, '..', 'diff');
  mkdirSync(diff);
  writeFileSync(join(before, 'same.png'), png(10));
  writeFileSync(join(after, 'same.png'), png(10));
  writeFileSync(join(before, 'changed.png'), png(20));
  writeFileSync(join(after, 'changed.png'), png(21));
  writeFileSync(join(before, 'missing.png'), png(20));

  const run = () => spawnSync(process.execPath, [command, before, after, diff], { encoding: 'utf8' });
  expect(run().status).toBe(1);
  const manifestPath = join(diff, '.shot-diff-output.json');
  const first = JSON.parse(readFileSync(manifestPath, 'utf8'));
  expect(first.version).toBe(2);
  expect(first.files).toHaveLength(1);
  expect(first.files[0].name).toBe('changed.png');
  expect(first.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

  // Once differences disappear, the ledger must become empty, even when some
  // input images are still missing. No phantom ownership is allowed.
  writeFileSync(join(after, 'changed.png'), png(20));
  expect(run().status).toBe(1);
  expect(JSON.parse(readFileSync(manifestPath, 'utf8')).files).toEqual([]);
  expect(existsSync(join(diff, 'changed.png'))).toBe(false);

  // A user-created file that has a matching input name is unowned and protected.
  writeFileSync(join(diff, 'missing.png'), png(99));
  const foreign = run();
  expect(foreign.status).not.toBe(0);
  expect(foreign.stderr).toContain('not owned by shot-diff');
  expect(existsSync(join(diff, 'missing.png'))).toBe(true);
});

it('rejects modified generated images and legacy name-only manifests', () => {
  const { before, after } = dirs();
  const diff = join(before, '..', 'diff');
  mkdirSync(diff);
  writeFileSync(join(before, 'sample.png'), png(20));
  writeFileSync(join(after, 'sample.png'), png(21));
  const run = () => spawnSync(process.execPath, [command, before, after, diff], { encoding: 'utf8' });

  expect(run().status).toBe(1);
  writeFileSync(join(diff, 'sample.png'), png(99)); // Someone replaced the diff.
  const modified = run();
  expect(modified.status).not.toBe(0);
  expect(modified.stderr).toContain('was modified');
  expect(readFileSync(join(diff, 'sample.png'))).toEqual(png(99));

  // Old versions declared ownership over all input names and must not be
  // trusted to clean unknown files after upgrading to v2.
  writeFileSync(join(diff, '.shot-diff-output.json'),
    JSON.stringify({ version: 1, files: ['sample.png'] }));
  const legacy = run();
  expect(legacy.status).not.toBe(0);
  expect(legacy.stderr).toContain('legacy shot-diff manifest');
  expect(readFileSync(join(diff, 'sample.png'))).toEqual(png(99));
});
