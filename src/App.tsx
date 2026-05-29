import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  CircleStop,
  Cpu,
  FileText,
  History,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  X,
} from "lucide-react";
import { createAthenaClient } from "./api/athenaClient";
import { readConfig } from "./config";
import { MobileTerminal } from "./components/MobileTerminal";
import type { AgentSession, EmbeddedTerminalKind, EmbeddedTerminalSession, MobileSnapshot } from "./types";

type Tab = "agents" | "launch" | "history" | "workspaces";

type TranscriptView = {
  session: AgentSession;
  state: "loading" | "ready" | "error";
  text: string;
};

const LAUNCH_KINDS: EmbeddedTerminalKind[] = ["codex", "claude", "opencode", "hermes", "shell"];
const SNAPSHOT_REFRESH_MS = 5000;

export function App() {
  const config = useMemo(() => readConfig(), []);
  const client = useMemo(() => createAthenaClient(config), [config]);

  const [tab, setTab] = useState<Tab>("agents");
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [launchTask, setLaunchTask] = useState("");
  const [launchKind, setLaunchKind] = useState<EmbeddedTerminalKind>("codex");
  const [launchWorkspace, setLaunchWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptView | null>(null);
  const refreshInFlight = useRef(false);

  const terminals = snapshot?.terminals ?? [];
  const selectedTerminal =
    terminals.find((entry) => entry.id === selectedTerminalId) ?? terminals[0] ?? null;
  const primaryWorkspace =
    selectedTerminal?.workspace || snapshot?.workspaces[0]?.path || config.projectDir;

  // Every workspace the user can spawn into: the configured project dir plus any
  // discovered from live terminals or recent sessions, de-duplicated and ordered.
  const workspaceOptions = useMemo(() => {
    const paths = new Set<string>();
    if (config.projectDir) paths.add(config.projectDir);
    for (const workspace of snapshot?.workspaces ?? []) paths.add(workspace.path);
    for (const terminal of terminals) paths.add(terminal.workspace);
    return Array.from(paths).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, terminals, config.projectDir]);
  const launchWorkspaceResolved = launchWorkspace || workspaceOptions[0] || primaryWorkspace;

  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setError(null);
    try {
      const next = await client.snapshot(primaryWorkspace || undefined);
      setSnapshot(next);
      setSelectedTerminalId((current) => current ?? next.terminals[0]?.id ?? null);
    } catch (refreshError) {
      setError(messageOf(refreshError));
    } finally {
      refreshInFlight.current = false;
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), SNAPSHOT_REFRESH_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Raw keystrokes (typed chars, quick-keys, control codes) go straight to the
  // PTY and echo back through the live stream. Fire-and-forget: toggling a busy
  // flag per keystroke would stall typing; we only surface errors.
  async function sendRaw(data: string) {
    if (!selectedTerminal) return;
    try {
      await client.sendTerminalRaw(selectedTerminal.id, data);
    } catch (sendError) {
      setError(messageOf(sendError));
    }
  }

  async function launchTerminal() {
    const task = launchTask.trim();
    const workspace = launchWorkspaceResolved;
    // A task is optional now — a bare agent/shell can be spawned to type into live.
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const sessions = await client.spawnTerminal({
        project_dir: workspace,
        kind: launchKind,
        task: task || undefined,
        title: `${labelForKind(launchKind)} Mobile`,
        context_mode: task ? "task" : "none",
      });
      setLaunchTask("");
      await refresh();
      const spawned = sessions[0]?.id ?? null;
      if (spawned) setSelectedTerminalId(spawned);
      setTab("agents");
    } catch (launchError) {
      setError(messageOf(launchError));
    } finally {
      setBusy(false);
    }
  }

  async function killTerminal(terminal: EmbeddedTerminalSession) {
    setBusy(true);
    setError(null);
    try {
      await client.killTerminal(terminal.id);
      setSelectedTerminalId((current) => (current === terminal.id ? null : current));
      await refresh();
    } catch (killError) {
      setError(messageOf(killError));
    } finally {
      setBusy(false);
    }
  }

  async function resumeSession(session: AgentSession) {
    setBusy(true);
    setError(null);
    try {
      const sessions = await client.resumeSession(session);
      await refresh();
      const spawned = sessions[0]?.id ?? null;
      if (spawned) setSelectedTerminalId(spawned);
      setTab("agents");
    } catch (resumeError) {
      setError(messageOf(resumeError));
    } finally {
      setBusy(false);
    }
  }

  async function openTranscript(session: AgentSession) {
    setTranscript({ session, state: "loading", text: "" });
    try {
      const text = await client.sessionTranscript(session);
      setTranscript({ session, state: "ready", text: text.trim() || "Transcript is empty." });
    } catch (transcriptError) {
      setTranscript({ session, state: "error", text: messageOf(transcriptError) });
    }
  }

  const backendHealthy = Boolean(snapshot?.service.backend.healthy);
  const controlHealthy = Boolean(snapshot?.service.control.healthy);

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">
          <span className="brandMark">A</span>
          <div>
            <strong>Athena</strong>
            <span>{config.mode === "live" ? "Live control" : "Demo mode"}</span>
          </div>
        </div>
        <div className="topStatus">
          <StatusDot label="API" online={backendHealthy} />
          <StatusDot label="Ctrl" online={controlHealthy} />
          <button className="iconButton" type="button" onClick={() => void refresh()} aria-label="Refresh">
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {error && <div className="errorBanner">{error}</div>}

      <main className="content">
        {tab === "agents" && (
          <AgentsView
            terminals={terminals}
            selected={selectedTerminal}
            streamUrl={selectedTerminal ? client.terminalStreamUrl(selectedTerminal.id) : null}
            busy={busy}
            onSelect={setSelectedTerminalId}
            onRaw={sendRaw}
            onStop={killTerminal}
            onGoLaunch={() => setTab("launch")}
          />
        )}

        {tab === "launch" && (
          <LaunchView
            kind={launchKind}
            task={launchTask}
            workspaces={workspaceOptions}
            selectedWorkspace={launchWorkspaceResolved}
            busy={busy}
            onKindChange={setLaunchKind}
            onTaskChange={setLaunchTask}
            onWorkspaceChange={setLaunchWorkspace}
            onLaunch={launchTerminal}
          />
        )}

        {tab === "history" && (
          <HistoryView
            sessions={snapshot?.recentSessions ?? []}
            busy={busy}
            onResume={resumeSession}
            onViewTranscript={openTranscript}
          />
        )}

        {tab === "workspaces" && <WorkspacesView snapshot={snapshot} />}
      </main>

      {transcript && <TranscriptSheet view={transcript} onClose={() => setTranscript(null)} />}

      <nav className="tabBar" aria-label="Sections">
        <TabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={<TerminalSquare size={18} />} label="Agents" badge={terminals.length} />
        <TabButton active={tab === "launch"} onClick={() => setTab("launch")} icon={<Play size={18} />} label="Launch" />
        <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<History size={18} />} label="History" />
        <TabButton active={tab === "workspaces"} onClick={() => setTab("workspaces")} icon={<Layers size={18} />} label="Spaces" />
      </nav>
    </div>
  );
}

