import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  CircleStop,
  Cpu,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Send,
  TerminalSquare,
} from "lucide-react";
import { createAthenaClient } from "./api/athenaClient";
import { readConfig } from "./config";
import { MobileTerminal } from "./components/MobileTerminal";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession, MobileSnapshot } from "./types";

type Tab = "agents" | "launch" | "workspaces";

const LAUNCH_KINDS: EmbeddedTerminalKind[] = ["codex", "claude", "opencode", "hermes", "shell"];
const SNAPSHOT_REFRESH_MS = 5000;

export function App() {
  const config = useMemo(() => readConfig(), []);
  const client = useMemo(() => createAthenaClient(config), [config]);

  const [tab, setTab] = useState<Tab>("agents");
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [launchTask, setLaunchTask] = useState("");
  const [launchKind, setLaunchKind] = useState<EmbeddedTerminalKind>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

  const terminals = snapshot?.terminals ?? [];
  const selectedTerminal =
    terminals.find((entry) => entry.id === selectedTerminalId) ?? terminals[0] ?? null;
  const primaryWorkspace =
    selectedTerminal?.workspace || snapshot?.workspaces[0]?.path || config.projectDir;

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

  async function sendPrompt() {
    const text = prompt.trim();
    if (!selectedTerminal || !text) return;
    setBusy(true);
    setError(null);
    try {
      // The control server applies the per-agent submit sequence, so send the
      // raw line — the result streams back into the live terminal view.
      await client.sendTerminalInput(selectedTerminal.id, text);
      setPrompt("");
    } catch (sendError) {
      setError(messageOf(sendError));
    } finally {
      setBusy(false);
    }
  }

  async function launchTerminal() {
    const task = launchTask.trim();
    if (!task || !primaryWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const sessions = await client.spawnTerminal({
        project_dir: primaryWorkspace,
        kind: launchKind,
        task,
        title: `${labelForKind(launchKind)} Mobile`,
        context_mode: "task",
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
            prompt={prompt}
            busy={busy}
            onSelect={setSelectedTerminalId}
            onPromptChange={setPrompt}
            onSend={sendPrompt}
            onStop={killTerminal}
            onGoLaunch={() => setTab("launch")}
          />
        )}

        {tab === "launch" && (
          <LaunchView
            kind={launchKind}
            task={launchTask}
            workspace={primaryWorkspace}
            busy={busy}
            onKindChange={setLaunchKind}
            onTaskChange={setLaunchTask}
            onLaunch={launchTerminal}
          />
        )}

        {tab === "workspaces" && <WorkspacesView snapshot={snapshot} />}
      </main>

      <nav className="tabBar" aria-label="Sections">
        <TabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={<TerminalSquare size={20} />} label="Agents" badge={terminals.length} />
        <TabButton active={tab === "launch"} onClick={() => setTab("launch")} icon={<Play size={20} />} label="Launch" />
        <TabButton active={tab === "workspaces"} onClick={() => setTab("workspaces")} icon={<Layers size={20} />} label="Spaces" />
      </nav>
    </div>
  );
}

function AgentsView({
  terminals,
  selected,
  streamUrl,
  prompt,
  busy,
  onSelect,
  onPromptChange,
  onSend,
  onStop,
  onGoLaunch,
}: {
  terminals: EmbeddedTerminalSession[];
  selected: EmbeddedTerminalSession | null;
  streamUrl: string | null;
  prompt: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onPromptChange: (value: string) => void;
  onSend: () => void;
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

  return (
    <section className="agentsView">
      <div className="sessionStrip">
        {terminals.map((terminal) => (
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

          <MobileTerminal key={selected.id} sessionId={selected.id} streamUrl={streamUrl} />

          <div className="composer">
            <textarea
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
              placeholder="Send a prompt to this agent…"
              rows={1}
            />
            <button className="primaryButton sendButton" type="button" onClick={onSend} disabled={busy || !prompt.trim()}>
              <Send size={17} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function LaunchView({
  kind,
  task,
  workspace,
  busy,
  onKindChange,
  onTaskChange,
  onLaunch,
}: {
  kind: EmbeddedTerminalKind;
  task: string;
  workspace: string;
  busy: boolean;
  onKindChange: (kind: EmbeddedTerminalKind) => void;
  onTaskChange: (value: string) => void;
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

      <label className="field">
        <span>Task</span>
        <textarea
          value={task}
          onChange={(event) => onTaskChange(event.target.value)}
          placeholder="Review the mobile gateway auth plan and report risks."
          rows={4}
        />
      </label>

      <div className="workspaceHint">
        <Cpu size={15} />
        <span>{workspace || "No workspace discovered"}</span>
      </div>

      <button className="primaryButton wide" type="button" onClick={onLaunch} disabled={busy || !task.trim() || !workspace}>
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

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
