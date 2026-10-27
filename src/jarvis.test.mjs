import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyJarvisProbe,
  findingSummary,
  isGoodFinding,
  jarvisCandidates,
  jarvisChat,
  jarvisFromBody,
  jarvisStatus,
  jarvisStatusLabel,
  lastFeedId,
  locationName,
  newerState,
  normalizeSpeech,
  openAsks,
  parseJarvisState,
  pickJarvis,
  unreadReplies,
} from "./jarvis.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-27T15:00:00Z");

function jarvis(overrides = {}) {
  return {
    license: { licensed: true, detail: null, offlineUntil: null, licenseId: "lic", keyMasked: "XXXX-1234", instanceName: "LAPTOP-7" },
    installPath: "C:\\Users\\ada\\AppData\\Local\\Jarvis AI\\jarvis-hud.exe",
    running: true,
    connected: true,
    micOpen: true,
    activity: "idle",
    partial: null,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    agents: [],
    feed: [],
    lastError: null,
    updatedAt: T0,
    ...overrides,
  };
}

const unlicensed = (overrides = {}) => jarvis({ license: { ...jarvis().license, licensed: false, detail: "no license.json" }, ...overrides });
const location = (kind, base, name = null, machineId = null) => ({ kind, base, machineId, name });
const CONFIGURED = location("configured", "/athena-jarvis");
const HOST = location("host", "/athena-control", "vps");
const WIN = location("machine", "/athena-remote/m/win-id", "win-pc", "win-id");
const MAC = location("machine", "/athena-remote/m/mac-id", "mac", "mac-id");

test("parseJarvisState keeps a well-formed state and fills in what's missing", () => {
  const full = jarvis({ feed: [{ id: 1, at: T0, kind: "said", text: "Hi." }], agents: [{ name: "codex", cwd: null, task: null, working: true, focused: false, status: "busy" }] });
  assert.deepEqual(parseJarvisState(full), full);
  assert.deepEqual(jarvisFromBody({ jarvis: full }), full);
  const sparse = parseJarvisState({
    license: { licensed: true },
    running: true,
    activity: "dancing",
    feed: [{ id: 1, at: T0, kind: "heard", text: "hello" }, { id: 2, kind: "sung", text: "?" }, { id: "x", kind: "said", text: "no id" }, null],
    agents: [{ name: "" }, "codex"],
  });
  assert.equal(sparse.activity, "idle");
  assert.equal(sparse.connected, false);
  assert.equal(sparse.micOpen, null);
  assert.deepEqual(sparse.feed, [{ id: 1, at: T0, kind: "heard", text: "hello" }]);
  assert.deepEqual(sparse.agents, []);
  assert.equal(sparse.license.instanceName, null);
  assert.equal(parseJarvisState(null), null);
  assert.equal(parseJarvisState({ running: true }), null);
  assert.equal(jarvisFromBody("<!doctype html>"), null);
  assert.equal(jarvisFromBody({ error: "not configured" }), null);
});

test("candidates: remembered first, then the mount, the host, and ready machines, once each", () => {
  const machines = [
    { id: "win-id", name: "win-pc", status: "ready" },
    { id: "srv-id", name: "server", status: "needs-token" },
    { id: "mac-id", name: "mac", status: "ready" },
  ];
  const candidates = jarvisCandidates({
    configuredBase: "/athena-jarvis",
    hostBase: "/athena-control",
    hostName: "vps",
    remoteBase: "/athena-remote",
    machines,
    remembered: { ...MAC, name: "old-name" },
  });
  assert.deepEqual(candidates.map((entry) => [entry.kind, entry.base, entry.name]), [
    ["machine", "/athena-remote/m/mac-id", "mac"],
    ["configured", "/athena-jarvis", null],
    ["host", "/athena-control", "vps"],
    ["machine", "/athena-remote/m/win-id", "win-pc"],
  ]);
  // Demo mode: no host or tailnet to search.
  const demo = jarvisCandidates({ configuredBase: "/athena-jarvis", hostBase: null, hostName: null, remoteBase: null, machines, remembered: null });
  assert.deepEqual(demo.map((entry) => entry.base), ["/athena-jarvis"]);
  // A machine id is escaped into the path.
  const odd = jarvisCandidates({ configuredBase: null, hostBase: null, hostName: null, remoteBase: "/r", machines: [{ id: "a/b", name: "x", status: "ready" }], remembered: null });
  assert.equal(odd[0].base, "/r/m/a%2Fb");
});