function AgentsView({
  terminals,
  selected,
  streamUrl,
  busy,
  onSelect,
  onRaw,
  onStop,
  onGoLaunch,
}: {
  terminals: EmbeddedTerminalSession[];
  selected: EmbeddedTerminalSession | null;
  streamUrl: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onRaw: (data: string) => void;
  onStop: (terminal: EmbeddedTerminalSession) => void;
  onGoLaunch: () => void;
}) {
  if (terminals.length === 0) {
    return (
      <div className="emptyState">
        <Bot size={28} />
        <strong>No live agents</strong>
        <span>Launch an agent to control it from here.</span>
        <button className="primaryButton" type="button" onClick={onGoLaunch}>
          <Play size={16} /> Launch an agent
        </button>
      </div>
    );
  }

  const groups = groupByWorkspace(terminals);
  // The dropdown follows the selected terminal's workspace; switching it jumps
  // to that workspace's first terminal so the view below always stays in sync.
  const activeGroup = groups.find((group) => group.path === selected?.workspace) ?? groups[0];
  const changeWorkspace = (path: string) => {
    const next = groups.find((group) => group.path === path);
    if (next?.terminals[0]) onSelect(next.terminals[0].id);
  };

  return (
    <section className="agentsView">
      <div className="workspaceBar">
        <Layers size={15} />
        <select
          className="workspaceSelect"
          value={activeGroup?.path ?? ""}
          onChange={(event) => changeWorkspace(event.target.value)}
          aria-label="Workspace"
        >
          {groups.map((group) => (
            <option key={group.path} value={group.path}>
              {group.name} · {group.terminals.length}
            </option>
          ))}
        </select>
        <ChevronDown size={16} className="workspaceBarChevron" />
      </div>

      {activeGroup && (
        <div className="sessionStrip">
          {activeGroup.terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              className={selected?.id === terminal.id ? "sessionChip active" : "sessionChip"}
              onClick={() => onSelect(terminal.id)}
            >
              <span className={`providerDot ${terminal.kind}`} />
              <span className="sessionChipText">
                <strong>{terminal.title}</strong>
                <small>{terminal.kind}</small>
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="terminalCard">
          <div className="terminalCardHead">
            <div>
              <strong>{selected.title}</strong>
              <small>{selected.kind} · pid {selected.pid ?? "n/a"} · {selected.status}</small>
            </div>
            <button className="dangerButton" type="button" onClick={() => onStop(selected)} disabled={busy}>
              <CircleStop size={16} /> Stop
            </button>
          </div>

          <MobileTerminal key={selected.id} sessionId={selected.id} streamUrl={streamUrl} onInput={onRaw} />

          <QuickKeys onRaw={onRaw} />
        </div>
      )}
    </section>
  );
}

// Keys absent from mobile soft keyboards but essential for agent TUIs. Sequences
// are the raw bytes a PTY expects; they're written verbatim via the input endpoint.
const QUICK_KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "⇧Tab", seq: "\x1b[Z" },
  { label: "Ctrl-C", seq: "\x03" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "Enter", seq: "\r" },
];

