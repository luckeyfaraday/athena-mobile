import type {
  AgentSession,
  EmbeddedTerminalSession,
  HermesStatus,
  MobileSnapshot,
  ServiceState,
  SpawnTerminalRequest,
  TerminalBuffer,
  WorkspaceSummary,
} from "../types";
import type { AppConfig } from "../config";
import { initialServiceState } from "../config";

export type AthenaClient = {
  snapshot(projectDir?: string): Promise<MobileSnapshot>;
  refreshService(): Promise<ServiceState>;
  terminalBuffer(target: string, maxChars?: number): Promise<TerminalBuffer>;
  sendTerminalInput(target: string, text: string): Promise<EmbeddedTerminalSession>;
  spawnTerminal(request: SpawnTerminalRequest): Promise<EmbeddedTerminalSession[]>;
  killTerminal(target: string): Promise<EmbeddedTerminalSession>;
};

export function createAthenaClient(config: AppConfig): AthenaClient {
  if (config.mode === "live") return new HttpAthenaClient(config);
  return new DemoAthenaClient(config);
}

class HttpAthenaClient implements AthenaClient {
  constructor(private readonly config: AppConfig) {}

  async snapshot(projectDir?: string): Promise<MobileSnapshot> {
    const [service, hermes, terminals, recentSessions] = await Promise.all([
      this.refreshService(),
      this.backendJson<{ hermes: HermesStatus }>("/hermes/status").then((payload) => payload.hermes).catch(() => null),
      this.controlJson<{ terminals: EmbeddedTerminalSession[] }>("/terminals").then((payload) => payload.terminals),
      projectDir
        ? this.backendJson<{ sessions: AgentSession[] }>(`/agents/sessions?project_dir=${encodeURIComponent(projectDir)}&limit=25`).then((payload) => payload.sessions)
        : Promise.resolve([]),
    ]);
    return {
      service,
      hermes,
      terminals,
      recentSessions,
      workspaces: summarizeWorkspaces(terminals, recentSessions),
    };
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
      headers: {
        "Content-Type": "application/json",
        ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
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
}

function summarizeWorkspaces(terminals: EmbeddedTerminalSession[], sessions: AgentSession[]): WorkspaceSummary[] {
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
    providerSessionId: null,
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
    createdAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: null,
    metadata: {},
  },
];
