// Types for orb.js, the Jarvis HUD's orb (vendored; see its header).

import type { JarvisOrbState } from "../../jarvis";

export type OrbHand = { x: number; y: number; pinch?: number };

export type Orb = {
  setState(state: JarvisOrbState): void;
  /** What Jarvis hears, 0..1; held at the loudest and decaying each frame. */
  setMicLevel(level: number): void;
  /** How loud Jarvis speaks, 0..1; held at the loudest and decaying each frame. */
  setOutLevel(level: number): void;
  setHands(hands: OrbHand[] | null): void;
  /** A gold flash, as when an agent is born. */
  flare(): void;
};

export type OrbHooks = {
  grabbed?: (point: { x: number; y: number; hands: number }) => void;
  moved?: (point: { x: number; y: number; hands: number }) => void;
  released?: (speed: number) => void;
  stretched?: (fan: number, angle: number) => void;
};

/** A WebGL2 orb on `canvas`, or a breathing 2D disc without WebGL2; it draws on renderLoop. */
export function createOrb(canvas: HTMLCanvasElement, hooks?: OrbHooks): Orb;

export function orbFrameRate(options?: { standby?: boolean; reduced?: boolean; handsPresent?: boolean }): number;

export function buildProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram;