function QuickKeys({ onRaw }: { onRaw: (data: string) => void }) {
  return (
    <div className="quickKeys" role="toolbar" aria-label="Terminal keys">
      {QUICK_KEYS.map((key) => (
        <button key={key.label} type="button" className="quickKey" onClick={() => onRaw(key.seq)}>
          {key.label}
        </button>
      ))}
    </div>
  );
}

function LaunchView({
  kind,
  task,
  workspaces,
  selectedWorkspace,
  busy,
  onKindChange,
  onTaskChange,
  onWorkspaceChange,
  onLaunch,
}: {
  kind: EmbeddedTerminalKind;
  task: string;
  workspaces: string[];
  selectedWorkspace: string;
  busy: boolean;
  onKindChange: (kind: EmbeddedTerminalKind) => void;
  onTaskChange: (value: string) => void;
  onWorkspaceChange: (value: string) => void;
  onLaunch: () => void;
}) {
  return (
    <section className="panel">
      <header className="panelHead">
        <span className="eyebrow">New terminal</span>
        <h1>Launch an agent</h1>
      </header>

      <div className="kindGrid">
        {LAUNCH_KINDS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={kind === entry ? "kindButton active" : "kindButton"}
            onClick={() => onKindChange(entry)}
          >
            <span className={`providerDot ${entry}`} />
            {labelForKind(entry)}
          </button>
        ))}
      </div>

      <div className="field">
        <span>Workspace</span>
        {workspaces.length === 0 ? (
          <p className="emptyText">No workspace discovered.</p>
        ) : (
          <div className="workspacePicker">
            {workspaces.map((path) => (
              <button
                key={path}
                type="button"
                className={path === selectedWorkspace ? "workspaceOption active" : "workspaceOption"}
                onClick={() => onWorkspaceChange(path)}
              >
                <Cpu size={15} />
                <span className="workspaceOptionText">
                  <strong>{workspaceName(path)}</strong>
                  <small>{path}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="field">
        <span>Task <em>(optional)</em></span>
        <textarea
          value={task}
          onChange={(event) => onTaskChange(event.target.value)}
          placeholder="Review the mobile gateway auth plan and report risks."
          rows={4}
        />
      </label>

      <button className="primaryButton wide" type="button" onClick={onLaunch} disabled={busy || !selectedWorkspace}>
        <Plus size={17} /> Launch {labelForKind(kind)}
      </button>
    </section>
  );
}

function WorkspacesView({ snapshot }: { snapshot: MobileSnapshot | null }) {
  const service = snapshot?.service;
  return (
    <section className="panel">
      <header className="panelHead">
        <span className="eyebrow">Connection</span>
        <h1>Workspaces</h1>
      </header>

      <div className="metrics">
        <Metric label="Backend" value={service?.backend.healthy ? "Healthy" : "Offline"} detail={service?.backend.baseUrl ?? "No URL"} />
        <Metric label="Control" value={service?.control.healthy ? "Healthy" : "Offline"} detail={service?.control.baseUrl ?? "No URL"} />
        <Metric label="Agents" value={String(snapshot?.terminals.length ?? 0)} detail="Live terminals" />
        <Metric label="Hermes" value={snapshot?.hermes?.installed ? "Ready" : "Unknown"} detail={snapshot?.hermes?.version ?? "Not loaded"} />
      </div>

      <div className="listSection">
        <span className="eyebrow">Active projects</span>
        {(snapshot?.workspaces ?? []).map((workspace) => (
          <div className="listRow" key={workspace.path}>
            <strong>{workspace.name}</strong>
            <small>{workspace.liveTerminals} live · {workspace.recentSessions} recent</small>
            <code>{workspace.path}</code>
          </div>
        ))}
        {snapshot && snapshot.workspaces.length === 0 && (
          <p className="emptyText">No workspaces returned by the configured API.</p>
        )}
      </div>
    </section>
  );
}

function HistoryView({
  sessions,
  busy,
  onResume,
  onViewTranscript,
}: {
  sessions: AgentSession[];
  busy: boolean;
  onResume: (session: AgentSession) => void;
  onViewTranscript: (session: AgentSession) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="emptyState">
        <History size={28} />
        <strong>No recent sessions</strong>
        <span>Native Codex, Claude, OpenCode, and Hermes sessions for this workspace appear here.</span>
      </div>
    );
  }

  return (
    <section className="panel">
      <header className="panelHead">
        <span className="eyebrow">Native history</span>
        <h1>Sessions</h1>
      </header>

      <div className="historyList">
        {sessions.map((session) => (
          <article className="historyRow" key={`${session.provider}:${session.id}`}>
            <div className="historyMeta">
              <span className={`providerDot ${session.provider}`} />
              <div className="historyText">
                <strong>{session.title}</strong>
                <small>{labelForKind(session.provider)} · {formatRelativeTime(session.updatedAt)} · {session.status}</small>
              </div>
            </div>
            <div className="historyActions">
              <button className="ghostButton" type="button" onClick={() => onViewTranscript(session)}>
                <FileText size={15} /> Transcript
              </button>
              <button className="primaryButton" type="button" onClick={() => onResume(session)} disabled={busy}>
                <RotateCcw size={15} /> Resume
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TranscriptSheet({ view, onClose }: { view: TranscriptView; onClose: () => void }) {
  return (
    <div className="sheetBackdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheetHead">
          <div>
            <strong>{view.session.title}</strong>
            <small>{labelForKind(view.session.provider)} transcript</small>
          </div>
          <button className="iconButton" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {view.state === "loading" ? (
          <p className="sheetStatus">Loading transcript…</p>
        ) : view.state === "error" ? (
          <p className="sheetStatus error">{view.text}</p>
        ) : (
          <pre className="transcriptBody">{view.text}</pre>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button type="button" className={active ? "tabButton active" : "tabButton"} onClick={onClick}>
      <span className="tabIcon">
        {icon}
        {badge ? <span className="tabBadge">{badge}</span> : null}
      </span>
      {label}
    </button>
  );
}

function StatusDot({ label, online }: { label: string; online: boolean }) {
  return (
    <span className={online ? "statusDot online" : "statusDot"}>
      <i />
      {label}
    </span>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function labelForKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function workspaceName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

type TerminalGroup = { path: string; name: string; terminals: EmbeddedTerminalSession[] };

// Bucket live terminals by their workspace so the agent strip reads as one
// section per project instead of an undifferentiated row of every session.
function groupByWorkspace(terminals: EmbeddedTerminalSession[]): TerminalGroup[] {
  const groups = new Map<string, EmbeddedTerminalSession[]>();
  for (const terminal of terminals) {
    const bucket = groups.get(terminal.workspace);
    if (bucket) bucket.push(terminal);
    else groups.set(terminal.workspace, [terminal]);
  }
  return Array.from(groups, ([path, items]) => ({ path, name: workspaceName(path), terminals: items }));
}

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