test("each answer is classified in plain terms", () => {
  const status = (where, probe) => classifyJarvisProbe(where, probe).status;
  assert.equal(status(HOST, { kind: "ok", state: jarvis() }), "ready");
  assert.equal(status(HOST, { kind: "ok", state: jarvis({ running: false }) }), "not-running");
  assert.equal(status(HOST, { kind: "ok", state: unlicensed() }), "not-licensed");
  assert.equal(status(HOST, { kind: "ok", state: unlicensed({ installPath: null, running: false }) }), "absent");
  assert.equal(status(HOST, { kind: "http", status: 404, error: "Unknown control endpoint: GET /jarvis" }), "too-old");
  assert.equal(status(WIN, { kind: "http", status: 404, error: "Unknown control endpoint: GET /jarvis" }), "too-old");
  // The mount is off, or this app's server predates it.
  assert.equal(status(CONFIGURED, { kind: "http", status: 404, error: "not configured" }), "not-configured");
  assert.equal(status(CONFIGURED, { kind: "http", status: 404, error: null }), "not-configured");
  // A configured Athena that predates Jarvis says so through the mount.
  assert.equal(status(CONFIGURED, { kind: "http", status: 404, error: "Unknown control endpoint: GET /jarvis" }), "too-old");
  const offline = classifyJarvisProbe(WIN, { kind: "http", status: 503, error: "win-pc is offline." });
  assert.equal(offline.status, "unreachable");
  assert.equal(findingSummary(offline), "Didn't answer: win-pc is offline.");
  assert.equal(status(WIN, { kind: "unreachable", error: "no answer in time" }), "unreachable");
});

test("pickJarvis prefers licensed and running, then licensed, then the first found", () => {
  const finding = (where, state) => classifyJarvisProbe(where, { kind: "ok", state });
  const tooOld = classifyJarvisProbe(CONFIGURED, { kind: "http", status: 404, error: "Unknown control endpoint: GET /jarvis" });
  const notRunning = finding(HOST, jarvis({ running: false }));
  const running = finding(WIN, jarvis());
  const runningToo = finding(MAC, jarvis());
  assert.equal(pickJarvis([tooOld, notRunning, running, runningToo]), running);
  assert.equal(pickJarvis([tooOld, finding(WIN, unlicensed()), notRunning]), notRunning);
  const needsLicense = finding(WIN, unlicensed());
  assert.equal(pickJarvis([finding(HOST, unlicensed({ installPath: null, running: false })), needsLicense]), needsLicense);
  // Nothing to talk to or license: report instead.
  assert.equal(pickJarvis([tooOld, finding(HOST, unlicensed({ installPath: null, running: false }))]), null);
  assert.equal(pickJarvis([]), null);
  assert.equal(isGoodFinding(notRunning), true);
  assert.equal(isGoodFinding(needsLicense), false);
});

test("findings and locations read as plain words", () => {
  const summary = (where, probe) => findingSummary(classifyJarvisProbe(where, probe));
  assert.equal(summary(HOST, { kind: "http", status: 404, error: "Unknown control endpoint: GET /jarvis" }), "Athena there is too old for Jarvis. Update it.");
  assert.equal(summary(HOST, { kind: "ok", state: unlicensed() }), "Jarvis is there, but not licensed (no license.json).");
  assert.equal(summary(HOST, { kind: "ok", state: unlicensed({ installPath: null, running: false }) }), "Athena is running, but Jarvis isn't installed there.");
  assert.equal(summary(HOST, { kind: "ok", state: jarvis({ running: false }) }), "Jarvis is licensed but not running.");
  // The configured mount is named by the computer Jarvis was activated on.
  assert.equal(locationName(CONFIGURED, jarvis()), "LAPTOP-7");
  assert.equal(locationName(CONFIGURED, null), "the Jarvis computer");
  assert.equal(locationName(HOST, jarvis()), "vps");
  assert.equal(locationName({ ...HOST, name: null }, null), "this host");
  // The server names the configured target: its MagicDNS name wins, an address is the last resort.
  const named = (host, state = null) => locationName(classifyJarvisProbe(CONFIGURED, { kind: "http", status: 404, error: "x", host }).location, state);
  assert.equal(named("alan-laptop.tail1234.ts.net", jarvis()), "alan-laptop");
  assert.equal(named("100.101.102.103", jarvis()), "LAPTOP-7");
  assert.equal(named("100.101.102.103"), "100.101.102.103");
  assert.equal(named("[fd7a:115c:a1e0::5]"), "fd7a:115c:a1e0::5");
  assert.equal(named("127.0.0.1"), "this host");
});

test("status follows the connection, then Jarvis's activity", () => {
  assert.equal(jarvisStatus(null, true), "offline");
  assert.equal(jarvisStatus(jarvis({ running: false }), true), "offline");
  // Unlicensed, Athena never connects to Jarvis's bus, so it isn't "connecting".
  assert.equal(jarvisStatus(unlicensed({ connected: false }), true), "unlicensed");
  assert.equal(jarvisStatusLabel("unlicensed"), "Not licensed");
  assert.equal(jarvisStatus(jarvis({ connected: false }), true), "connecting");
  // A remembered state isn't live until Jarvis answers.
  assert.equal(jarvisStatus(jarvis({ activity: "speaking" }), false), "connecting");
  assert.equal(jarvisStatus(jarvis({ activity: "listening" }), true), "listening");
  assert.equal(jarvisStatusLabel("idle"), "Ready");
  assert.equal(jarvisStatusLabel("offline"), "Not running");
});

