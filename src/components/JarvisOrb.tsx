import { useEffect, useImperativeHandle, useRef, type CSSProperties, type Ref } from "react";
import { createOrb, type Orb } from "../vendor/jarvis-orb/orb.js";
import { renderLoop, type RenderTask } from "../vendor/jarvis-orb/render-loop.mjs";
import type { JarvisOrbState } from "../jarvis";

// Jarvis's orb from its desktop HUD (src/vendor/jarvis-orb, untouched): a
// WebGL2 metaball blob, or a breathing disc where WebGL2 is missing. It draws
// on the HUD's own clock at the HUD's rates (orbFrameRate: 30 frames a second,
// 15 in standby, 4 with reduced motion), and only while it's on screen with
// the app in front: the clock itself stops while the page is hidden, and the
// orb leaves it while it's out of view.

export type JarvisOrbHandle = {
  /** How loud Jarvis speaks, 0..1. */
  setOutLevel(level: number): void;
  /** What Jarvis hears, 0..1. */
  setMicLevel(level: number): void;
};

// The playback level is read as often as the orb draws.
const SAMPLE_HZ = 30;

type LiveOrb = { orb: Orb; tasks: RenderTask[]; disposeTimer: number | undefined };

// One orb per canvas. React's development double mount runs the effect twice
// on the same canvas; the second run takes the first's orb back instead of
// building another on a context that's being released.
const orbs = new WeakMap<HTMLCanvasElement, LiveOrb>();

export function JarvisOrb({
  state,
  standby,
  sampleOut,
  className,
  style,
  ref,
}: {
  state: JarvisOrbState;
  /** Small and calm: draw at the HUD's standby rate. */
  standby: boolean;
  /** Jarvis's voice level as it plays on this phone, or null while it isn't. */
  sampleOut: () => number | null;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<JarvisOrbHandle>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const orbRef = useRef<Orb | null>(null);
  const sample = useRef(sampleOut);
  sample.current = sampleOut;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let live = orbs.get(canvas);
    if (live) {
      window.clearTimeout(live.disposeTimer);
    } else {
      // createOrb adds its frame to the shared clock without handing it back;
      // the tasks that appear are this orb's, so they can be paused.
      const before = new Set(renderLoop.tasks);
      const orb = createOrb(canvas);
      renderLoop.add(() => {
        const level = sample.current();
        if (level !== null) orb.setOutLevel(level);
      }, SAMPLE_HZ);
      live = { orb, tasks: [...renderLoop.tasks].filter((task) => !before.has(task)), disposeTimer: undefined };
      orbs.set(canvas, live);
    }
    const current = live;
    orbRef.current = current.orb;
    const run = (on: boolean) => {
      for (const task of current.tasks) {
        if (!on) renderLoop.tasks.delete(task);
        else if (!renderLoop.tasks.has(task)) {
          task.last = -Infinity;
          renderLoop.tasks.add(task);
        }
      }
      if (on) renderLoop.schedule();
    };
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      run(false);
      observer = new IntersectionObserver((entries) => run(entries.some((entry) => entry.isIntersecting)));
      observer.observe(canvas);
    } else {
      run(true);
    }
    return () => {
      observer?.disconnect();
      run(false);
      orbRef.current = null;
      current.disposeTimer = window.setTimeout(() => {
        orbs.delete(canvas);
        // Release the GPU now rather than when the canvas is collected: phones allow only a few contexts.
        canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      }, 0);
    };
  }, []);

  useEffect(() => {
    orbRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    renderLoop.setStandby(standby);
    return () => renderLoop.setStandby(false);
  }, [standby]);

  useImperativeHandle(
    ref,
    () => ({
      setOutLevel: (level) => orbRef.current?.setOutLevel(level),
      setMicLevel: (level) => orbRef.current?.setMicLevel(level),
    }),
    [],
  );

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
