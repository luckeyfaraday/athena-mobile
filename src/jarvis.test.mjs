import assert from "node:assert/strict";
import test from "node:test";
import {
  ReplyAudioQueue,
  audioForAsk,
  classifyJarvisProbe,
  findingSummary,
  isGoodFinding,
  jarvisCandidates,
  jarvisChat,
  jarvisFromBody,
  jarvisOrbState,
  jarvisStatus,
  jarvisStatusLabel,
  jarvisTurnFromBody,
  lastFeedId,
  locationName,
  newerState,
  normalizeSpeech,
  openAsks,
  orbIsHero,
  parseJarvisAudioEvent,
  parseJarvisLevels,
  parseJarvisState,
  pickJarvis,
  smoothLevel,
  voiceLevel,
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
  assert.equal(lastFeedId(echoed), 8);
  assert.equal(lastFeedId([]), 0);
});

test("an ask's answer names its reply's turn, and the stream announces its sentences", () => {
  assert.equal(jarvisTurnFromBody({ jarvis: jarvis(), turn: "t-7" }), "t-7");
  assert.equal(jarvisTurnFromBody({ jarvis: jarvis() }), null, "an older Athena or Jarvis names none");
  assert.equal(jarvisTurnFromBody({ jarvis: jarvis(), turn: null }), null);
  assert.equal(jarvisTurnFromBody(null), null);
  assert.deepEqual(parseJarvisAudioEvent({ turn: "t-7", seq: 0, final: false, interrupted: false }), { turn: "t-7", seq: 0, final: false, interrupted: false });
  assert.deepEqual(parseJarvisAudioEvent({ turn: "t-7", seq: 3, final: true }), { turn: "t-7", seq: 3, final: true, interrupted: false });
  for (const bad of [null, { seq: 0 }, { turn: "", seq: 0 }, { turn: "t", seq: -1 }, { turn: "t", seq: 1.5 }, { turn: "t", seq: "0" }]) {
    assert.equal(parseJarvisAudioEvent(bad), null, JSON.stringify(bad));
  }
  // Feed items keep the turn Athena gives them.
  const state = parseJarvisState(jarvis({ feed: [{ id: 1, at: T0, kind: "said", text: "Sunny.", turn: "t-7" }, { id: 2, at: T0, kind: "said", text: "Hi.", turn: "" }] }));
  assert.deepEqual(state.feed.map((item) => item.turn), ["t-7", undefined]);
});

test("only the phone's own reply is played, and audio that beats the ask's answer waits for it", () => {
  const sentence = (turn, seq) => ({ turn, seq, final: false, interrupted: false });
  assert.equal(audioForAsk(undefined, sentence("t-7", 0)), "hold");
  assert.equal(audioForAsk("t-7", sentence("t-7", 0)), "play");
  assert.equal(audioForAsk("t-7", sentence("t-8", 0)), "ignore", "another phone's reply");
  assert.equal(audioForAsk(null, sentence("t-7", 0)), "ignore", "nothing asked, or no turn named");
});

test("a reply's sentences play in order, each once, however their downloads finish", () => {
  const queue = new ReplyAudioQueue();
  assert.equal(queue.announce(0), true);
  assert.equal(queue.announce(1), true);
  assert.equal(queue.announce(2), true);
  assert.equal(queue.announce(1), false, "announced twice: fetched once");
  // Sentence 1 downloads first, but waits for 0.
  assert.deepEqual(queue.settle(1, "one"), []);
  assert.deepEqual(queue.settle(0, "zero"), ["zero", "one"]);
  assert.equal(queue.announce(0), false, "already played");
  assert.deepEqual(queue.settle(0, "zero again"), [], "never played twice");
  // A sentence that couldn't be fetched is skipped.
  assert.equal(queue.announce(3), true);
  assert.deepEqual(queue.settle(3, "three"), []);
  assert.deepEqual(queue.settle(2, null), ["three"]);
  assert.equal(queue.done, false, "no final marker yet");
  assert.deepEqual(queue.finish(4), []);
  assert.equal(queue.done, true);
  assert.equal(queue.announce(4), false, "nothing after the end");
});

