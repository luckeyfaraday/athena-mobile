// Jarvis through Athena's control API, wherever it runs. Every request goes
// through this app's own server: the /athena-jarvis mount (ATHENA_JARVIS_TARGET),
// the host's /athena-control, or another machine's /athena-remote/m/<id>.
// The rules for choosing between them are in src/jarvis.ts.

import type { AppConfig } from "../config";
import {
  classifyJarvisProbe,
  jarvisCandidates,
  jarvisFromBody,
  pickJarvis,
  type JarvisFinding,
  type JarvisLocation,
  type JarvisProbe,
  type JarvisState,
} from "../jarvis";
import { fetchMachines } from "./athenaClient";

export const JARVIS_MOUNT = "/athena-jarvis";
// A machine across the tailnet can be slow to answer, but a search shouldn't
// sit on one that never will.
const PROBE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** A request Jarvis refused. Athena sends its state along (403 unlicensed, 409 not running), so the screen can follow. */
export class JarvisRequestError extends Error {
  readonly status: number;
  readonly state: JarvisState | null;
  constructor(message: string, status: number, state: JarvisState | null) {
    super(message);
    this.status = status;
    this.state = state;
  }
}

export type JarvisSearch = {
  best: JarvisFinding | null;
  findings: JarvisFinding[];
  /** Places that couldn't be searched at all, e.g. the machine list failed. */
  notes: string[];
};

/**
 * Find Jarvis: the remembered location first (done if Jarvis is running
 * there), then the configured mount, the host's Athena, and every ready
 * machine on the tailnet, all asked at once.
 */
export async function discoverJarvis(config: AppConfig, remembered: JarvisLocation | null): Promise<JarvisSearch> {
  let rememberedFinding: JarvisFinding | null = null;
  if (remembered) {
    rememberedFinding = classifyJarvisProbe(remembered, await probeJarvis(config, remembered));
    if (rememberedFinding.status === "ready") return { best: rememberedFinding, findings: [rememberedFinding], notes: [] };
  }
  const live = config.mode === "live";
  const notes: string[] = [];
  let machines: { id: string; name: string; status: string }[] = [];
  let hostName: string | null = null;
  // Demo mode has no host or tailnet to search, only a configured mount.
  if (live && config.remoteUrl) {
    try {
      const snapshot = await fetchMachines(config);
      machines = snapshot.machines;
      hostName = snapshot.self.name;
    } catch (error) {
      notes.push(`Couldn't list your other machines: ${messageOf(error)}`);
    }
  }
  const candidates = jarvisCandidates({
    configuredBase: JARVIS_MOUNT,
    hostBase: live ? config.controlUrl || null : null,
    hostName,
    remoteBase: live ? config.remoteUrl || null : null,
    machines,
    remembered,
  });
  const findings = await Promise.all(
    candidates.map(async (location) =>
      rememberedFinding && location.base === rememberedFinding.location.base
        ? { ...rememberedFinding, location }
        : classifyJarvisProbe(location, await probeJarvis(config, location)),
    ),
  );
  return { best: pickJarvis(findings), findings: findings.filter((finding) => finding.status !== "not-configured"), notes };
}

/** One GET /jarvis that never throws: what answered, or why nothing did. */
export async function probeJarvis(config: AppConfig, location: JarvisLocation): Promise<JarvisProbe> {
  let response: Response;
  try {
    response = await fetch(`${location.base}/jarvis`, { headers: authHeaders(config), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "unreachable", error: error instanceof DOMException && error.name === "TimeoutError" ? "no answer in time" : messageOf(error) };
  }
  const body = await response.json().catch(() => null);
  const state = jarvisFromBody(body);
  const host = location.kind === "configured" ? response.headers.get("X-Athena-Jarvis-Host") : null;
  if (response.ok && state) return { kind: "ok", state, host };
  return { kind: "http", status: response.ok ? 404 : response.status, error: errorText(body), host };
}

export async function fetchJarvis(config: AppConfig, location: JarvisLocation): Promise<JarvisState> {
  return request(config, location, "/jarvis");
}

/** Hand Jarvis a typed request; it answers aloud on that computer and in the feed. */
export async function askJarvis(config: AppConfig, location: JarvisLocation, text: string): Promise<JarvisState> {
  return request(config, location, "/jarvis/ask", { text });
}

/** The microphone on Jarvis's computer, not the phone's. */
export async function setJarvisMic(config: AppConfig, location: JarvisLocation, state: "on" | "off" | "toggle"): Promise<JarvisState> {
  return request(config, location, "/jarvis/mic", { state });
}

/** Open the Jarvis desktop app there; the stream reports when it's running. */
export async function launchJarvis(config: AppConfig, location: JarvisLocation): Promise<JarvisState> {
  return request(config, location, "/jarvis/launch", {});
}

/** Same-origin SSE URL; the app's server adds the token, as for terminal streams. */
export function jarvisEventsUrl(location: JarvisLocation): string {
  return `${location.base}/jarvis/events`;
}

async function request(config: AppConfig, location: JarvisLocation, path: string, body?: unknown): Promise<JarvisState> {
  const response = await fetch(`${location.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  const state = jarvisFromBody(payload);
  if (response.ok && state) return state;
  const reason = errorText(payload) ?? `${response.status} ${response.statusText}`.trim();
  throw new JarvisRequestError(reason.charAt(0).toUpperCase() + reason.slice(1), response.ok ? 502 : response.status, state);
}

function authHeaders(config: AppConfig): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

// Athena's own explanation, without the "Error: " prefix the control server adds.
function errorText(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  return typeof error === "string" && error.trim() ? error.replace(/^Error:\s*/, "") : null;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
