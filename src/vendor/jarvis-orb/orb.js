// Vendored from the Jarvis desktop HUD: github.com/luckeyfaraday/daddys-home,
// hud/www/js/orb.js at commit 2fc80b5. Everything below this header is that
// file, byte for byte; resync by copying it again rather than editing here.
// Athena Mobile adapts it in src/components/JarvisOrb.tsx.

// The reactor orb: Jarvis's presence as a living metaball blob. The
// fragment shader raymarches six smooth-min spheres — liquid glass with a
// hot heart — while JS simulates the ball motion. A behavior layer keeps
// it alive between signals: uneven breath, springy reactions that
// overshoot a little, rare unprompted fidgets, saccadic glances, and a
// slow mood that warms with conversation and gets sleepy in silences.

import { renderLoop } from "./render-loop.mjs";

const VERT = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
void main() { gl_Position = vec4(P[gl_VertexID], 0., 1.); }
`;

const FRAG = `#version 300 es
precision highp float;
out vec4 frag;

uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_balls[6];   // metaball centers, orb space
uniform float u_brad[6];   // metaball radii
uniform float u_bright;    // overall presence (muted -> dim)
uniform float u_core;      // inner heat (speaking pulses this)
uniform float u_ripple;    // surface shimmer while sound is flowing
uniform vec2 u_center;     // saccadic lean of the whole orb
uniform float u_flare;     // birth flash: gold floods the heart, then cools

const vec3 ARC = vec3(0.40, 0.878, 1.0);
const vec3 HOT = vec3(0.918, 0.973, 1.0);
const vec3 DEEP = vec3(0.10, 0.30, 0.68);
const vec3 GOLD = vec3(1.0, 0.706, 0.329);

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float map(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < 6; i++) d = smin(d, length(p - u_balls[i]) - u_brad[i], 0.09);
  // sound shimmers the skin
  d -= u_ripple * 0.006 * sin(19.0 * p.x + u_time * 9.0) * sin(16.0 * p.y - u_time * 7.0);
  return d;
}

