// Vendored from the Jarvis desktop HUD: github.com/luckeyfaraday/daddys-home,
// hud/www/js/render-loop.mjs at commit 2fc80b5. Everything below this header is that
// file, byte for byte; resync by copying it again rather than editing here.
// Athena Mobile adapts it in src/components/JarvisOrb.tsx.

// One lifecycle-aware clock for every continuously animated HUD surface.
// Each surface declares its draw rate, standby can suspend nonessential
// canvases, and hidden pages stop scheduling altogether.

export class RenderScheduler {
  constructor({ raf, caf, document: doc } = {}) {
    this.raf = raf ?? globalThis.requestAnimationFrame?.bind(globalThis);
    this.caf = caf ?? globalThis.cancelAnimationFrame?.bind(globalThis);
    this.document = doc ?? globalThis.document;
    this.tasks = new Set();
    this.handle = 0;
    this.standby = false;
    this.tick = this.tick.bind(this);
    this.visibilityChanged = this.visibilityChanged.bind(this);
    this.document?.addEventListener?.("visibilitychange", this.visibilityChanged);
  }

  add(callback, rate = 60) {
    const task = { callback, rate, last: -Infinity };
    this.tasks.add(task);
    this.schedule();
    return () => this.tasks.delete(task);
  }

  setStandby(standby) {
    this.standby = Boolean(standby);
    for (const task of this.tasks) task.last = -Infinity;
    this.schedule();
  }

  visibilityChanged() {
    if (this.document?.hidden) {
      if (this.handle && this.caf) this.caf(this.handle);
      this.handle = 0;
      return;
    }
    for (const task of this.tasks) task.last = -Infinity;
    this.schedule();
  }

  schedule() {
    if (this.handle || !this.raf || this.document?.hidden || !this.tasks.size) return;
    this.handle = this.raf(this.tick);
  }

  tick(now) {
    this.handle = 0;
    const mode = { standby: this.standby };
    for (const task of this.tasks) {
      const fps = typeof task.rate === "function" ? task.rate(mode) : task.rate;
      if (!(fps > 0)) continue;
      if (now - task.last + 0.5 < 1000 / fps) continue;
      task.last = now;
      task.callback(now);
    }
    this.schedule();
  }

  destroy() {
    if (this.handle && this.caf) this.caf(this.handle);
    this.handle = 0;
    this.tasks.clear();
    this.document?.removeEventListener?.("visibilitychange", this.visibilityChanged);
  }
}

export const renderLoop = new RenderScheduler();
