// Athena Mobile push notifier.
//
// Runs inside the Vite dev server (as a plugin) on the laptop, as the same OS
// user as Athena. It:
//   1. Owns a VAPID keypair + the phone's Web Push subscriptions (persisted
//      0600 alongside Athena's other discovery secrets).
//   2. Serves the client subscribe flow under /athena-push/*.
//   3. Watches each live terminal's SSE stream on the control server, tracks
//      when an agent goes quiet (attention.mjs), and sends an encrypted Web Push
//      when one is waiting on an answer or has finished its turn.
//
// The push itself is delivered by the platform push service (FCM/Apple), so the
// phone is notified even when the PWA is backgrounded or off the tailnet. The
// only thing that must keep running is this dev server.

import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { AttentionTracker } from "./attention.mjs";
import { discoveryDir } from "./discovery.mjs";

const SECRETS_FILE = "athena-mobile-push.json";
const CONTROL_DISCOVERY = "electron-control.json";
const TERMINALS_POLL_MS = 5000;
const ATTENTION_TICK_MS = 1000;
// Rate limits on top of attention.mjs's one-alert-per-burst rule. A "finished"
// alert for a terminal that alerted recently waits out FINISHED_COOLDOWN_MS
// instead of being dropped, so a quick follow-up turn still alerts if the agent
// is left waiting. Approval prompts block the agent, so they only share the
// global limit.
const FINISHED_COOLDOWN_MS = 10 * 60_000;
const GLOBAL_COOLDOWN_MS = 30_000;
const CONTACT = validVapidSubject(process.env.ATHENA_PUSH_CONTACT) || "mailto:athena-mobile@example.com";

export function createPushNotifier() {
  const secrets = loadSecrets();
  webpush.setVapidDetails(CONTACT, secrets.vapid.publicKey, secrets.vapid.privateKey);

  // terminalId -> { controller, terminal }
  const watched = new Map();
  // Burst state lives outside the per-stream state so a stream reconnect
  // continues the current burst instead of starting a new one.
  const attention = new AttentionTracker();
  // terminalId -> when its last "finished" alert went out
  const lastFinishedAt = new Map();
  let lastGlobalFireTs = 0;
  let pollTimer = null;
  let tickTimer = null;
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
        const result = await broadcast(secrets, {
          title: "Athena Mobile",
          body: "Test notification — push is wired up.",
          tag: "athena-test",
          url: "/",
        });
        const status = result.sent > 0 && result.failed === 0 ? 200 : 502;
        return sendJson(res, status, { ok: status === 200, ...result });
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
        closeAll();
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
          attention.retain(liveIds);
          for (const id of [...lastFinishedAt.keys()]) {
            if (!liveIds.has(id)) lastFinishedAt.delete(id);
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
    const state = { controller, terminal };
    watched.set(terminal.id, state);
    void consumeStream(control, terminal, state, () => closeStream(terminal.id));
  }

  function closeStream(id) {
    const state = watched.get(id);
    if (!state) return;
    state.controller.abort();
    watched.delete(id);
  }

  function closeAll() {
    for (const id of [...watched.keys()]) closeStream(id);
    attention.retain(new Set());
    lastFinishedAt.clear();
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
          attention.output(terminal.id, decodeBase64(evt.data), Date.now());
        } else if (evt.event === "exit") {
          notifyExit(terminal, parseExitCode(evt.data));
          return onEnd();
        }
        // "snapshot" is the initial buffer; skip it so only new output counts.
      }
    } catch {
      // Aborted or network error — drop this stream; the poll will re-open it
      // if the terminal is still alive.
    } finally {
      onEnd();
    }
  }

  // Rate-limited alerts are skipped without acknowledging, so a later tick
  // sends them if the agent is still waiting by then.
  function tick() {
    const now = Date.now();
    for (const { terminal } of watched.values()) {
      const kind = attention.due(terminal.id, now);
      if (!kind || now - lastGlobalFireTs < GLOBAL_COOLDOWN_MS) continue;
      if (kind === "finished" && now - (lastFinishedAt.get(terminal.id) ?? -Infinity) < FINISHED_COOLDOWN_MS) continue;

      attention.acknowledge(terminal.id);
      lastGlobalFireTs = now;
      if (kind === "finished") lastFinishedAt.set(terminal.id, now);
      const name = terminal.title || terminal.id;
      void broadcast(
        secrets,
        kind === "action"
          ? {
              title: "Agent waiting",
              body: `${name} is waiting for your answer.`,
              tag: `athena-${terminal.id}`,
              url: notificationUrl(terminal, "terminal"),
            }
          : {
              title: "Agent finished",
              body: `${name} finished and is waiting for you.`,
              tag: `athena-${terminal.id}`,
              url: notificationUrl(terminal, "chat"),
            },
      );
    }
  }

  // Only a failing exit is worth a push: quitting an agent or stopping its
  // terminal is something the user just did. The terminal is gone afterwards,
  // so the alert opens the app rather than deep-linking to it.
  function notifyExit(terminal, exitCode) {
    if (typeof exitCode !== "number" || exitCode === 0) return;
    lastGlobalFireTs = Date.now();
    void broadcast(secrets, {
      title: "Agent exited",
      body: `${terminal.title || terminal.id} exited with code ${exitCode}.`,
      tag: `athena-${terminal.id}`,
      url: "/",
    });
  }

  return {
    middleware,
    start() {
      stopped = false;
      poll();
      tickTimer ??= setInterval(tick, ATTENTION_TICK_MS);
    },
    stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
      closeAll();
    },
  };
}

