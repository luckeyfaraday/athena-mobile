import type {
  AgentSession,
  EmbeddedTerminalSession,
  HermesStatus,
  MobileSnapshot,
  ServiceState,
  SnapshotErrors,
  SpawnTerminalRequest,
  TerminalBuffer,
  TranscriptRef,
  WorkspaceSummary,
} from "../types";
import type { AppConfig } from "../config";
import { initialServiceState } from "../config";
import { recentProjectPaths } from "../workspaces";

export type AthenaClient = {
  snapshot(projectDir?: string): Promise<MobileSnapshot>;
  refreshService(): Promise<ServiceState>;
  terminalBuffer(target: string, maxChars?: number): Promise<TerminalBuffer>;
  sendTerminalInput(target: string, text: string): Promise<EmbeddedTerminalSession>;
  /**
   * Write raw bytes to the terminal's PTY with no Enter appended — keystrokes,
   * arrows, and control codes reach the agent TUI verbatim. Backs direct typing
   * from the live xterm view (vs. sendTerminalInput, which submits a whole line).
   */
  sendTerminalRaw(target: string, data: string): Promise<EmbeddedTerminalSession>;
  spawnTerminal(request: SpawnTerminalRequest): Promise<EmbeddedTerminalSession[]>;
  killTerminal(target: string): Promise<EmbeddedTerminalSession>;
  /**
   * Resume a native session in a fresh live terminal. The control server rebuilds
   * the provider's resume command from the session id, so the result behaves like
   * any other live terminal (streamable, writable, killable).
   */
  resumeSession(session: AgentSession): Promise<EmbeddedTerminalSession[]>;
  /**
   * Tail of a native session's on-disk transcript, as markdown. Takes a history
   * entry, or a live terminal's kind and providerSessionId.
   */
  sessionTranscript(ref: TranscriptRef, maxBytes?: number): Promise<string>;
  /** Project folders with recent native sessions in any workspace, newest first. */
  recentWorkspaces(): Promise<string[]>;
  /**
   * Open a folder as a desktop tab without switching the desktop to it, so a
   * pane launched from the phone also shows at the desk. Call it only after a
   * spawn succeeded: spawn's own open_workspace flag opens the tab before it
   * checks the folder exists, leaving a stray tab after a mistyped path.
   */
  openDesktopWorkspace(path: string): Promise<void>;
  /**
   * Same-origin URL of the live SSE output stream for a terminal, or null when
   * streaming is unavailable (demo mode or no control URL configured). Consumed
   * by the xterm view via EventSource; the dev proxy injects the control token.
   */
  terminalStreamUrl(target: string, maxChars?: number): string | null;
};

const REQUEST_TIMEOUT_MS = 15_000;
// Scanning every provider's sessions across all workspaces took ~23 s on a
// cold backend cache, well past the default timeout.
const ALL_SESSIONS_TIMEOUT_MS = 60_000;

export function createAthenaClient(config: AppConfig): AthenaClient {
  if (config.mode === "live") return new HttpAthenaClient(config);
  return new DemoAthenaClient(config);
}

class HttpAthenaClient implements AthenaClient {
  constructor(private readonly config: AppConfig) {}

