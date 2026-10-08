import type {
  AgentSession,
  ConversationMessage,
  EmbeddedTerminalSession,
  HermesStatus,
  MachineRef,
  MachinesSnapshot,
  MobileSnapshot,
  RemoteAgentSession,
  RemoteMachine,
  ServiceState,
  SnapshotErrors,
  SpawnTerminalRequest,
  TerminalBuffer,
  TranscriptRef,
  UsageAccount,
  UsageSnapshot,
  WorkspaceSummary,
} from "../types";
import type { AppConfig } from "../config";
import { initialServiceState } from "../config";
import { recentProjectPaths } from "../workspaces";
import { fromRemoteSession, pathBaseName } from "../machines";
import { parseTranscript } from "../transcript";

export type AthenaClient = {
  /** The machine whose agents this client controls; null for the host serving the app. */
  readonly machine: MachineRef | null;
  /** Past sessions' transcripts can be opened (only the host's backend serves them). */
  readonly historyTranscripts: boolean;
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
  /**
   * A live agent's native conversation as chat messages; empty until its
   * session log has a first message.
   */
  conversation(terminal: EmbeddedTerminalSession): Promise<ConversationMessage[]>;
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
  /**
   * Subscription quota records (Claude, Codex) from the laptop's shared cache.
   * Never waits on a provider: the backend refreshes in the background.
   */
  usage(): Promise<UsageSnapshot>;
  /** Re-read provider quotas now. The backend deduplicates and bounds the wait. */
  refreshUsage(accountKey?: string): Promise<UsageSnapshot>;
};

const REQUEST_TIMEOUT_MS = 15_000;
// A remote machine rescans its session index on request (one scan at a time,
// cached 30 s there), so its history is re-read at most this often, and a
// failed read waits a little before the next try.
const REMOTE_HISTORY_TTL_MS = 60_000;
const REMOTE_HISTORY_RETRY_MS = 15_000;
// Scanning every provider's sessions across all workspaces took ~23 s on a
// cold backend cache, well past the default timeout.
const ALL_SESSIONS_TIMEOUT_MS = 60_000;

/** A client for the host (`machine` null) or for another machine reached through it. */
export function createAthenaClient(config: AppConfig, machine: MachineRef | null = null): AthenaClient {
  if (config.mode !== "live") return new DemoAthenaClient(config, machine);
  return machine ? new RemoteAthenaClient(config, machine) : new HttpAthenaClient(config);
}