test("newerState keeps the state Athena produced last", () => {
  const old = jarvis({ updatedAt: T0 });
  const fresh = jarvis({ updatedAt: T0 + 5 });
  assert.equal(newerState(fresh, old), fresh);
  assert.equal(newerState(old, fresh), fresh);
  assert.equal(newerState(null, old), old);
});

test("the feed reads as chat, showing a typed request once", () => {
  const feed = [
    { id: 1, at: T0, kind: "heard", text: "What's on my calendar?" },
    { id: 2, at: T0 + 2_000, kind: "said", text: "Two meetings." },
    { id: 3, at: T0 + 40 * MINUTE, kind: "asked", text: "Start codex on omarchy" },
    // The same request echoed as heard: one bubble.
    { id: 4, at: T0 + 40 * MINUTE + 1_500, kind: "heard", text: "start Codex on omarchy." },
    { id: 5, at: T0 + 40 * MINUTE + 3_000, kind: "agent", text: "started: codex", agent: "omarchy" },
    { id: 6, at: T0 + 41 * MINUTE, kind: "announce", text: "codex on omarchy is done" },
    // Said again much later: a new request, shown again.
    { id: 7, at: T0 + 45 * MINUTE, kind: "heard", text: "Start codex on omarchy" },
  ];
  const rows = jarvisChat(feed);
  assert.deepEqual(rows.map((row) => [row.key, row.role, row.text]), [
    ["f1", "user", "What's on my calendar?"],
    ["f2", "jarvis", "Two meetings."],
    ["f3", "user", "Start codex on omarchy"],
    ["f5", "system", "started: codex"],
    ["f6", "system", "codex on omarchy is done"],
    ["f7", "user", "Start codex on omarchy"],
  ]);
  assert.equal(rows[2].role === "user" && rows[2].pending, false);
  assert.deepEqual(rows.map((row) => row.showTime), [true, false, true, false, false, false]);
  assert.equal(rows[3].agent, "omarchy");
  assert.equal(rows[4].kind, "announce");
});

test("asks from the phone show as pending until Jarvis echoes them", () => {
  const before = [{ id: 7, at: T0, kind: "heard", text: "lights off" }];
  const pending = [
    { text: "Lights off", afterId: 7, sentAt: T0 + 1_000 },
    { text: "what time is it", afterId: 7, sentAt: T0 + 2_000 },
  ];
  // The older "lights off" doesn't count as the echo.
  assert.deepEqual(openAsks(before, pending), pending);
  const rows = jarvisChat(before, pending);
  assert.deepEqual(rows.map((row) => [row.key, row.pending]), [["f7", false], [`p${T0 + 1_000}`, true], [`p${T0 + 2_000}`, true]]);
  const echoed = [...before, { id: 8, at: T0 + 1_200, kind: "asked", text: "Lights off." }];
  assert.deepEqual(openAsks(echoed, pending), [pending[1]]);
  // One echo answers one ask.
  assert.equal(openAsks(echoed, [pending[0], { ...pending[0], sentAt: T0 + 3_000 }]).length, 1);
  assert.equal(normalizeSpeech("  What's   the TIME?! "), "whats the time");
});

test("replies are read aloud only after an ask from the phone, sentence by sentence", () => {
  const feed = [
    { id: 1, at: T0, kind: "said", text: "Old reply." },
    { id: 2, at: T0, kind: "asked", text: "weather" },
    { id: 3, at: T0, kind: "said", text: "It's sunny." },
    { id: 4, at: T0, kind: "announce", text: "codex is done" },
  ];
  const spoken = new Map();
  assert.deepEqual(unreadReplies(feed, null, spoken, T0), []);
  const gate = { afterId: 1, until: T0 + 2 * MINUTE };
  assert.deepEqual(unreadReplies(feed, gate, spoken, T0), [{ id: 3, text: "It's sunny.", length: 11 }]);
  spoken.set(3, 11);
  assert.deepEqual(unreadReplies(feed, gate, spoken, T0), []);
  // The reply grows with the next sentence: only that is new.
  feed[2] = { ...feed[2], text: "It's sunny. High of 21." };
  assert.deepEqual(unreadReplies(feed, gate, spoken, T0), [{ id: 3, text: "High of 21.", length: 23 }]);
  // A reply in progress keeps going after the window; a new one past it doesn't start.
  const later = [...feed.slice(0, 2), { ...feed[2], text: "It's sunny. High of 21. Low of 9." }, { id: 5, at: T0, kind: "said", text: "Unrelated." }];
  assert.deepEqual(unreadReplies(later, gate, spoken, T0 + 5 * MINUTE), [{ id: 3, text: "It's sunny. High of 21. Low of 9.".slice(11).trim(), length: 33 }]);
  assert.equal(lastFeedId(later), 5);
  assert.equal(lastFeedId([]), 0);
});