  async snapshot(projectDir?: string): Promise<MobileSnapshot> {
    // Each section degrades independently: a down control server must not blank
    // out backend status (and vice versa). Health is probed separately, and it
    // is unauthenticated, so a rejected token only shows up here — record each
    // failure so the UI can tell "couldn't load" apart from "nothing there".
    const errors: SnapshotErrors = {};
    const settle = <T>(section: keyof SnapshotErrors, request: Promise<T>, fallback: T): Promise<T> =>
      request.catch((error: unknown) => {
        errors[section] = error instanceof Error ? error.message : String(error);
        return fallback;
      });
    const [service, hermes, terminals, recentSessions] = await Promise.all([
      this.refreshService(),
      settle<HermesStatus | null>(
        "hermes",
        this.backendJson<{ hermes: HermesStatus }>("/hermes/status").then((payload) => payload.hermes),
        null,
      ),
      settle(
        "terminals",
        this.controlJson<{ terminals: EmbeddedTerminalSession[] }>("/terminals").then((payload) => payload.terminals),
        [],
      ),
      projectDir
        ? settle(
            "sessions",
            this.backendJson<{ sessions: AgentSession[] }>(`/agents/sessions?project_dir=${encodeURIComponent(projectDir)}&limit=25`).then((payload) => payload.sessions),
            [],
          )
        : Promise.resolve([]),
    ]);
    return {
      service,
      hermes,
      terminals,
      recentSessions,
      workspaces: summarizeWorkspaces(terminals, recentSessions),
      errors,
    };
  }

  terminalStreamUrl(target: string, maxChars = 200_000): string | null {
    if (!this.config.controlUrl) return null;
    return `${this.config.controlUrl}/terminals/${encodeURIComponent(target)}/stream?max_chars=${maxChars}`;
  }

  async refreshService(): Promise<ServiceState> {
    const [backend, control] = await Promise.all([
      this.probe(this.config.backendUrl, "backend"),
      this.probe(this.config.controlUrl, "control"),
    ]);
    return {
      mode: "live",
      backend,
      control,
    };
  }

  async sendTerminalInput(target: string, text: string): Promise<EmbeddedTerminalSession> {
    const payload = await this.controlJson<{ terminal: EmbeddedTerminalSession }>("/terminals/write", {
      method: "POST",
      body: JSON.stringify({ target, text }),
    });
    return payload.terminal;
  }

  async sendTerminalRaw(target: string, data: string): Promise<EmbeddedTerminalSession> {
    const payload = await this.controlJson<{ terminal: EmbeddedTerminalSession }>("/terminals/input", {
      method: "POST",
      body: JSON.stringify({ target, data }),
    });
    return payload.terminal;
  }

  async terminalBuffer(target: string, maxChars = 40_000): Promise<TerminalBuffer> {
    return this.controlJson<TerminalBuffer>(`/terminals/${encodeURIComponent(target)}/buffer?max_chars=${maxChars}`);
  }

  async spawnTerminal(request: SpawnTerminalRequest): Promise<EmbeddedTerminalSession[]> {
    const payload = await this.controlJson<{ sessions: EmbeddedTerminalSession[] }>("/terminals/spawn", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return payload.sessions;
  }

  async killTerminal(target: string): Promise<EmbeddedTerminalSession> {
    const payload = await this.controlJson<{ terminal: EmbeddedTerminalSession }>("/terminals/kill", {
      method: "POST",
      body: JSON.stringify({ target }),
    });
    return payload.terminal;
  }

  async resumeSession(session: AgentSession): Promise<EmbeddedTerminalSession[]> {
    return this.spawnTerminal({
      project_dir: session.workspace,
      kind: session.provider,
      title: `${labelForKind(session.provider)} Resume`,
      session_label: session.title,
      resume_session_id: session.id,
    }).then((sessions) => {
      void this.openDesktopWorkspace(session.workspace).catch(() => {});
      return sessions;
    });
  }

  async sessionTranscript(ref: TranscriptRef, maxBytes = 65_536): Promise<string> {
    const path = `/agents/sessions/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.id)}/transcript?max_bytes=${maxBytes}&tail=true`;
    return this.requestText(this.config.backendUrl, path);
  }

  async recentWorkspaces(): Promise<string[]> {
    const payload = await this.backendJson<{ sessions: AgentSession[] }>("/agents/sessions/all?limit=200", {
      signal: AbortSignal.timeout(ALL_SESSIONS_TIMEOUT_MS),
    });
    return recentProjectPaths(payload.sessions);
  }

  async openDesktopWorkspace(path: string): Promise<void> {
    await this.controlJson("/workspaces/open", {
      method: "POST",
      body: JSON.stringify({ project_dir: path, select: false }),
    });
  }

  private async probe(baseUrl: string, label: string) {
    if (!baseUrl) {
      return { baseUrl: null, healthy: false, detail: `${label} URL is not configured.` };
    }
    try {
      await this.request(baseUrl, "/health");
      return { baseUrl, healthy: true, detail: "ok" };
    } catch (error) {
      return { baseUrl, healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private backendJson<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.config.backendUrl, path, init);
  }

  private controlJson<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.config.controlUrl, path, init);
  }

