// Types for render-loop.mjs, the Jarvis HUD's frame scheduler (vendored; see its header).

export type RenderMode = { standby: boolean };

export type RenderTask = {
  callback: (now: number) => void;
  rate: number | ((mode: RenderMode) => number);
  last: number;
};

export class RenderScheduler {
  tasks: Set<RenderTask>;
  standby: boolean;
  add(callback: (now: number) => void, rate?: number | ((mode: RenderMode) => number)): () => void;
  setStandby(standby: boolean): void;
  schedule(): void;
  destroy(): void;
}

/** The one clock every orb draws on; it stops scheduling while the page is hidden. */
export const renderLoop: RenderScheduler;
