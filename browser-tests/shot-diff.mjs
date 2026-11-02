/**
 * 两批截图逐像素对比（美术优化计划第 4.1 节）：同名文件一一比较，报告差异像素数与最大通道差。
 * 只依赖 Node 自带的 zlib，能读 Playwright 输出的 8 位、非隔行 PNG。
 *
 *   node browser-tests/shot-diff.mjs shots/before shots/after [diffDir]
 *
 * 给出 diffDir 时，为有差异的截图另存一张差异图：差异像素标红，其余像素淡化成灰。
 * 所有同名截图完全一致时退出码为 0；有差异、缺图或尺寸不同时为 1。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || data[12] !== 0) throw new Error('only 8-bit, non-interlaced PNG is supported');
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
      if (!channels) throw new Error(`unsupported PNG color type ${color}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 255;
    }
  }
  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let k = 0; k < width * height; k++) {
    const s = k * channels;
    if (channels >= 3) {
      rgba[k * 4] = px[s];
      rgba[k * 4 + 1] = px[s + 1];
      rgba[k * 4 + 2] = px[s + 2];
    } else {
      rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = px[s];
    }
    rgba[k * 4 + 3] = channels === 4 ? px[s + 3] : channels === 2 ? px[s + 1] : 255;
  }
  return { width, height, rgba };
}

function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [beforeDir, afterDir, diffDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: node browser-tests/shot-diff.mjs <beforeDir> <afterDir> [diffDir]');
  process.exit(2);
}
const before = new Set(readdirSync(beforeDir).filter((f) => f.endsWith('.png')));
const after = new Set(readdirSync(afterDir).filter((f) => f.endsWith('.png')));
let failed = false;
if (diffDir) mkdirSync(diffDir, { recursive: true });
for (const name of [...new Set([...before, ...after])].sort()) {
  if (!before.has(name) || !after.has(name)) {
    console.log(`${name}: only in ${before.has(name) ? beforeDir : afterDir}`);
    failed = true;
    continue;
  }
  const a = decodePng(readFileSync(join(beforeDir, name)));
  const b = decodePng(readFileSync(join(afterDir, name)));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`${name}: size ${a.width}×${a.height} → ${b.width}×${b.height}`);
    failed = true;
    continue;
  }
  let changed = 0;
  let maxDelta = 0;
  const diff = diffDir ? Buffer.alloc(a.rgba.length) : null;
  for (let k = 0; k < a.width * a.height; k++) {
    let d = 0;
    for (let ch = 0; ch < 4; ch++) d = Math.max(d, Math.abs(a.rgba[k * 4 + ch] - b.rgba[k * 4 + ch]));
    if (d) changed++;
    if (d > maxDelta) maxDelta = d;
    if (diff) {
      if (d) diff.set([255, 0, 0, 255], k * 4);
      else {
        const g = 200 + ((a.rgba[k * 4] + a.rgba[k * 4 + 1] + a.rgba[k * 4 + 2]) / 3) * 0.2;
        diff.set([g, g, g, 255], k * 4);
      }
    }
  }
  const pct = ((changed / (a.width * a.height)) * 100).toFixed(3);
  console.log(`${name}: ${changed ? `${changed} px differ (${pct}%), max channel delta ${maxDelta}` : 'identical'}`);
  if (changed) {
    failed = true;
    if (diff) writeFileSync(join(diffDir, name), encodePng(a.width, a.height, diff));
  }
}
process.exit(failed ? 1 : 0);
