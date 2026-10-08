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

export type EmbeddedTerminalKind = "shell" | "hermes" | "codex" | "opencode" | "claude" | "athena" | "grok";

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

export type AgentSessionProvider = "codex" | "opencode" | "claude" | "hermes" | "athena" | "grok";

// Mirrors the backend's AgentSession payload, which is snake_case (Python
// dataclass), unlike the camelCase terminals from the Electron control server.
export type AgentSession = {
  id: string;
  provider: AgentSessionProvider;
  title: string;
  workspace: string;
  branch: string | null;
  model: string | null;
  agent: string | null;
  created_at: string;
  updated_at: string;
  status: "running" | "exited" | "historical";
  terminal_id: string | null;
  pid: number | null;
  resume_command: string | null;
  metadata: Record<string, string>;
};

/** Names a native session transcript: a history entry, or a live terminal's provider session. */
export type TranscriptRef = { provider: AgentSessionProvider; id: string };

export type WorkspaceSummary = {
  path: string;
  name: string;
  liveTerminals: number;
  recentSessions: number;
};

/** Why a snapshot section failed to load; absent means it loaded (or wasn't requested). */
export type SnapshotErrors = {
  hermes?: string;
  terminals?: string;
  sessions?: string;
};

export type MobileSnapshot = {
  service: ServiceState;
  hermes: HermesStatus | null;
  workspaces: WorkspaceSummary[];
  terminals: EmbeddedTerminalSession[];
  recentSessions: AgentSession[];
  /** Optional so snapshots persisted by older builds still hydrate. */
  errors?: SnapshotErrors;
};

export type SpawnTerminalRequest = {
  project_dir: string;
  kind: EmbeddedTerminalKind;
  task?: string;
  title?: string;
  context_mode?: "none" | "task" | "curated";
  /** Native session id to resume; the control server rebuilds the provider's resume command. */
  resume_session_id?: string;
  /** Human label shown on the resumed terminal (typically the original session title). */
  session_label?: string;
};

// Subscription quota records from the backend's /usage/accounts. The laptop
// owns provider logins; these carry display fields only, never credentials.
export type UsageStatus =
  | "ok"
  | "loading"
  | "stale"
  | "expired"
  | "signed_out"
  | "rate_limited"
  | "error"
  | "unsupported";

export type UsageWindow = {
  id: string;
  label: string;
  used_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
};

export type UsageAccount = {
  key: string;
  provider: string;
  provider_name: string;
  account: {
    email: string | null;
    display_name: string | null;
    organization: string | null;
    identified: boolean;
  };
  profiles: { label: string; path: string }[];
  plan: string | null;
  status: UsageStatus;
  message: string | null;
  windows: UsageWindow[];
  stale: boolean;
  refreshing: boolean;
  fetched_at: string | null;
  checked_at: string | null;
  next_refresh_at: string | null;
};

export type UsageSnapshot = {
  accounts: UsageAccount[];
  generated_at: string;
  refresh_interval_seconds: number;
};

// Other machines on the tailnet, from the laptop's /athena-remote/machines.
// Statuses match desktop Athena's machine switcher (remote-machines.ts).
export type MachineStatus = "ready" | "needs-token" | "refused" | "no-athena" | "offline" | "unknown";

export type RemoteMachine = {
  /** Tailscale stable node id. */
  id: string;
  name: string;
  os: string | null;
  online: boolean;
  /** Signed in to the same Tailscale account as the laptop. */
  ownDevice: boolean;
  status: MachineStatus;
  detail: string | null;
  version: string | null;
  /** Node's process.platform there, e.g. "win32". */
  platform: string | null;
  homedir: string | null;
};

export type MachinesSnapshot = {
  tailscale: "running" | "stopped" | "unavailable";
  account: string | null;
  port: number;
  machines: RemoteMachine[];
  refreshedAt: string | null;
  /** The laptop itself, and desktop Athena's theme there. */
  self: { name: string | null; theme: string | null };
};

/** The machine a client talks to; null means the laptop serving this app. */
export type MachineRef = Pick<RemoteMachine, "id" | "name" | "platform" | "homedir">;

// A remote control server's /agent-sessions rows: the same session as
// AgentSession, but camelCase from the Electron side.
export type RemoteAgentSession = {
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

/** A native conversation as chat messages, from the transcript or a remote's /terminals/:id/chat. */
export type ConversationMessage = { role: "user" | "assistant" | "tool"; text: string };
