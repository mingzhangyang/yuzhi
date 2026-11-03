/**
 * Browser-side frame sampling helpers. Both functions are deliberately self-contained
 * so Playwright can serialize them directly into page.evaluate().
 *
 * The light timeline is captured with every painter intact at the exact same
 * animation frames used by each subsequent measurement. Both the full baseline
 * and skipped-layer samples then execute the same drawLights() adapter, whose
 * only work is selecting the recorded frame before rendering the glow.
 */

/** Capture full-render lighting for each warmup and timed frame, outside all timers. */
export async function captureFrameLights({ frames, warmup }) {
  const r = window.yuzhi.renderer;
  window.__resetPerfFrame();
  const timeline = [];
  try {
    for (let k = 0; k < warmup + frames; k++) {
      r.t += 1 / 30;
      r.step(1 / 30);
      r.draw();
      timeline.push(r.lights.map((light) => [...light]));
    }
    window.__perfLightTimeline = timeline;
    // Drain any queued Canvas commands so trace generation cannot contaminate
    // the immediately following full-frame timing sample.
    r.ctx.getImageData(0, 0, 1, 1);
    return { frames: timeline.length, firstLights: timeline[0].length, lastLights: timeline[timeline.length - 1].length };
  } finally {
    window.__resetPerfFrame();
  }
}

/**
 * Measure the same workload from an identical simulation snapshot on each run.
 *
 * When preserveLights is enabled, drawLights() uses the full-render per-frame
 * timeline for BOTH the baseline (no stubs) and each painter omission. Thus:
 *   - moving lights (fireflies, etc.) match the corresponding simulated frame;
 *   - glow drawing and adapter overhead are identical in both measurements;
 *   - validation/trace capture and array cloning happen outside timed frames.
 *
 * The estimated savings remain an upper bound: skipped painters also skip their
 * own lightweight light registrations, which a real cache may have to replay.
 */
export async function measureFrameCost({ frames, warmup, flush, stubs, yieldFrames, preserveLights }) {
  const r = window.yuzhi.renderer;
  const ctx = r.ctx;
  const count = frames + warmup;
  if (!Number.isInteger(frames) || frames < 1 || warmup < 0) {
    throw new Error('PERF_FRAMES must be a positive integer');
  }

  const timeline = preserveLights ? window.__perfLightTimeline : null;
  if (preserveLights && (!Array.isArray(timeline) || timeline.length !== count)) {
    throw new Error('Full-frame light timeline missing or has a different frame count');
  }

  // Reset before each test so independent layer samples start from the exact same
  // positions, RNG state, time, particles, and walker destinations.
  window.__resetPerfFrame();
  const saved = stubs.map((name) => {
    if (typeof r[name] !== 'function') throw new Error('Unknown painter: ' + name);
    return [name, r[name]];
  });
  const originalDrawLights = r.drawLights;
  const originalDrawGround = r.drawGround;
  let groundBuilds = 0;
  let frameIndex = -1;
  const skipLights = stubs.includes('drawLights');

  try {
    for (const [name] of saved) if (name !== 'drawLights') r[name] = () => {};
    if (preserveLights) {
      r.drawLights = function () {
        // Every sample, including the sky-and-lights omission, pays the same
        // light-frame lookup and assignment. Only the actual glow draw is skipped.
        this.lights = timeline[frameIndex];
        if (!skipLights) return originalDrawLights.call(this);
      };
    } else if (skipLights) {
      r.drawLights = () => {};
    }
    r.drawGround = function (scene) {
      const before = this.groundKey;
      originalDrawGround.call(this, scene);
      if (this.groundKey !== before) groundBuilds++;
    };

    const times = [];
    for (let k = 0; k < count; k++) {
      if (yieldFrames || k === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
      const t0 = performance.now();
      r.t += 1 / 30;
      r.step(1 / 30);
      frameIndex = k;
      r.draw();
      if (flush) ctx.getImageData(0, 0, 1, 1);
      if (k >= warmup) times.push(performance.now() - t0);
    }
    const sorted = times.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { median: q(0.5), p95: q(0.95), long: times.filter((t) => t > 50).length, groundBuilds };
  } finally {
    for (const [name, fn] of saved) r[name] = fn;
    r.drawLights = originalDrawLights;
    r.drawGround = originalDrawGround;
  }
}