  private async request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
    if (!baseUrl) throw new Error("Base URL is not configured.");
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      // Time out stalled requests so a hung backend never leaves the UI spinning.
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.json() as Promise<T>;
  }

  // Transcript endpoints return plain text rather than JSON, so they bypass request<T>.
  private async requestText(baseUrl: string, path: string): Promise<string> {
    if (!baseUrl) throw new Error("Base URL is not configured.");
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.text();
  }
}

class DemoAthenaClient implements AthenaClient {
  private terminals = demoTerminals;

  constructor(private readonly config: AppConfig) {}

  async snapshot(): Promise<MobileSnapshot> {
    const service = initialServiceState(this.config);
    return {
      service: {
        ...service,
        backend: { ...service.backend, healthy: true, detail: "demo" },
        control: { ...service.control, healthy: true, detail: "demo" },
      },
      hermes: demoHermes,
      terminals: this.terminals,
      recentSessions: demoSessions,
      workspaces: summarizeWorkspaces(this.terminals, demoSessions),
    };
  }

  async refreshService(): Promise<ServiceState> {
    return (await this.snapshot()).service;
  }

  async sendTerminalInput(target: string, text: string): Promise<EmbeddedTerminalSession> {
    const terminal = this.terminals.find((entry) => entry.id === target || entry.providerSessionId === target);
    if (!terminal) throw new Error(`Demo terminal not found: ${target}`);
    terminal.initialTask = text;
    return terminal;
  }

  async sendTerminalRaw(target: string, _data: string): Promise<EmbeddedTerminalSession> {
    const terminal = this.terminals.find((entry) => entry.id === target || entry.providerSessionId === target);
    if (!terminal) throw new Error(`Demo terminal not found: ${target}`);
    return terminal;
  }

  async terminalBuffer(target: string, maxChars = 40_000): Promise<TerminalBuffer> {
    const terminal = this.terminals.find((entry) => entry.id === target || entry.providerSessionId === target);
    if (!terminal) throw new Error(`Demo terminal not found: ${target}`);
    const buffer = [
      `$ athena terminal ${terminal.id}`,
      `workspace: ${terminal.workspace}`,
      `agent: ${terminal.kind}`,
      "",
      terminal.initialTask || "No task text recorded.",
      "",
      "Demo mode is using the same buffer contract as live Athena control.",
    ].join("\n");
    const tail = buffer.length > maxChars ? buffer.slice(-maxChars) : buffer;
    return {
      terminal,
      buffer: tail,
      chars: tail.length,
      max_chars: maxChars,
    };
  }

  async spawnTerminal(request: SpawnTerminalRequest): Promise<EmbeddedTerminalSession[]> {
    const terminal: EmbeddedTerminalSession = {
      id: `demo-${Date.now()}`,
      title: request.title || `${labelForKind(request.kind)} Mobile`,
      kind: request.kind,
      workspace: request.project_dir,
      pid: 4200 + this.terminals.length,
      promptPath: null,
      initialTask: request.task || null,
      sessionLabel: "Mobile",
      providerSessionId: null,
      createdAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      error: null,
    };
    this.terminals = [terminal, ...this.terminals];
    return [terminal];
  }

  async killTerminal(target: string): Promise<EmbeddedTerminalSession> {
    const terminal = this.terminals.find((entry) => entry.id === target);
    if (!terminal) throw new Error(`Demo terminal not found: ${target}`);
    terminal.status = "exited";
    terminal.exitCode = 0;
    this.terminals = this.terminals.filter((entry) => entry.id !== target);
    return terminal;
  }

