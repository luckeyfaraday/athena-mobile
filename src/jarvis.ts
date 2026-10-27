// Jarvis on the phone: where it lives, and how its feed reads as a chat. Pure
// helpers with no runtime imports, so node --test can load this file directly.
// The network side is src/api/jarvisClient.ts; the screen is JarvisView.
//
// Jarvis is the user's licensed voice assistant on one of their computers.
// Athena on that computer serves it on the control API (GET /jarvis,
// /jarvis/events, POST /jarvis/ask|mic|launch); these types mirror
// context-workspace client/electron/jarvis-companion.ts.
//
// Asked from the phone, Jarvis answers on the phone only: Athena hands back
// the reply's turn, and Jarvis's own voice arrives sentence by sentence
// (jarvis-audio events, then /jarvis/audio/<turn>/<seq>) while its computer
// stays quiet. A reply with no audio shows as text only.

export type JarvisActivity = "idle" | "listening" | "thinking" | "speaking";

export type JarvisLicense = {
  licensed: boolean;
  /** Why the license doesn't count; null when licensed. */
  detail: string | null;
  offlineUntil: number | null;
  licenseId: string | null;
  keyMasked: string | null;
  /** The computer Jarvis was activated on. */
  instanceName: string | null;
};

export type JarvisAgent = { name: string; cwd: string | null; task: string | null; working: boolean; focused: boolean; status: string | null };

/**
 * heard: what the user said (or typed; typed requests usually come back as
 * "asked"). said: Jarvis's reply, one item growing sentence by sentence.
 * announce: Jarvis telling the user something. agent: an agent's event.
 */
export type JarvisFeedKind = "heard" | "said" | "announce" | "agent" | "asked";

/** `turn`: the turn Jarvis gave a typed request and its reply, when it names one. */
export type JarvisFeedItem = { id: number; at: number; kind: JarvisFeedKind; text: string; agent?: string; turn?: string };

/** One sentence of a reply Jarvis spoke for a phone, or (final) the end of it, as Athena announces them. */
export type JarvisAudioEvent = { turn: string; seq: number; final: boolean; interrupted: boolean };

export type JarvisState = {
  license: JarvisLicense;
  installPath: string | null;
  running: boolean;
  connected: boolean;
  micOpen: boolean | null;
  activity: JarvisActivity;
  partial: string | null;
  provider: string | null;
  model: string | null;
  agents: JarvisAgent[];
  /** Newest last, at most 60. */
  feed: JarvisFeedItem[];
  lastError: string | null;
  updatedAt: number;
};

/**
 * Where a Jarvis can be reached: the server's configured mount, the host's
 * Athena, or another machine's Athena through the host. `base` is that
 * Athena's control API on this origin; Jarvis is at `${base}/jarvis`.
 */
export type JarvisLocation = {
  kind: "configured" | "host" | "machine";
  base: string;
  machineId: string | null;
  /** The machine's name; null for the configured mount, which learns it from Jarvis's license. */
  name: string | null;
  /** The configured mount's target host, as the server reports it (X-Athena-Jarvis-Host). */
  host?: string | null;
};

/** One GET /jarvis, as the client saw it. */
export type JarvisProbe = (
  | { kind: "ok"; state: JarvisState }
  | { kind: "http"; status: number; error: string | null }
  | { kind: "unreachable"; error: string }
) & { host?: string | null };

export type JarvisFindingStatus =
  | "ready" // licensed and running
  | "not-running" // licensed, Jarvis closed
  | "not-licensed" // Jarvis is there without a license
  | "absent" // Athena answers, no Jarvis there at all
  | "too-old" // Athena predates Jarvis (404)
  | "unreachable"
  | "not-configured"; // the /athena-jarvis mount is off

export type JarvisFinding = {
  location: JarvisLocation;
  status: JarvisFindingStatus;
  state: JarvisState | null;
  /** The answer's own words when it failed. */
  detail: string | null;
};