test("the final marker skips sentences that were never announced", () => {
  const queue = new ReplyAudioQueue();
  queue.announce(0);
  queue.announce(2);
  assert.deepEqual(queue.settle(2, "two"), []);
  assert.deepEqual(queue.settle(0, "zero"), ["zero"], "1 may still be coming");
  // Jarvis spoke three sentences; 1 never reached the phone.
  assert.deepEqual(queue.finish(3), ["two"]);
  assert.equal(queue.done, true);
  // One still downloading at the end is waited for.
  const late = new ReplyAudioQueue();
  late.announce(0);
  late.announce(1);
  assert.deepEqual(late.finish(2), []);
  assert.deepEqual(late.settle(1, "one"), []);
  assert.deepEqual(late.settle(0, "zero"), ["zero", "one"]);
  // An empty reply (cut off at once) is done straight away.
  const empty = new ReplyAudioQueue();
  assert.deepEqual(empty.finish(0), []);
  assert.equal(empty.done, true);
});

test("the orb shows what Jarvis is doing, as the desktop HUD does, with the phone in the loop", () => {
  const phone = (overrides = {}) => ({ micOpen: true, playing: false, dictating: false, ...overrides });
  assert.equal(jarvisOrbState("idle", phone()), "idle");
  assert.equal(jarvisOrbState("listening", phone()), "hearing");
  assert.equal(jarvisOrbState("thinking", phone()), "thinking");
  assert.equal(jarvisOrbState("speaking", phone()), "speaking");
  for (const away of ["offline", "unlicensed", "connecting"]) assert.equal(jarvisOrbState(away, phone({ playing: true })), "muted", away);
  // Speaking beats thinking beats hearing, as on the HUD.
  assert.equal(jarvisOrbState("thinking", phone({ playing: true })), "speaking", "Jarvis's voice playing here");
  assert.equal(jarvisOrbState("thinking", phone({ dictating: true })), "thinking");
  assert.equal(jarvisOrbState("idle", phone({ dictating: true })), "hearing", "the phone taking dictation");
  // The computer's microphone off: asleep while idle, but the phone still talks to Jarvis.
  assert.equal(jarvisOrbState("idle", phone({ micOpen: false })), "muted");
  assert.equal(jarvisOrbState("idle", phone({ micOpen: null })), "idle");
  assert.equal(jarvisOrbState("speaking", phone({ micOpen: false })), "speaking");
  assert.equal(jarvisOrbState("idle", phone({ micOpen: false, dictating: true })), "hearing");
});

test("levels read on Jarvis's own scale, swell at once and fall back gently", () => {
  assert.deepEqual(parseJarvisLevels({ out: 0.42, mic: 0 }), { out: 0.42, mic: 0 });
  assert.deepEqual(parseJarvisLevels({ out: 3, mic: -1 }), { out: 1, mic: 0 });
  assert.equal(parseJarvisLevels({ out: 0.4 }), null);
  assert.equal(parseJarvisLevels({ out: "loud", mic: 0 }), null);
  assert.equal(parseJarvisLevels(null), null);
  // RMS times 6, at most 1: a 0.1-amplitude square wave reads 0.6, like Jarvis's tts.level.
  assert.equal(voiceLevel([]), 0);
  assert.equal(Number(voiceLevel([0.1, -0.1, 0.1, -0.1]).toFixed(6)), 0.6);
  assert.equal(voiceLevel([0.9, -0.9]), 1);
  assert.equal(smoothLevel(0.2, 0.7), 0.7, "up at once");
  assert.equal(Number(smoothLevel(0.7, 0.2).toFixed(6)), 0.6, "down by a fifth of the gap");
  assert.equal(Number(smoothLevel(0.7, 0.2, 0.5).toFixed(6)), 0.45);
});

test("the orb stands large while the conversation fits under it and the keyboard is down", () => {
  const layout = (overrides = {}) => ({ keyboardOpen: false, contentHeight: 300, roomHeight: 600, heroHeight: 196, ...overrides });
  assert.equal(orbIsHero(layout()), true);
  assert.equal(orbIsHero(layout({ contentHeight: 404 })), true, "just fits");
  assert.equal(orbIsHero(layout({ contentHeight: 405 })), false, "the conversation outgrew it");
  assert.equal(orbIsHero(layout({ keyboardOpen: true })), false);
  assert.equal(orbIsHero(layout({ roomHeight: 400 })), false, "a short screen");
});