  async resumeSession(session: AgentSession): Promise<EmbeddedTerminalSession[]> {
    return this.spawnTerminal({
      project_dir: session.workspace,
      kind: session.provider,
      title: `${labelForKind(session.provider)} Resume`,
      session_label: session.title,
      resume_session_id: session.id,
    });
  }

  async sessionTranscript(ref: TranscriptRef): Promise<string> {
    return [
      "# Demo Session Transcript",
      "",
      `- session: ${ref.id}`,
      `- provider: ${ref.provider}`,
      "",
      "## User",
      "",
      "Review mobile gateway boundaries and prepare auth plan.",
      "",
      "## Assistant",
      "",
      "Demo transcript. Configure live mode to read the real on-disk session transcript.",
    ].join("\n");
  }

  async recentWorkspaces(): Promise<string[]> {
    return ["/home/alan/home_ai/projects/context-workspace", "/home/alan/home_ai/projects/athena-mobile"];
  }

  async openDesktopWorkspace(): Promise<void> {}

  terminalStreamUrl(): string | null {
    return null;
  }
}

// Status first, so callers can still test for a code ("404…"), then Athena's
// own explanation when it sent one, e.g. "Workspace does not exist: /path".
async function errorMessage(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { error?: unknown; detail?: unknown };
    const detail = typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : null;
    // The control server stringifies thrown errors, so strip their "Error: " prefix.
    return detail ? `${status}: ${detail.replace(/^Error:\s*/, "")}` : status;
  } catch {
    return status;
  }
}

export function summarizeWorkspaces(terminals: EmbeddedTerminalSession[], sessions: AgentSession[]): WorkspaceSummary[] {
  const paths = new Set([...terminals.map((entry) => entry.workspace), ...sessions.map((entry) => entry.workspace)]);
  return Array.from(paths).map((path) => ({
    path,
    name: path.split("/").filter(Boolean).at(-1) || path,
    liveTerminals: terminals.filter((entry) => entry.workspace === path && entry.status === "running").length,
    recentSessions: sessions.filter((entry) => entry.workspace === path).length,
  }));
}

function labelForKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

const demoHermes: HermesStatus = {
  installed: true,
  command_path: "/usr/local/bin/hermes",
  version: "demo",
  hermes_home: "~/.hermes",
  memory_path: "~/.hermes/memory.jsonl",
  message: "Demo mode. Configure live mode to connect to Athena.",
};

const demoTerminals: EmbeddedTerminalSession[] = [
  {
    id: "demo-codex-1",
    title: "Codex Builder",
    kind: "codex",
    workspace: "/home/alan/home_ai/projects/context-workspace",
    pid: 4128,
    promptPath: null,
    initialTask: "Review mobile gateway boundaries and prepare auth plan.",
    sessionLabel: "Live",
    providerSessionId: "demo-codex-session",
    createdAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    status: "running",
    exitCode: null,
    error: null,
  },
  {
    id: "demo-hermes-1",
    title: "Hermes Recall",
    kind: "hermes",
    workspace: "/home/alan/home_ai/projects/context-workspace",
    pid: 4132,
    promptPath: null,
    initialTask: "Summarize recent Athena context for mobile control.",
    sessionLabel: "Live",
    providerSessionId: null,
    createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
    status: "running",
    exitCode: null,
    error: null,
  },
];

const demoSessions: AgentSession[] = [
  {
    id: "demo-session-1",
    provider: "codex",
    title: "Gateway review",
    workspace: "/home/alan/home_ai/projects/context-workspace",
    branch: "main",
    model: "gpt-5",
    agent: "codex",
    created_at: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
    status: "historical",
    terminal_id: null,
    pid: null,
    resume_command: null,
    metadata: {},
  },
];
