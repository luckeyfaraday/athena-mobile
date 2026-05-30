// Athena Mobile push notifier.
//
// Runs inside the Vite dev server (as a plugin) on the laptop, as the same OS
// user as Athena. It:
//   1. Owns a VAPID keypair + the phone's Web Push subscriptions (persisted
//      0600 alongside Athena's other discovery secrets).
//   2. Serves the client subscribe flow under /athena-push/*.
//   3. Watches each live terminal's SSE stream on the control server, runs the
//      desktop's attention classifier over the output, and — on a transition to
//      "needs input" / "finished" — sends an encrypted Web Push to the phone.
//
// The push itself is delivered by the platform push service (FCM/Apple), so the
// phone is notified even when the PWA is backgrounded or off the tailnet. The
// only thing that must keep running is this dev server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";
import { classifyTerminalAttention } from "./attention.mjs";

const SECRETS_FILE = "athena-mobile-push.json";
const CONTROL_DISCOVERY = "electron-control.json";
const TERMINALS_POLL_MS = 5000;
// Suppress repeat notifications of the same kind for one terminal within this
// window, so a long-lived "waiting for approval" prompt pings once, not forever.
const DEBOUNCE_MS = 45_000;
const CONTACT = "mailto:athena-mobile@localhost";

export function createPushNotifier() {
  const secrets = loadSecrets();
  webpush.setVapidDetails(CONTACT, secrets.vapid.publicKey, secrets.vapid.privateKey);

  // terminalId -> { controller, carry, lastKind, lastFireTs }
  const watched = new Map();
  let pollTimer = null;
  let stopped = false;

  const middleware = async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/vapid") {
        return sendJson(res, 200, { publicKey: secrets.vapid.publicKey });
      }
      if (req.method === "POST" && req.url === "/subscribe") {
        const sub = await readJson(req);
        if (!sub?.endpoint) return sendJson(res, 400, { error: "Missing subscription endpoint." });
        upsertSubscription(secrets, sub);
        saveSecrets(secrets);
        return sendJson(res, 200, { ok: true, subscriptions: secrets.subscriptions.length });
      }
      if (req.method === "POST" && req.url === "/unsubscribe") {
        const body = await readJson(req);
        secrets.subscriptions = secrets.subscriptions.filter((s) => s.endpoint !== body?.endpoint);
        saveSecrets(secrets);
        return sendJson(res, 200, { ok: true, subscriptions: secrets.subscriptions.length });
      }
      if (req.method === "POST" && req.url === "/test") {
        await broadcast(secrets, {
          title: "Athena Mobile",
          body: "Test notification — push is wired up.",
          tag: "athena-test",
          url: "/",
        });
        return sendJson(res, 200, { ok: true, sent: secrets.subscriptions.length });
      }
      return sendJson(res, 404, { error: `Unknown push endpoint: ${req.method} ${req.url}` });
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  async function poll() {
    if (stopped) return;
    try {
      // No subscribers → don't hold streams open against the control server.
      if (secrets.subscriptions.length === 0) {
        for (const id of [...watched.keys()]) closeStream(id);
      } else {
        const control = readControlDiscovery();
        if (control.baseUrl) {
          const terminals = await fetchTerminals(control);
          const liveIds = new Set(terminals.filter((t) => t.status === "running").map((t) => t.id));
          for (const t of terminals) {
            if (t.status === "running" && !watched.has(t.id)) openStream(control, t);
          }
          for (const id of [...watched.keys()]) {
            if (!liveIds.has(id)) closeStream(id);
          }
        }
      }
    } catch {
      // Control server down or unreachable — try again next tick.
    } finally {
      if (!stopped) pollTimer = setTimeout(poll, TERMINALS_POLL_MS);
    }
  }

  function openStream(control, terminal) {
    const controller = new AbortController();
    const state = { controller, carry: "", lastKind: null, lastFireTs: 0, title: terminal.title || terminal.id };
    watched.set(terminal.id, state);
    void consumeStream(control, terminal, state, () => closeStream(terminal.id));
  }

  function closeStream(id) {
    const state = watched.get(id);
    if (!state) return;
    state.controller.abort();
    watched.delete(id);
  }

  async function consumeStream(control, terminal, state, onEnd) {
    const url = `${control.baseUrl}/terminals/${encodeURIComponent(terminal.id)}/stream?max_chars=2000`;
    try {
      const response = await fetch(url, {
        headers: control.token ? { authorization: `Bearer ${control.token}` } : {},
        signal: state.controller.signal,
      });
      if (!response.ok || !response.body) return onEnd();
      for await (const evt of parseSse(response.body, state.controller.signal)) {
        if (evt.event === "data") {
          handleOutput(secrets, terminal, state, decodeBase64(evt.data));
        } else if (evt.event === "exit") {
          maybeNotify(secrets, terminal, state, "update", `${state.title} finished.`);
          return onEnd();
        }
        // "snapshot" is the initial buffer; skip it so we only react to new output.
      }
    } catch {
      // Aborted or network error — drop this stream; the poll will re-open it
      // if the terminal is still alive.
    } finally {
      onEnd();
    }
  }

  function handleOutput(secrets, terminal, state, chunk) {
    if (!chunk) return;
    // Classify the new chunk plus a small carryover, so a phrase split across
    // two SSE frames still matches.
    const window = state.carry + chunk;
    state.carry = chunk.slice(-200);
    const kind = classifyTerminalAttention(window);
    if (!kind) return;
    const body =
      kind === "action"
        ? `${state.title} needs your input.`
        : `${state.title}: ${firstLine(window)}`;
    maybeNotify(secrets, terminal, state, kind, body);
  }

  function maybeNotify(secrets, terminal, state, kind, body) {
    const now = Date.now();
    if (kind === state.lastKind && now - state.lastFireTs < DEBOUNCE_MS) return;
    state.lastKind = kind;
    state.lastFireTs = now;
    void broadcast(secrets, {
      title: kind === "action" ? "Agent waiting" : "Agent update",
      body,
      tag: `athena-${terminal.id}`,
      url: `/?terminal=${encodeURIComponent(terminal.id)}`,
    });
  }

  return {
    middleware,
    start() {
      stopped = false;
      poll();
    },
    stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      for (const id of [...watched.keys()]) closeStream(id);
    },
  };
}