async function broadcast(secrets, payload) {
  if (secrets.subscriptions.length === 0) return { total: 0, sent: 0, failed: 0, errors: [] };
  const body = JSON.stringify(payload);
  const stale = [];
  const errors = [];
  let sent = 0;
  await Promise.all(
    secrets.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent += 1;
      } catch (error) {
        // 404/410 mean the subscription was revoked on the device — prune it.
        if (error?.statusCode === 404 || error?.statusCode === 410) stale.push(sub.endpoint);
        errors.push({
          endpoint: summarizeEndpoint(sub.endpoint),
          statusCode: error?.statusCode ?? null,
          message: error instanceof Error ? error.message : String(error),
          body: typeof error?.body === "string" ? error.body.slice(0, 500) : undefined,
        });
      }
    }),
  );
  if (stale.length) {
    secrets.subscriptions = secrets.subscriptions.filter((s) => !stale.includes(s.endpoint));
    saveSecrets(secrets);
  }
  return { total: sent + errors.length, sent, failed: errors.length, errors };
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

// The exit event carries base64 JSON: {"exitCode": number | null, ...}.
function parseExitCode(payloadBase64) {
  try {
    const exitCode = JSON.parse(decodeBase64(payloadBase64))?.exitCode;
    return typeof exitCode === "number" ? exitCode : null;
  } catch {
    return null;
  }
}

// `view` picks the agent view the tap opens: the terminal for approval
// prompts (they only render there), the conversation for finished turns.
function notificationUrl(terminal, view) {
  const params = new URLSearchParams();
  params.set("terminal", terminal.id);
  if (terminal.workspace) params.set("workspace", terminal.workspace);
  params.set("view", view);
  return `/?${params.toString()}`;
}

function summarizeEndpoint(endpoint) {
  if (typeof endpoint !== "string") return "";
  return endpoint.length > 96 ? `${endpoint.slice(0, 93)}...` : endpoint;
}

function validVapidSubject(value) {
  const subject = typeof value === "string" ? value.trim() : "";
  return /^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/[^/\s]+(?:\/\S*)?)$/i.test(subject) ? subject : null;
}

// ---- secrets + discovery ----------------------------------------------------

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
