// Jarvis on the phone: where it lives, and how its feed reads as a chat. Pure
// helpers with no runtime imports, so node --test can load this file directly.
// The network side is src/api/jarvisClient.ts; the screen is JarvisView.
//
// Jarvis is the user's licensed voice assistant on one of their computers.
// Athena on that computer serves it on the control API (GET /jarvis,
// /jarvis/events, POST /jarvis/ask|mic|launch); these types mirror
// context-workspace client/electron/jarvis-companion.ts.

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

export type JarvisFeedItem = { id: number; at: number; kind: JarvisFeedKind; text: string; agent?: string };

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

// ── Reading replies aloud ──────────────────────────────────────────────────

/**
 * Replies are read aloud on the phone only after the user asked something
 * from it: `afterId` is the newest feed id when they asked, and replies that
 * start after `until` are left to the computer's own speaker.
 */
export type SpeechGate = { afterId: number; until: number };

/** How long after an ask from the phone a new reply is still read aloud. */
export const READ_ALOUD_WINDOW_MS = 2 * 60_000;

/**
 * Text not yet read aloud: whole replies that arrived after the gate, or the
 * newly streamed sentences of one already being read. `spoken` maps a reply id
 * to how many of its characters were handed to the speaker.
 */
export function unreadReplies(
  feed: JarvisFeedItem[],
  gate: SpeechGate | null,
  spoken: ReadonlyMap<number, number>,
  now: number,
): { id: number; text: string; length: number }[] {
  if (!gate) return [];
  const replies: { id: number; text: string; length: number }[] = [];
  for (const item of feed) {
    if (item.kind !== "said" || item.id <= gate.afterId) continue;
    const done = spoken.get(item.id);
    if (done === undefined && now > gate.until) continue;
    const rest = item.text.slice(done ?? 0).trim();
    if (rest) replies.push({ id: item.id, text: rest, length: item.text.length });
  }
  return replies;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