vec3 surfNormal(vec3 p) {
  vec2 e = vec2(0.002, -0.002);
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y) - u_center;
  vec3 ro = vec3(0.0, 0.0, 1.7);
  vec3 rd = normalize(vec3(uv, -1.4));

  // march only rays that cross the blob's bounding sphere (radius 0.6)
  float b = dot(ro, rd);
  float disc = b * b - (dot(ro, ro) - 0.36);
  vec3 col = vec3(0.0);
  if (disc > 0.0) {
    float t = -b - sqrt(disc);
    float tmax = -b + sqrt(disc);
    float glow = 0.0;
    float hit = -1.0;
    for (int i = 0; i < 48; i++) {
      vec3 p = ro + rd * t;
      float d = map(p);
      glow += exp(-d * 26.0);
      if (d < 0.002) { hit = t; break; }
      t += max(d * 0.9, 0.005);
      if (t > tmax) break;
    }
    // near misses leave an aura hugging the silhouette: arc against the
    // skin, falling off through deep blue before it reaches black
    float aura = glow * 0.02;
    col += mix(DEEP, mix(ARC, GOLD, u_flare * 0.35), smoothstep(0.0, 0.3, aura)) * aura;
    if (hit > 0.0) {
      vec3 p = ro + rd * hit;
      vec3 n = surfNormal(p);
      vec3 r = reflect(rd, n);
      // fake studio: dark floor, pale sky, a hot glint and a cool one
      vec3 env = mix(vec3(0.015, 0.05, 0.09), vec3(0.45, 0.75, 1.0),
                     smoothstep(-0.7, 0.9, r.y));
      env += HOT * pow(max(0.0, dot(r, normalize(vec3(0.6, 0.8, 0.4)))), 48.0);
      env += ARC * pow(max(0.0, dot(r, normalize(vec3(-0.7, -0.2, 0.5)))), 24.0) * 0.5;
      float fres = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);
      // the rim keeps a cyan trace even at full flare: gold floods the
      // heart of a being that stays arc-blue glass
      col = env * 0.28 + fres * mix(mix(ARC, HOT, 0.35), GOLD, u_flare * 0.4) * 1.5;
      // the heart glows through the glass; a birth floods it gold
      float depth = length(p - u_balls[0]);
      vec3 heart = mix(mix(ARC, HOT, min(1.0, u_core)), GOLD, u_flare);
      col += heart * exp(-depth * 7.0) * (0.35 + 1.15 * u_core);
    }
  }
  col *= u_bright;
  float lum = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  frag = vec4(col, lum);
}
`;

// What each conversation state asks of the blob; the render loop springs
// the live values toward these so state changes land instead of fading.
// spread: how far the satellite lobes roam; orbit: how fast they circle;
// react: how much live audio pushes the lobes and shimmers the skin.
const STATES = {
  muted:    { bright: 0.30, spread: 0.60, core: 0.10, orbit: 0.20, react: 0.10 },
  idle:     { bright: 0.85, spread: 1.00, core: 0.28, orbit: 0.45, react: 0.40 },
  hearing:  { bright: 1.15, spread: 1.25, core: 0.45, orbit: 0.70, react: 1.00 },
  thinking: { bright: 1.00, spread: 0.85, core: 0.60, orbit: 2.60, react: 0.30 },
  speaking: { bright: 1.25, spread: 1.10, core: 1.00, orbit: 0.90, react: 1.00 },
};

export function orbFrameRate({
  standby = false,
  reduced = false,
  handsPresent = false,
} = {}) {
  if (reduced) return 4;
  // A 250ms cadence reads as freezing. Fifteen frames keeps the slow breath
  // continuous while still halving the full HUD's quiet rendering cost.
  if (standby) return 15;
  return handsPresent ? 60 : 30;
}

export function createOrb(canvas, hooks = {}) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false });
  if (!gl) return createOrbFallback(canvas);

  const program = buildProgram(gl, VERT, FRAG);
  gl.useProgram(program);
  const loc = (name) => gl.getUniformLocation(program, name);
  const u = {
    res: loc("u_res"), time: loc("u_time"), balls: loc("u_balls"),
    brad: loc("u_brad"), bright: loc("u_bright"), core: loc("u_core"),
    ripple: loc("u_ripple"), center: loc("u_center"), flare: loc("u_flare"),
  };
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.DEPTH_TEST);

  let micLevel = 0, outLevel = 0, shownLevel = 0;
  let state = "idle";
  let noticed = false; // a state change just landed; react to it once

  // Birth flash: gold is the color of something coming alive, so a
  // spawning agent floods the heart gold and it cools back to arc.
  // Tearing the orb open (the two-hand stretch) reveals the same gold —
  // the fan-out is agents being born.
  let flareLevel = 0;

  // Reactions are damped springs, not lerps: attack is stiff and slightly
  // underdamped so responses land with a hint of overshoot (mass reads as
  // a body), release is soft so the orb settles instead of snapping back.
  const live = { ...STATES.idle };
  const vel = { bright: 0, spread: 0, core: 0, orbit: 0, react: 0 };

  // Mood: a slow integral of how busy the session is. Warms in ~20s of
  // activity, takes a couple of quiet minutes to drift toward sleepy.
  let energy = 0.5;

  // Breath phase advances at a wandering rate so no two breaths match.
  let breathPhase = 0, breathDrift = 1;

  // Fidgets: rare unprompted micro-gestures on a randomized idle clock.
  let gesture = null, nextFidget = 4000;

  // Saccadic lean: the orb glances by jumping, holding, drifting home.
  const look = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  let lookHome = 0;

  // The hands (from the gesture daemon, in orb uv space): a pinch within
  // reach grabs the orb, the look spring drags it after the hand, and a
  // release springs it home with the same overshoot the glances have.
  // Both pinches on the orb enter stretch mode: the midpoint drags it,
  // pulling the hands apart tears the cluster open and fans the agent
  // constellation out (reported through hooks.stretched), twisting the
  // pair spins the ring. streak: consecutive feed frames at grab
  // strength — a single-frame MediaPipe jitter spike must not read as a
  // pinch.
  const hands = [
    { present: false, x: 0, y: 0, pinch: 0, streak: 0, at: -1e9 },
    { present: false, x: 0, y: 0, pinch: 0, streak: 0, at: -1e9 },
  ];
  let holders = []; // indices of hands gripping the orb, in grab order
  let span0 = 0, angle0 = 0; // hand separation and axis when the stretch began
  let fanShown = 0; // smoothed stretch, drives the visible tear
  let fanAx = 1, fanAy = 0; // tear axis; outlives the grip so release decays in place

  // The blob: one heart plus five satellite lobes, each with its own
  // orbital plane, pace, and size so the cluster never repeats itself.
  const balls = new Float32Array(18);
  const brads = new Float32Array(6);
  const sats = [];
  for (let i = 0; i < 5; i++) {
    sats.push({
      speed: 0.5 + Math.random() * 0.7,
      phase: Math.random() * 6.28318,
      tilt: (Math.random() - 0.5) * 1.8,
      rad: 0.05 + Math.random() * 0.04,
      orbit: 0.14 + Math.random() * 0.10,
    });
  }
  let orbitPhase = 0;

  let lastFrame = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function glance(mag, now) {
    const dir = Math.random() * 6.28318;
    look.tx = Math.cos(dir) * mag;
    look.ty = Math.sin(dir) * mag * 0.6; // mostly sideways, like eyes
    lookHome = now + 500 + Math.random() * 900;
  }

  function scheduleFidget(now) {
    const base = state === "muted" ? 12000 : 4500;
    nextFidget = now + (base + Math.random() * 11000) * (1.7 - 0.9 * energy);
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame(now) {
    if (reduced && now - lastFrame < 250) return; // ~4fps still frame
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;

    // decay levels so silence settles
    micLevel *= 0.92;
    outLevel *= 0.90;
    shownLevel = Math.max(micLevel, outLevel);
    flareLevel *= Math.exp(-dt / 0.45);

    const calm = state === "idle" || state === "muted";
    const busy = calm ? shownLevel : 1;
    energy += (busy - energy) * Math.min(1, dt / (busy > energy ? 18 : 140));

    if (noticed) {
      noticed = false;
      gesture = null; // whatever it was idly doing, this matters more
      if (!reduced) glance(0.006, now);
    }

    // uneven breath: a wandering rate, two incommensurate harmonics, and a
    // barely-there tremor; sleepier means slower and a touch deeper
    breathDrift += (Math.random() - 0.5) * Math.sqrt(dt) * 0.15
      + (1 - breathDrift) * dt * 0.2;
    breathPhase += dt * 6.28318 / (5.4 - 2.2 * energy) * breathDrift;
    const breathe = (0.010 + 0.004 * (1 - energy)) * Math.sin(breathPhase)
      + 0.004 * Math.sin(breathPhase * 0.618 + 1.7)
      + 0.0012 * Math.sin(now * 0.0093);

    // fidgets fire only while calm, and any real event cancels them
    if (gesture && (now - gesture.t0 > gesture.dur || !calm)) gesture = null;
    if (!reduced && calm && !gesture && now > nextFidget) {
      const kind = ["blink", "glance", "flare", "stutter"][(Math.random() * 4) | 0];
      const dur = { blink: 260, glance: 700, flare: 420, stutter: 500 }[kind];
      gesture = { kind, t0: now, dur };
      if (kind === "glance") glance(0.009, now);
      scheduleFidget(now);
    }
    let gSqueeze = 0, gBright = 0, gCore = 0, gOrbit = 0;
    if (gesture) {
      const e = Math.sin(Math.PI * Math.min(1, (now - gesture.t0) / gesture.dur));
      if (gesture.kind === "blink") { gSqueeze = 0.16 * e; gBright = -0.18 * e; }
      else if (gesture.kind === "flare") gCore = 0.4 * e * e;
      else if (gesture.kind === "stutter") gOrbit = 2.2 * e;
    }

    // mood only recolors the resting states; reactions stay full strength
    const target = STATES[state] || STATES.idle;
    const mood = calm ? 0.72 + 0.4 * energy : 1;
    const goal = {
      bright: target.bright * mood,
      spread: target.spread * (calm ? 0.85 + 0.25 * energy : 1),
      core: target.core * (calm ? 0.8 + 0.4 * energy : 1),
      orbit: target.orbit * mood,
      react: target.react,
    };
    // hand interaction: continuous and zero-dwell, checked every frame
    for (const h of hands) if (now - h.at > 400) h.present = false;
    const wasHeld = holders.length > 0;
    const wasStretch = holders.length === 2;
    holders = holders.filter((i) => hands[i].present && hands[i].pinch > 0.4);
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      if (holders.includes(i) || !h.present || h.streak < 3) continue;
      if (Math.hypot(h.x - look.x, h.y - look.y) < 0.45) holders.push(i);
    }
    if (holders.length === 2 && !wasStretch) {
      const [a, b] = holders.map((i) => hands[i]);
      span0 = Math.max(0.08, Math.hypot(b.x - a.x, b.y - a.y));
      angle0 = Math.atan2(b.y - a.y, b.x - a.x);
    }
    if (wasStretch && holders.length < 2 && hooks.stretched) {
      hooks.stretched(0, 0); // let go: everything springs home
    }
    if (holders.length && !wasHeld) {
      gesture = null; // holding it beats any idle fidget
      energy = Math.min(1, energy + 0.15);
      if (hooks.grabbed) hooks.grabbed(holderPoint(holders, hands));
    }
    if (!holders.length && wasHeld) {
      // spring home; the velocity it was released with is the overshoot
      look.tx = 0;
      look.ty = 0;
      lookHome = 0;
      if (hooks.released) hooks.released(Math.hypot(look.vx, look.vy));
    }
    if (holders.length && hooks.moved) {
      hooks.moved(holderPoint(holders, hands));
    }
    let fan = 0;
    if (holders.length === 2) {
      const [a, b] = holders.map((i) => hands[i]);
      const span = Math.hypot(b.x - a.x, b.y - a.y) || 0.001;
      fanAx = (b.x - a.x) / span;
      fanAy = (b.y - a.y) / span;
      // pulling past the initial grip fans out; twisting the pair is the
      // axis angle since the second hand latched on
      fan = Math.max(0, Math.min(1, (span - span0) / 0.55));
      const turn = Math.atan2(b.y - a.y, b.x - a.x) - angle0;
      if (hooks.stretched) {
        hooks.stretched(fan, Math.atan2(Math.sin(turn), Math.cos(turn)));
      }
      // modest boosts: the grip already heats the heart, and both stack
      goal.spread *= 1 + fan * 1.4;
      goal.bright += fan * 0.3;
      goal.core += fan * 0.2;
      look.tx = Math.max(-0.6, Math.min(0.6, (a.x + b.x) / 2));
      look.ty = Math.max(-0.38, Math.min(0.38, (a.y + b.y) / 2));
      lookHome = now + 1000;
    } else if (holders.length === 1) {
      const h = hands[holders[0]];
      look.tx = Math.max(-0.6, Math.min(0.6, h.x));
      look.ty = Math.max(-0.38, Math.min(0.38, h.y));
      lookHome = now + 1000;
    } else {
      // it notices an open hand nearby: a small lean toward it
      let nearest = null, nearestDist = 0.7;
      for (const h of hands) {
        if (!h.present) continue;
        const d = Math.hypot(h.x - look.x, h.y - look.y);
        if (d < nearestDist) { nearestDist = d; nearest = h; }
      }
      if (nearest) {
        look.tx = nearest.x * 0.05;
        look.ty = nearest.y * 0.05;
        lookHome = now + 400;
      }
    }
    fanShown += (fan - fanShown) * (reduced ? 1 : 0.25);

    if (now > lookHome) { look.tx = 0; look.ty = 0; }
    if (reduced) {
      for (const key in vel) { live[key] = goal[key]; vel[key] = 0; }
      look.x = look.tx;
      look.y = look.ty;
    } else {
      // substep so the stiff attack spring stays stable on slow frames
      const steps = Math.ceil(dt / 0.02), h = dt / steps;
      for (let s = 0; s < steps; s++) {
        for (const key in vel) {
          const k = goal[key] > live[key] ? 120 : 11;
          vel[key] += (k * (goal[key] - live[key]) - 1.5 * Math.sqrt(k) * vel[key]) * h;
          live[key] += vel[key] * h;
        }
        look.vx += (260 * (look.tx - look.x) - 30 * look.vx) * h;
        look.vy += (260 * (look.ty - look.y) - 30 * look.vy) * h;
        look.x += look.vx * h;
        look.y += look.vy * h;
      }
    }
    orbitPhase += dt * (0.4 + live.orbit + gOrbit);

    // place the blob: breath and speech swell it, a blink squeezes it,
    // a grip compresses it, live audio pushes the lobes through `react`
    const grip = holders.length
      ? holders.reduce((sum, i) => sum + hands[i].pinch, 0) / holders.length
      : 0;
    const swell = 1 + breathe * 5 - gSqueeze - 0.10 * grip
      + (state === "speaking" ? outLevel * 0.45 : 0);
    const t = now * 0.001;
    balls[0] = 0.02 * Math.sin(t * 0.21);
    balls[1] = 0.015 * Math.sin(t * 0.17 + 2.0);
    balls[2] = 0.01 * Math.sin(t * 0.13 + 4.0);
    brads[0] = 0.13 * swell;
    const push = live.spread * (0.85 + shownLevel * 0.9 * live.react);
    for (let i = 0; i < 5; i++) {
      const s = sats[i];
      const a = orbitPhase * s.speed + s.phase;
      const R = s.orbit * push;
      balls[(i + 1) * 3]     = Math.cos(a) * R + 0.012 * Math.sin(t * 0.7 * s.speed + i * 3.7);
      balls[(i + 1) * 3 + 1] = Math.sin(a) * Math.cos(s.tilt) * R * 0.85
        + 0.012 * Math.sin(t * 0.6 * s.speed + i * 1.9);
      balls[(i + 1) * 3 + 2] = Math.sin(a) * Math.sin(s.tilt) * R;
      brads[i + 1] = s.rad * swell * (0.9 + 0.15 * Math.sin(t * 0.9 + i * 2.3));
    }

    // motion stretch: the lobes trail the center while it is being
    // dragged or springing home, so the orb pulls like taffy instead of
    // translating rigidly. Outer lobes trail hardest.
    const trailX = Math.max(-0.14, Math.min(0.14, -look.vx * 0.06));
    const trailY = Math.max(-0.14, Math.min(0.14, -look.vy * 0.06));
    for (let i = 0; i < 5; i++) {
      balls[(i + 1) * 3] += trailX * (0.5 + i * 0.25);
      balls[(i + 1) * 3 + 1] += trailY * (0.5 + i * 0.25);
    }

    // stretch tear: while both hands pull, alternating lobes rip toward
    // opposite grab nodes along the hand axis — the cluster splits into
    // two wings around the heart instead of just swelling.
    if (fanShown > 0.005) {
      const tear = fanShown * 0.16;
      for (let i = 0; i < 5; i++) {
        const wing = (i % 2 ? 1 : -1) * (0.6 + 0.2 * (i >> 1));
        balls[(i + 1) * 3] += fanAx * tear * wing;
        balls[(i + 1) * 3 + 1] += fanAy * tear * wing;
      }
    }

    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, now / 1000);
    gl.uniform3fv(u.balls, balls);
    gl.uniform1fv(u.brad, brads);
    gl.uniform1f(u.bright, Math.max(0, live.bright + gBright + 0.2 * grip));
    gl.uniform1f(u.core, live.core + gCore + 0.45 * grip + 0.55 * flareLevel
      + (state === "speaking" ? outLevel * 0.9 : 0));
    gl.uniform1f(u.ripple, live.react * (0.25 + shownLevel * 1.2) + grip * 0.5);
    gl.uniform2f(u.center, look.x, look.y);
    gl.uniform1f(u.flare, Math.min(1, flareLevel + fanShown * 0.65));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  renderLoop.add(
    frame,
    ({ standby }) => orbFrameRate({
      standby,
      reduced,
      handsPresent: hands.some((hand) => hand.present),
    }),
  );

  return {
    setState(next) {
      if (STATES[next] && next !== state) {
        state = next;
        noticed = true;
      }
    },
    setMicLevel(level) { micLevel = Math.max(micLevel, level); },
    setOutLevel(level) { outLevel = Math.max(outLevel, level); },
    // An agent just spawned: full gold, cooling over about a second.
    // Overlapping births simply hold the heart hot.
    flare() {
      flareLevel = 1;
      energy = Math.min(1, energy + 0.1);
    },
    // Feed frames carry no identity, so each incoming hand claims the
    // nearest internal slot: pinch streaks and grips survive the daemon
    // reordering its detections between frames.
    setHands(list) {
      const now = performance.now();
      const claimed = new Set();
      for (const next of (list || []).slice(0, hands.length)) {
        let best = -1;
        let bestDist = Infinity;
        hands.forEach((h, i) => {
          if (claimed.has(i)) return;
          const dist = h.present
            ? Math.hypot(h.x - next.x, h.y - next.y)
            : 10 + i; // cold slots lose to any live one, lowest index first
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        });
        if (best < 0) continue;
        claimed.add(best);
        const h = hands[best];
        h.present = true;
        h.x = next.x;
        h.y = next.y;
        h.pinch = next.pinch || 0;
        h.streak = h.pinch >= 0.85 ? h.streak + 1 : 0;
        h.at = now;
      }
      for (let i = 0; i < hands.length; i++) {
        if (!claimed.has(i)) {
          hands[i].present = false;
          hands[i].streak = 0;
        }
      }
    },
  };
}

// One hand carries the orb directly; two hands carry it by their midpoint
// while their separation and angle remain free for the stretch interaction.
function holderPoint(holders, hands) {
  const held = holders.map((i) => hands[i]);
  return {
    x: held.reduce((sum, hand) => sum + hand.x, 0) / held.length,
    y: held.reduce((sum, hand) => sum + hand.y, 0) / held.length,
    hands: held.length,
  };
}

// Without WebGL2 the orb becomes a quiet breathing disc; the HUD's text
// content still works everywhere.
function createOrbFallback(canvas) {
  const ctx = canvas.getContext("2d");
  let level = 0;
  function frame(now) {
    const w = (canvas.width = canvas.clientWidth);
    const h = (canvas.height = canvas.clientHeight);
    const r = Math.min(w, h) * (0.18 + 0.02 * Math.sin(now / 900) + level * 0.05);
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(w / 2, h / 2, r * 0.2, w / 2, h / 2, r);
    grad.addColorStop(0, "rgba(234,248,255,0.9)");
    grad.addColorStop(0.5, "rgba(102,224,255,0.35)");
    grad.addColorStop(1, "rgba(102,224,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.fill();
    level *= 0.94;
  }
  renderLoop.add(frame, ({ standby }) => orbFrameRate({ standby }));
  return {
    setState() {},
    setMicLevel(l) { level = Math.max(level, l); },
    setOutLevel(l) { level = Math.max(level, l); },
    setHands() {},
    flare() {},
  };
}

export function buildProgram(gl, vertSrc, fragSrc) {
  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}
