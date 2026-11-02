import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureFrameLights, measureFrameCost } from '../browser-tests/island-perf-core.mjs';

let oldWindow;
let oldRaf;
let renderer;

beforeEach(() => {
  oldWindow = globalThis.window;
  oldRaf = globalThis.requestAnimationFrame;
  renderer = {
    t: 0,
    lights: [],
    groundKey: 'stable',
    houseCalls: 0,
    renderedLights: [],
    ctx: { getImageData() { return new Uint8Array(4); } },
    step() {},
    drawGround() {},
    drawHouse() {
      this.houseCalls++;
      this.lights.push([5, 6, 7, '255,190,90']);
    },
    drawFireflies() {
      // Dynamic non-stubbed light: a single-frame reference MUST fail here.
      this.lights.push([this.t * 99, 10, 2, '250,250,110']);
    },
    drawLights() {
      this.renderedLights.push(this.lights.map((light) => light.slice()));
    },
    draw() {
      this.lights = [];
      this.drawHouse();
      this.drawFireflies();
      this.drawLights();
    },
  };
  globalThis.window = {
    yuzhi: { renderer },
    __resetPerfFrame() {
      renderer.t = 0;
      renderer.houseCalls = 0;
      renderer.renderedLights = [];
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(0));
    return 1;
  };
});

afterEach(() => {
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
  if (oldRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = oldRaf;
});

const options = { frames: 4, warmup: 1, flush: true, yieldFrames: false, preserveLights: true };

it('keeps animated and painter lights equal in normalized full and skipped-layer samples', async () => {
  const originalHouse = renderer.drawHouse;
  const originalLights = renderer.drawLights;
  const recorded = await captureFrameLights({ frames: options.frames, warmup: options.warmup });
  expect(recorded.frames).toBe(5);
  expect(recorded.firstLights).toBe(2);
  expect(window.__perfLightTimeline[0][1][0]).not.toBe(window.__perfLightTimeline[1][1][0]);

  const full = await measureFrameCost({ ...options, stubs: [] });
  const fullLights = structuredClone(renderer.renderedLights);
  expect(renderer.houseCalls).toBe(5);
  expect(fullLights).toEqual(window.__perfLightTimeline);

  const omitted = await measureFrameCost({ ...options, stubs: ['drawHouse'] });
  expect(renderer.houseCalls).toBe(0);
  expect(renderer.renderedLights).toEqual(fullLights);
  expect(renderer.drawHouse).toBe(originalHouse);
  expect(renderer.drawLights).toBe(originalLights);
  expect(Number.isFinite(full.median)).toBe(true);
  expect(Number.isFinite(omitted.median)).toBe(true);
});

it('intentionally skips glow drawing when measuring the sky-and-lights layer', async () => {
  await captureFrameLights({ frames: options.frames, warmup: options.warmup });
  await measureFrameCost({ ...options, stubs: ['drawLights'] });
  expect(renderer.renderedLights).toHaveLength(0);
  expect(renderer.houseCalls).toBe(5);
});

it('rejects missing light timelines and restores patched methods after an error', async () => {
  await expect(measureFrameCost({ ...options, stubs: ['drawHouse'] }))
    .rejects.toThrow('timeline missing');
  await captureFrameLights({ frames: options.frames, warmup: options.warmup });
  const originalHouse = renderer.drawHouse;
  const originalLights = renderer.drawLights;
  renderer.ctx.getImageData = () => { throw new Error('test readback failure'); };
  await expect(measureFrameCost({ ...options, stubs: ['drawHouse'] }))
    .rejects.toThrow('test readback failure');
  expect(renderer.drawHouse).toBe(originalHouse);
  expect(renderer.drawLights).toBe(originalLights);
});