/** The other desktops on the tailnet, as the host sees them. `fresh` re-asks each machine now. */
export async function fetchMachines(config: AppConfig, fresh = false): Promise<MachinesSnapshot> {
  if (config.mode !== "live") return demoMachines();
  if (!config.remoteUrl) throw new Error("Remote URL is not configured.");
  const response = await fetch(`${config.remoteUrl}/machines${fresh ? "?fresh=1" : ""}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<MachinesSnapshot>;
}

class HttpAthenaClient implements AthenaClient {
  readonly machine: MachineRef | null = null;
  readonly historyTranscripts: boolean = true;
  constructor(
    protected readonly config: AppConfig,
    protected readonly controlUrl: string = config.controlUrl,
  ) {}

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
    if (!this.controlUrl) return null;
    return `${this.controlUrl}/terminals/${encodeURIComponent(target)}/stream?max_chars=${maxChars}`;
  }

  async refreshService(): Promise<ServiceState> {
    const [backend, control] = await Promise.all([
      this.probe(this.config.backendUrl, "backend"),
      this.probe(this.controlUrl, "control"),
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

  async conversation(terminal: EmbeddedTerminalSession): Promise<ConversationMessage[]> {
    if (terminal.kind === "shell" || !terminal.providerSessionId) return [];
    try {
      return parseTranscript(await this.sessionTranscript({ provider: terminal.kind, id: terminal.providerSessionId }));
    } catch (error) {
      // A session's log file appears with its first message; until then the
      // backend answers 404, which just means there is nothing to show yet.
      if (error instanceof Error && error.message.startsWith("404")) return [];
      throw error;
    }
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

  async usage(): Promise<UsageSnapshot> {
    return this.backendJson<UsageSnapshot>("/usage/accounts");
  }

  async refreshUsage(accountKey?: string): Promise<UsageSnapshot> {
    return this.backendJson<UsageSnapshot>("/usage/refresh", {
      method: "POST",
      body: JSON.stringify({ account_key: accountKey ?? null }),
      // The laptop waits up to 12 s for the probe itself, beyond the usual request budget.
      signal: AbortSignal.timeout(25_000),
    });
  }

  protected async probe(baseUrl: string, label: string) {
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

  protected backendJson<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.config.backendUrl, path, init);
  }

  protected controlJson<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(this.controlUrl, path, init);
  }

  protected async request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
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

// Another machine's Athena through the host. Its control API is the same as
// the host's (terminals, streams, input, spawn); history comes from that
// machine's /agent-sessions and conversations from its /terminals/:id/chat,
// since only the host's Python backend is reachable from here. Usage stays
// the host's: it describes the host's signed-in accounts.
class RemoteAthenaClient extends HttpAthenaClient {
  override readonly historyTranscripts = false;
  private history: { workspace: string; at: number; sessions: AgentSession[]; error: Error | null } | null = null;

  constructor(
    config: AppConfig,
    override readonly machine: MachineRef,
  ) {
    super(config, `${config.remoteUrl}/m/${encodeURIComponent(machine.id)}`);
  }

  override async snapshot(projectDir?: string): Promise<MobileSnapshot> {
    const errors: SnapshotErrors = {};
    const settle = <T>(section: keyof SnapshotErrors, request: Promise<T>, fallback: T): Promise<T> =>
      request.catch((error: unknown) => {
        errors[section] = this.explain(error, "session history");
        return fallback;
      });
    const [service, terminals, recentSessions] = await Promise.all([
      this.refreshService(),
      settle(
        "terminals",
        this.controlJson<{ terminals: EmbeddedTerminalSession[] }>("/terminals").then((payload) => payload.terminals),
        [],
      ),
      projectDir
        ? settle(
            "sessions",
            this.recentSessions(projectDir),
            [],
          )
        : Promise.resolve([]),
    ]);
    return {
      service,
      hermes: null,
      terminals,
      recentSessions,
      workspaces: summarizeWorkspaces(terminals, recentSessions),
      errors,
    };
  }

  private async recentSessions(workspace: string): Promise<AgentSession[]> {
    const cached = this.history?.workspace === workspace ? this.history : null;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && !cached.error && age < REMOTE_HISTORY_TTL_MS) return cached.sessions;
    if (cached?.error && age < REMOTE_HISTORY_RETRY_MS) throw cached.error;
    try {
      const payload = await this.controlJson<{ sessions: RemoteAgentSession[] }>(`/agent-sessions?workspace=${encodeURIComponent(workspace)}`);
      const sessions = payload.sessions.slice(0, 25).map(fromRemoteSession);
      this.history = { workspace, at: Date.now(), sessions, error: null };
      return sessions;
    } catch (error) {
      this.history = { workspace, at: Date.now(), sessions: cached?.sessions ?? [], error: error instanceof Error ? error : new Error(String(error)) };
      throw error;
    }
  }

  override async sessionTranscript(): Promise<string> {
    throw new Error(`Past transcripts aren't available from ${this.machine.name} yet. Resume the session to see it.`);
  }

  override async conversation(terminal: EmbeddedTerminalSession): Promise<ConversationMessage[]> {
    if (terminal.kind === "shell" || !terminal.providerSessionId) return [];
    try {
      const snapshot = await this.controlJson<{ messages: { role: "user" | "assistant"; text: string }[]; missing?: boolean }>(
        `/terminals/${encodeURIComponent(terminal.id)}/chat`,
      );
      return snapshot.messages.map((message) => ({ role: message.role, text: message.text }));
    } catch (error) {
      throw new Error(this.explain(error, "the conversation view"));
    }
  }

  override async recentWorkspaces(): Promise<string[]> {
    const payload = await this.controlJson<{ workspaces: { nativePath: string }[] }>("/workspaces");
    return payload.workspaces.map((workspace) => workspace.nativePath).filter(Boolean);
  }

  // An older Athena there answers 404 "Unknown control endpoint" for routes it predates.
  private explain(error: unknown, feature: string): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unknown control endpoint/.test(message)) {
      return `${this.machine.name} runs an Athena without ${feature}; update Athena there to use it. The terminal view works.`;
    }
    return message;
  }
}

class DemoAthenaClient implements AthenaClient {
  private terminals: EmbeddedTerminalSession[];
  readonly historyTranscripts: boolean;

  constructor(
    private readonly config: AppConfig,
    readonly machine: MachineRef | null = null,
  ) {
    this.terminals = machine ? demoRemoteTerminals(machine) : demoTerminals;
    this.historyTranscripts = machine === null;
  }

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
      recentSessions: this.machine ? demoRemoteSessions : demoSessions,
      workspaces: summarizeWorkspaces(this.terminals, this.machine ? demoRemoteSessions : demoSessions),
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

  async usage(): Promise<UsageSnapshot> {
    return demoUsage(Date.now());
  }

