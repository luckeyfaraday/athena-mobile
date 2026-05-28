export type ServiceState = {
  backend: EndpointState;
  control: EndpointState;
  mode: "demo" | "live";
};

export type EndpointState = {
  baseUrl: string | null;
  healthy: boolean;
  detail: string | null;
};

export type HermesStatus = {
  installed: boolean;
  command_path: string | null;
  version: string | null;
  hermes_home: string;
  memory_path: string | null;
  message: string;
};

export type EmbeddedTerminalKind = "shell" | "hermes" | "codex" | "opencode" | "claude";

export type EmbeddedTerminalSession = {
  id: string;
  title: string;
  kind: EmbeddedTerminalKind;
  workspace: string;
  pid: number | null;
  promptPath: string | null;
  initialTask: string | null;
  sessionLabel: string | null;
  providerSessionId: string | null;
  createdAt: string;
  status: "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
};

export type TerminalBuffer = {
  terminal: EmbeddedTerminalSession;
  buffer: string;
  chars: number;
  max_chars: number;
};

export type AgentSessionProvider = "codex" | "opencode" | "claude" | "hermes";

export type AgentSession = {
  id: string;
  provider: AgentSessionProvider;
  title: string;
  workspace: string;
  branch: string | null;
  model: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  status: "running" | "exited" | "historical";
  terminalId: string | null;
  pid: number | null;
  resumeCommand: string | null;
  metadata: Record<string, string>;
};

export type WorkspaceSummary = {
  path: string;
  name: string;
  liveTerminals: number;
  recentSessions: number;
};

export type MobileSnapshot = {
  service: ServiceState;
  hermes: HermesStatus | null;
  workspaces: WorkspaceSummary[];
  terminals: EmbeddedTerminalSession[];
  recentSessions: AgentSession[];
};

export type SpawnTerminalRequest = {
  project_dir: string;
  kind: EmbeddedTerminalKind;
  task?: string;
  title?: string;
  context_mode?: "none" | "task" | "curated";
};