const ACTIVITIES: readonly JarvisActivity[] = ["idle", "listening", "thinking", "speaking"];
const FEED_KINDS: readonly JarvisFeedKind[] = ["heard", "said", "announce", "agent", "asked"];
const RANK: Record<JarvisFindingStatus, number> = {
  ready: 0,
  "not-running": 1,
  "not-licensed": 2,
  absent: 3,
  "too-old": 4,
  unreachable: 5,
  "not-configured": 6,
};
/** A typed request can come back as both "asked" and "heard"; show it once. */
export const ECHO_WINDOW_MS = 8_000;
/** A gap this long between feed items gets a time label. */
const TIME_GAP_MS = 10 * 60_000;

// ── Parsing ────────────────────────────────────────────────────────────────

/** The `jarvis` field of an answer from Athena (`{ jarvis }`, or an error's `{ error, jarvis }`). */
export function jarvisFromBody(body: unknown): JarvisState | null {
  return isRecord(body) ? parseJarvisState(body.jarvis) : null;
}

/** The turn an ask's answer names (`{ jarvis, turn }`); null from an Athena or Jarvis that predates turns. */
export function jarvisTurnFromBody(body: unknown): string | null {
  return isRecord(body) ? text(body.turn) : null;
}

/** A `jarvis-audio` event's data; null if it isn't one. */
export function parseJarvisAudioEvent(value: unknown): JarvisAudioEvent | null {
  if (!isRecord(value) || !text(value.turn) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return null;
  return { turn: value.turn as string, seq: value.seq as number, final: value.final === true, interrupted: value.interrupted === true };
}

/** A JarvisState from untrusted JSON, with defaults for fields an older or newer Athena leaves out; null if it isn't one. */
export function parseJarvisState(value: unknown): JarvisState | null {
  if (!isRecord(value) || !isRecord(value.license) || typeof value.running !== "boolean") return null;
  const license = value.license;
  return {
    license: {
      licensed: license.licensed === true,
      detail: text(license.detail),
      offlineUntil: number(license.offlineUntil),
      licenseId: text(license.licenseId),
      keyMasked: text(license.keyMasked),
      instanceName: text(license.instanceName),
    },
    installPath: text(value.installPath),
    running: value.running,
    connected: value.connected === true,
    micOpen: typeof value.micOpen === "boolean" ? value.micOpen : null,
    activity: ACTIVITIES.includes(value.activity as JarvisActivity) ? (value.activity as JarvisActivity) : "idle",
    partial: text(value.partial),
    provider: text(value.provider),
    model: text(value.model),
    agents: Array.isArray(value.agents) ? value.agents.filter(isRecord).map(parseAgent).filter((agent) => agent.name) : [],
    feed: Array.isArray(value.feed) ? value.feed.map(parseFeedItem).filter((item): item is JarvisFeedItem => item !== null) : [],
    lastError: text(value.lastError),
    updatedAt: number(value.updatedAt) ?? 0,
  };
}

function parseAgent(record: Record<string, unknown>): JarvisAgent {
  return {
    name: text(record.name) ?? "",
    cwd: text(record.cwd),
    task: text(record.task),
    working: record.working === true,
    focused: record.focused === true,
    status: text(record.status),
  };
}

function parseFeedItem(value: unknown): JarvisFeedItem | null {
  if (!isRecord(value) || !Number.isFinite(value.id) || typeof value.text !== "string") return null;
  if (!FEED_KINDS.includes(value.kind as JarvisFeedKind)) return null;
  const item: JarvisFeedItem = { id: value.id as number, at: number(value.at) ?? 0, kind: value.kind as JarvisFeedKind, text: value.text };
  if (typeof value.agent === "string") item.agent = value.agent;
  if (text(value.turn)) item.turn = value.turn as string;
  return item;
}

/** Keep whichever state Athena produced last: an ask's answer can land after the stream already moved on. */
export function newerState(current: JarvisState | null, next: JarvisState): JarvisState {
  return current && current.updatedAt > next.updatedAt ? current : next;
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Where to look, in order: the last place Jarvis answered, the server's
 * configured mount, the host's own Athena, then each ready machine on the
 * tailnet. Empty bases are skipped (demo mode has no control URL).
 */
export function jarvisCandidates({
  configuredBase,
  hostBase,
  hostName,
  remoteBase,
  machines,
  remembered,
}: {
  configuredBase: string | null;
  hostBase: string | null;
  hostName: string | null;
  remoteBase: string | null;
  machines: { id: string; name: string; status: string }[];
  remembered: JarvisLocation | null;
}): JarvisLocation[] {
  const locations: JarvisLocation[] = [];
  if (remembered) locations.push(remembered);
  if (configuredBase) locations.push({ kind: "configured", base: configuredBase, machineId: null, name: null });
  if (hostBase) locations.push({ kind: "host", base: hostBase, machineId: null, name: hostName });
  if (remoteBase) {
    for (const machine of machines) {
      if (machine.status !== "ready") continue;
      locations.push({ kind: "machine", base: `${remoteBase}/m/${encodeURIComponent(machine.id)}`, machineId: machine.id, name: machine.name });
    }
  }
  // The remembered entry may carry an old name; the fresh one wins, in the remembered slot.
  const unique = new Map<string, JarvisLocation>();
  for (const location of locations) {
    const previous = unique.get(location.base);
    unique.set(location.base, previous ? { ...location, name: location.name ?? previous.name } : location);
  }
  return [...unique.values()];
}

export function classifyJarvisProbe(at: JarvisLocation, probe: JarvisProbe): JarvisFinding {
  const location = probe.host ? { ...at, host: probe.host } : at;
  if (probe.kind === "ok") {
    const { state } = probe;
    const status: JarvisFindingStatus = state.license.licensed
      ? state.running
        ? "ready"
        : "not-running"
      : state.installPath || state.running
        ? "not-licensed"
        : "absent";
    return { location, status, state, detail: null };
  }
  if (probe.kind === "unreachable") return { location, status: "unreachable", state: null, detail: probe.error };
  if (probe.status === 404) {
    // The mount answers "not configured" when unset; an app server that predates
    // the mount answers a plain 404. Behind a configured mount, an old Athena
    // answers 404 with its own "Unknown control endpoint".
    const mountOff = location.kind === "configured" && (probe.error === null || probe.error === "not configured");
    return { location, status: mountOff ? "not-configured" : "too-old", state: null, detail: probe.error };
  }
  return { location, status: "unreachable", state: null, detail: probe.error ?? `HTTP ${probe.status}` };
}

/**
 * The Jarvis to show: licensed and running first, then licensed, then one
 * that needs a license; earlier candidates win ties. Null when none was
 * found, and the findings explain why.
 */
export function pickJarvis(findings: JarvisFinding[]): JarvisFinding | null {
  const best = findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => RANK[left.finding.status] - RANK[right.finding.status] || left.index - right.index)[0]?.finding;
  return best && RANK[best.status] <= RANK["not-licensed"] ? best : null;
}

/** Worth trying first next time: Jarvis is licensed there. */
export function isGoodFinding(finding: JarvisFinding): boolean {
  return finding.status === "ready" || finding.status === "not-running";
}

/**
 * The machine a location stands for, for "Jarvis on …". The configured mount
 * goes by its MagicDNS name (as the machine switcher names machines), else the
 * computer Jarvis was activated on, else its address.
 */
export function locationName(location: JarvisLocation, state: JarvisState | null): string {
  const host = location.host?.toLowerCase().replace(/^\[|\]$/g, "") ?? null;
  const loopback = host !== null && (host === "localhost" || host === "::1" || host.startsWith("127."));
  const magicDns = host?.endsWith(".ts.net") ? host.split(".")[0] : null;
  return (
    location.name ??
    magicDns ??
    state?.license.instanceName ??
    (loopback || location.kind === "host" ? "this host" : host) ??
    "the Jarvis computer"
  );
}

/** What a finding means, in plain words, for the "no Jarvis" list. */
export function findingSummary(finding: JarvisFinding): string {
  switch (finding.status) {
    case "ready":
      return "Jarvis is running.";
    case "not-running":
      return "Jarvis is licensed but not running.";
    case "not-licensed":
      return `Jarvis is there, but not licensed${finding.state?.license.detail ? ` (${finding.state.license.detail})` : ""}.`;
    case "absent":
      return "Athena is running, but Jarvis isn't installed there.";
    case "too-old":
      return "Athena there is too old for Jarvis. Update it.";
    case "not-configured":
      return "No Jarvis target is set on this server.";
    default:
      return finding.detail ? `Didn't answer: ${finding.detail}` : "Didn't answer.";
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

export type JarvisStatus = JarvisActivity | "connecting" | "offline" | "unlicensed";

/** `live`: this state came from the stream or a poll just now, not from storage. */
export function jarvisStatus(state: JarvisState | null, live: boolean): JarvisStatus {
  if (!state) return "offline";
  // Athena drops Jarvis's bus without a license, even while Jarvis runs.
  if (!state.license.licensed) return "unlicensed";
  if (!state.running) return "offline";
  if (!state.connected || !live) return "connecting";
  return state.activity;
}

export function jarvisStatusLabel(status: JarvisStatus): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "connecting":
      return "Connecting…";
    case "unlicensed":
      return "Not licensed";
    default:
      return "Not running";
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────

/** A request sent from this phone that Jarvis hasn't echoed into the feed yet. */
export type PendingAsk = { text: string; afterId: number; sentAt: number };

export type JarvisChatItem = { key: string; at: number; showTime: boolean } & (
  | { role: "user"; text: string; pending: boolean }
  | { role: "jarvis"; text: string }
  | { role: "system"; kind: "announce" | "agent"; text: string; agent: string | null }
);

/** The highest feed id so far (0 for an empty feed). */
export function lastFeedId(feed: JarvisFeedItem[]): number {
  return feed.reduce((highest, item) => Math.max(highest, item.id), 0);
}

/**
 * The feed as chat rows: the user's words on the right, Jarvis's replies on
 * the left, announcements and agent events as compact rows. A request that
 * came back both "asked" and "heard" within a few seconds shows once.
 * Unechoed asks from this phone follow, marked pending.
 */
export function jarvisChat(feed: JarvisFeedItem[], pending: PendingAsk[] = []): JarvisChatItem[] {
  const rows: JarvisChatItem[] = [];
  const users: { text: string; at: number }[] = [];
  let previousAt: number | null = null;
  const timeLabel = (at: number) => {
    const show = previousAt === null || at - previousAt >= TIME_GAP_MS;
    previousAt = at;
    return show;
  };
  for (const item of feed) {
    const key = `f${item.id}`;
    if (item.kind === "heard" || item.kind === "asked") {
      const normalized = normalizeSpeech(item.text);
      if (users.some((user) => user.text === normalized && Math.abs(user.at - item.at) <= ECHO_WINDOW_MS)) continue;
      users.push({ text: normalized, at: item.at });
      rows.push({ key, at: item.at, showTime: timeLabel(item.at), role: "user", text: item.text, pending: false });
    } else if (item.kind === "said") {
      rows.push({ key, at: item.at, showTime: timeLabel(item.at), role: "jarvis", text: item.text });
    } else {
      rows.push({ key, at: item.at, showTime: timeLabel(item.at), role: "system", kind: item.kind, text: item.text, agent: item.agent ?? null });
    }
  }
  for (const ask of pending) {
    rows.push({ key: `p${ask.sentAt}`, at: ask.sentAt, showTime: false, role: "user", text: ask.text, pending: true });
  }
  return rows;
}

/** Asks Jarvis hasn't put in the feed yet; an echo must be newer than the feed was when the ask was sent. */
export function openAsks(feed: JarvisFeedItem[], pending: PendingAsk[]): PendingAsk[] {
  const echoed = new Set<number>();
  return pending.filter((ask) => {
    const text = normalizeSpeech(ask.text);
    const echo = feed.find(
      (item) => (item.kind === "asked" || item.kind === "heard") && item.id > ask.afterId && !echoed.has(item.id) && normalizeSpeech(item.text) === text,
    );
    if (!echo) return true;
    echoed.add(echo.id);
    return false;
  });
}

/** Same words, ignoring case, punctuation, and spacing (speech recognition adds its own). */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Jarvis's voice on the phone ────────────────────────────────────────────

/**
 * What to do with a `jarvis-audio` event, given the turn of the phone's
 * latest ask: hold it while the ask hasn't answered (`undefined`), ignore it
 * when there's no ask or its answer named no turn (`null`), and play only
 * that turn's: another phone's reply isn't ours.
 */
export function audioForAsk(turn: string | null | undefined, event: JarvisAudioEvent): "play" | "hold" | "ignore" {
  if (turn === undefined) return "hold";
  return turn !== null && event.turn === turn ? "play" : "ignore";
}

/**
 * A reply's sentences in the order Jarvis spoke them, though their downloads
 * finish in any order. Each sentence is announced, then settled with its
 * decoded audio, or null when it couldn't be fetched (it's skipped). `settle`
 * and `finish` return what can play now, in order, with no sentence missing
 * in between. The final marker says how many there were; one never announced
 * by then is skipped rather than waited for.
 */
export class ReplyAudioQueue<T> {
  private readonly announced = new Set<number>();
  private readonly settled = new Map<number, T | null>();
  private next = 0;
  private end: number | null = null;

  /** False for a sentence already announced, or one past the end: don't fetch it. */
  announce(seq: number): boolean {
    if (seq < this.next || this.announced.has(seq) || (this.end !== null && seq >= this.end)) return false;
    this.announced.add(seq);
    return true;
  }

  settle(seq: number, audio: T | null): T[] {
    if (!this.announced.has(seq) || seq < this.next) return [];
    this.settled.set(seq, audio);
    return this.drain();
  }

  finish(count: number): T[] {
    this.end ??= count;
    return this.drain();
  }

  /** Every sentence up to the final marker has been handed out or skipped. */
  get done(): boolean {
    return this.end !== null && this.next >= this.end;
  }

  private drain(): T[] {
    const ready: T[] = [];
    while (this.end === null || this.next < this.end) {
      if (this.settled.has(this.next)) {
        const audio = this.settled.get(this.next) ?? null;
        this.settled.delete(this.next);
        if (audio !== null) ready.push(audio);
      } else if (this.end === null || this.announced.has(this.next)) {
        break;
      }
      this.next += 1;
    }
    return ready;
  }
}

// ── The orb ────────────────────────────────────────────────────────────────

/** The desktop HUD orb's states: away or asleep, waiting, hearing the user, thinking, speaking. */
export type JarvisOrbState = "muted" | "idle" | "hearing" | "thinking" | "speaking";

/** Jarvis's voice (`out`) and what its microphone hears (`mic`), 0..1, from Athena's `jarvis-level` events. */
export type JarvisLevels = { out: number; mic: number };

/**
 * The orb's state as the HUD derives it (speaking over thinking over hearing
 * over idle; muted while Jarvis isn't there or its microphone is off), with
 * the phone in the loop: Jarvis's voice playing here is speaking, and the
 * phone's own dictation is hearing. Unlike the HUD, a closed microphone on
 * the computer only quiets an idle orb, since the phone still talks to Jarvis.
 */
export function jarvisOrbState(status: JarvisStatus, phone: { micOpen: boolean | null; playing: boolean; dictating: boolean }): JarvisOrbState {
  if (status === "offline" || status === "unlicensed" || status === "connecting") return "muted";
  if (phone.playing || status === "speaking") return "speaking";
  if (status === "thinking") return "thinking";
  if (phone.dictating || status === "listening") return "hearing";
  return phone.micOpen === false ? "muted" : "idle";
}

/** A `jarvis-level` event's data, clamped to 0..1; null if it isn't one. */
export function parseJarvisLevels(value: unknown): JarvisLevels | null {
  if (!isRecord(value)) return null;
  const out = number(value.out);
  const mic = number(value.mic);
  return out === null || mic === null ? null : { out: clampLevel(out), mic: clampLevel(mic) };
}

/** A level on Jarvis's own scale: the samples' RMS (they run -1..1) times 6, at most 1, as jarvis/system_audio.py measures. */
export function voiceLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return clampLevel(Math.sqrt(sum / samples.length) * 6);
}

/** Up at once, down gently: the orb swells with each syllable without flickering between them. */
export function smoothLevel(previous: number, sample: number, release = 0.8): number {
  return sample >= previous ? sample : previous * release + sample * (1 - release);
}

/**
 * Whether the orb stands large above the conversation or sits small in the
 * header: large while the conversation (`contentHeight`) fits under it and the
 * keyboard is closed. `roomHeight` is the space the conversation and the large
 * orb share, which stays the same as one grows and the other shrinks, so the
 * answer doesn't flip back and forth while the orb moves.
 */
export function orbIsHero(layout: { keyboardOpen: boolean; contentHeight: number; roomHeight: number; heroHeight: number }): boolean {
  return !layout.keyboardOpen && layout.contentHeight + layout.heroHeight <= layout.roomHeight;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function clampLevel(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