  async refreshUsage(): Promise<UsageSnapshot> {
    return demoUsage(Date.now());
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

  async conversation(terminal: EmbeddedTerminalSession): Promise<ConversationMessage[]> {
    if (terminal.kind === "shell" || !terminal.providerSessionId) return [];
    return [
      { role: "user", text: terminal.initialTask || "What's the status?" },
      { role: "assistant", text: `Demo conversation for ${terminal.title}. Live mode shows the agent's real session.` },
    ];
  }

  async recentWorkspaces(): Promise<string[]> {
    if (this.machine) return Array.from(new Set(this.terminals.map((terminal) => terminal.workspace)));
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
    name: pathBaseName(path),
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

// One machine per state the switcher must render: ready (on Windows), one
// that needs its access token, and one that is offline.
function demoMachines(): MachinesSnapshot {
  const machine = (overrides: Partial<RemoteMachine> & Pick<RemoteMachine, "id" | "name" | "status">): RemoteMachine => ({
    os: "linux",
    online: true,
    ownDevice: true,
    detail: null,
    version: null,
    platform: null,
    homedir: null,
    ...overrides,
  });
  return {
    tailscale: "running",
    account: "ada@example.com",
    port: 47821,
    refreshedAt: new Date().toISOString(),
    self: { name: "ada-laptop", theme: "classic" },
    machines: [
      machine({ id: "demo-studio", name: "studio-pc", os: "windows", status: "ready", version: "0.4.1", platform: "win32", homedir: "C:\\Users\\ada" }),
      machine({
        id: "demo-build",
        name: "build-server",
        status: "needs-token",
        ownDevice: false,
        detail: "Not on your Tailscale account, so it needs its access token.",
      }),
      machine({ id: "demo-old", name: "old-laptop", status: "offline", online: false }),
    ],
  };
}

function demoRemoteTerminals(machine: MachineRef): EmbeddedTerminalSession[] {
  const home = machine.homedir ?? (machine.platform === "win32" ? "C:\\Users\\ada" : "/home/ada");
  const separator = machine.platform === "win32" ? "\\" : "/";
  return [
    {
      id: `demo-${machine.id}-claude`,
      title: "Claude",
      kind: "claude",
      workspace: `${home}${separator}game-port`,
      pid: 7700,
      promptPath: null,
      initialTask: "Port the renderer to Vulkan and report blockers.",
      sessionLabel: "Live",
      providerSessionId: "demo-remote-claude",
      createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
      status: "running",
      exitCode: null,
      error: null,
    },
  ];
}

const demoRemoteSessions: AgentSession[] = [
  {
    id: "demo-remote-session-1",
    provider: "codex",
    title: "Shader cache investigation",
    workspace: "C:\\Users\\ada\\game-port",
    branch: null,
    model: "gpt-5",
    agent: null,
    created_at: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    updated_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    status: "historical",
    terminal_id: null,
    pid: null,
    resume_command: null,
    metadata: {},
  },
];

// One record per state the usage UI must render: live, last-known after an
// expired sign-in, near a cap, and failing with nothing to show.
function demoUsage(now: number): UsageSnapshot {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const record = (overrides: Partial<UsageAccount> & Pick<UsageAccount, "key" | "provider" | "provider_name">): UsageAccount => ({
    account: { email: "ada@example.com", display_name: "Ada", organization: null, identified: true },
    profiles: [{ label: "default", path: overrides.provider === "codex" ? "~/.codex" : "~/.claude" }],
    plan: null,
    status: "ok",
    message: null,
    windows: [],
    stale: false,
    refreshing: false,
    fetched_at: at(-2),
    checked_at: at(-2),
    next_refresh_at: at(3),
    ...overrides,
  });
  return {
    generated_at: at(0),
    refresh_interval_seconds: 300,
    accounts: [
      record({
        key: "claude:demo0001",
        provider: "claude",
        provider_name: "Claude",
        plan: "Max 5x",
        account: { email: "ada@example.com", display_name: "Ada", organization: "Ada's Org", identified: true },
        windows: [
          { id: "session", label: "Session", used_percent: 27, resets_at: at(112), window_minutes: 300 },
          { id: "weekly", label: "Weekly", used_percent: 64, resets_at: at(4 * 1440 + 300), window_minutes: 10080 },
          { id: "weekly:fable", label: "Weekly · Fable", used_percent: 3, resets_at: at(4 * 1440 + 300), window_minutes: 10080 },
        ],
      }),
      record({
        key: "claude:demo0002",
        provider: "claude",
        provider_name: "Claude",
        plan: "Pro",
        profiles: [{ label: "work", path: "~/.claude-accounts/work" }],
        status: "expired",
        message: "The saved sign-in no longer works. Run Claude Code with CLAUDE_CONFIG_DIR=~/.claude-accounts/work to sign in.",
        stale: true,
        fetched_at: at(-95),
        checked_at: at(-20),
        next_refresh_at: null,
        windows: [{ id: "weekly", label: "Weekly", used_percent: 41, resets_at: at(2 * 1440), window_minutes: 10080 }],
      }),
      record({
        key: "codex:demo0003",
        provider: "codex",
        provider_name: "Codex",
        plan: "Plus",
        profiles: [
          { label: "default", path: "~/.codex" },
          { label: "account1", path: "~/.codex-accounts/account1" },
        ],
        windows: [
          { id: "codex:300", label: "Session", used_percent: 86, resets_at: at(47), window_minutes: 300 },
          { id: "codex:10080", label: "Weekly", used_percent: 39, resets_at: at(3 * 1440 + 90), window_minutes: 10080 },
        ],
      }),
      record({
        key: "codex:demo0004",
        provider: "codex",
        provider_name: "Codex",
        plan: "Pro",
        account: { email: "grace@example.com", display_name: "Grace", organization: null, identified: true },
        profiles: [{ label: "account2", path: "~/.codex-accounts/account2" }],
        status: "error",
        message: "codex app-server did not answer account/rateLimits/read in time.",
        fetched_at: null,
        next_refresh_at: at(1),
      }),
    ],
  };
}