async function broadcast(secrets, payload) {
  if (secrets.subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  const stale = [];
  await Promise.all(
    secrets.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (error) {
        // 404/410 mean the subscription was revoked on the device — prune it.
        if (error?.statusCode === 404 || error?.statusCode === 410) stale.push(sub.endpoint);
      }
    }),
  );
  if (stale.length) {
    secrets.subscriptions = secrets.subscriptions.filter((s) => !stale.includes(s.endpoint));
    saveSecrets(secrets);
  }
}

async function fetchTerminals(control) {
  const response = await fetch(`${control.baseUrl}/terminals`, {
    headers: control.token ? { authorization: `Bearer ${control.token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.terminals) ? payload.terminals : [];
}

// Minimal text/event-stream parser over a web ReadableStream.
async function* parseSse(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
          // ": comment" / keep-alive lines are ignored.
        }
        if (data) yield { event, data };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function firstLine(text) {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ").trim();
  const line = clean.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "Update available.";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// ---- secrets + discovery ----------------------------------------------------

function discoveryDir() {
  return path.join(os.homedir(), ".context-workspace");
}

function loadSecrets() {
  const file = path.join(discoveryDir(), SECRETS_FILE);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.vapid?.publicKey && data?.vapid?.privateKey) {
      return { vapid: data.vapid, subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [] };
    }
  } catch {
    // Missing or malformed — fall through and mint a fresh keypair.
  }
  const fresh = { vapid: webpush.generateVAPIDKeys(), subscriptions: [] };
  saveSecrets(fresh);
  return fresh;
}

function saveSecrets(secrets) {
  const dir = discoveryDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SECRETS_FILE);
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  // Tighten perms even if the file already existed with looser bits.
  fs.chmodSync(file, 0o600);
}

function upsertSubscription(secrets, sub) {
  const next = { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null };
  secrets.subscriptions = [...secrets.subscriptions.filter((s) => s.endpoint !== next.endpoint), next];
}

function readControlDiscovery() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(discoveryDir(), CONTROL_DISCOVERY), "utf8"));
    const baseUrl = typeof data?.baseUrl === "string" && data.baseUrl.trim() ? data.baseUrl.trim() : null;
    const token = typeof data?.token === "string" && data.token.trim() ? data.token.trim() : null;
    return { baseUrl: baseUrl || process.env.ATHENA_CONTROL_TARGET || "http://127.0.0.1:9000", token };
  } catch {
    return { baseUrl: process.env.ATHENA_CONTROL_TARGET || "http://127.0.0.1:9000", token: null };
  }
}

// ---- tiny http helpers ------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("Request body too large."));
    });
    req.on("end", () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}
