import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CircleStop,
  Command,
  Cpu,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { createAthenaClient } from "./api/athenaClient";
import { readConfig } from "./config";
import type { EmbeddedTerminalKind, EmbeddedTerminalSession, MobileSnapshot } from "./types";

type View = "overview" | "agents" | "launch";

export function App() {
  const config = useMemo(() => readConfig(), []);
  const client = useMemo(() => createAthenaClient(config), [config]);
  const [view, setView] = useState<View>("overview");
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [terminalBuffer, setTerminalBuffer] = useState("");
  const [launchTask, setLaunchTask] = useState("");
  const [launchKind, setLaunchKind] = useState<EmbeddedTerminalKind>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTerminal = snapshot?.terminals.find((entry) => entry.id === selectedTerminalId) ?? snapshot?.terminals[0] ?? null;
  const primaryWorkspace = snapshot?.workspaces[0]?.path || "/home/alan/home_ai/projects/context-workspace";

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const next = await client.snapshot(primaryWorkspace);
      setSnapshot(next);
      setSelectedTerminalId((current) => current ?? next.terminals[0]?.id ?? null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setBusy(false);
    }
  }

  async function refreshTerminalBuffer(target = selectedTerminalId) {
    if (!target) {
      setTerminalBuffer("");
      return;
    }
    try {
      const next = await client.terminalBuffer(target, 60_000);
      setTerminalBuffer(next.buffer);
    } catch (bufferError) {
      setTerminalBuffer(`Unable to load terminal output: ${bufferError instanceof Error ? bufferError.message : String(bufferError)}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void refreshTerminalBuffer();
    if (!selectedTerminalId) return;
    const interval = window.setInterval(() => {
      void refreshTerminalBuffer(selectedTerminalId);
    }, 2000);
    return () => window.clearInterval(interval);
  }, [selectedTerminalId]);

  async function sendPrompt() {
    if (!selectedTerminal || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.sendTerminalInput(selectedTerminal.id, `${prompt.trim()}\n`);
      setPrompt("");
      await refreshTerminalBuffer(selectedTerminal.id);
      await refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  }

  async function launchTerminal() {
    if (!launchTask.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const sessions = await client.spawnTerminal({
        project_dir: primaryWorkspace,
        kind: launchKind,
        task: launchTask.trim(),
        title: `${labelForKind(launchKind)} Mobile`,
        context_mode: "task",
      });
      setSelectedTerminalId(sessions[0]?.id ?? null);
      setLaunchTask("");
      await refresh();
      setView("agents");
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setBusy(false);
    }
  }

  async function killTerminal(terminal: EmbeddedTerminalSession) {
    setBusy(true);
    setError(null);
    try {
      await client.killTerminal(terminal.id);
      await refresh();
    } catch (killError) {
      setError(killError instanceof Error ? killError.message : String(killError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div className="brand">
          <span className="brandMark">A</span>
          <div>
            <strong>Athena Mobile</strong>
            <span>{config.mode === "live" ? "Live control" : "Demo mode"}</span>
          </div>
        </div>
        <button className="iconButton" type="button" onClick={refresh} disabled={busy} aria-label="Refresh">
          <RefreshCw size={18} />
        </button>
      </header>

      {error && <div className="errorBanner">{error}</div>}

      <nav className="segmented" aria-label="Athena mobile views">
        <button type="button" className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
          <Activity size={16} /> Overview
        </button>
        <button type="button" className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>
          <TerminalSquare size={16} /> Agents
        </button>
        <button type="button" className={view === "launch" ? "active" : ""} onClick={() => setView("launch")}>
          <Play size={16} /> Launch
        </button>
      </nav>

      {view === "overview" && <Overview snapshot={snapshot} />}

      {view === "agents" && (
        <section className="panel">
          <div className="sectionHeader">
            <div>
              <span className="eyebrow">Live PTY control</span>
              <h1>Running agents</h1>
            </div>
            <span className="countPill">{snapshot?.terminals.length ?? 0}</span>
          </div>

          <div className="terminalList">
            {(snapshot?.terminals ?? []).map((terminal) => (
              <button
                key={terminal.id}
                type="button"
                className={selectedTerminal?.id === terminal.id ? "terminalRow active" : "terminalRow"}
                onClick={() => setSelectedTerminalId(terminal.id)}
              >
                <span className={`providerDot ${terminal.kind}`} />
                <span>
                  <strong>{terminal.title}</strong>
                  <small>{terminal.kind} · pid {terminal.pid ?? "n/a"}</small>
                </span>
                <StatusLabel value={terminal.status} />
              </button>
            ))}
          </div>

          {selectedTerminal && (
            <div className="controlSurface">
              <div className="controlTitle">
                <div>
                  <span className="eyebrow">Selected</span>
                  <h2>{selectedTerminal.title}</h2>
                </div>
                <button className="dangerIconButton" type="button" onClick={() => killTerminal(selectedTerminal)} disabled={busy}>
                  <CircleStop size={17} /> Stop
                </button>
              </div>
              <div className="terminalTail">
                <span>$ athena terminal tail</span>
                <pre>{terminalBuffer || "No terminal output returned yet."}</pre>
              </div>
              <label className="promptBox">
                <span>Send prompt</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask the running agent for a status update." />
              </label>
              <button className="primaryButton" type="button" onClick={sendPrompt} disabled={busy || !prompt.trim()}>
                <Send size={17} /> Send to agent
              </button>
            </div>
          )}
        </section>
      )}

      {view === "launch" && (
        <section className="panel">
          <div className="sectionHeader">
            <div>
              <span className="eyebrow">New terminal</span>
              <h1>Start an agent</h1>
            </div>
          </div>
          <div className="kindGrid">
            {(["codex", "opencode", "claude", "hermes", "shell"] as EmbeddedTerminalKind[]).map((kind) => (
              <button key={kind} type="button" className={launchKind === kind ? "kindButton active" : "kindButton"} onClick={() => setLaunchKind(kind)}>
                <Bot size={17} />
                {labelForKind(kind)}
              </button>
            ))}
          </div>
          <label className="promptBox">
            <span>Task</span>
            <textarea value={launchTask} onChange={(event) => setLaunchTask(event.target.value)} placeholder="Review the mobile gateway auth plan and report risks." />
          </label>
          <div className="workspaceHint">
            <Command size={16} />
            <span>{primaryWorkspace}</span>
          </div>
          <button className="primaryButton" type="button" onClick={launchTerminal} disabled={busy || !launchTask.trim()}>
            <Play size={17} /> Launch {labelForKind(launchKind)}
          </button>
        </section>
      )}
    </main>
  );
}

function Overview({ snapshot }: { snapshot: MobileSnapshot | null }) {
  const service = snapshot?.service;
  return (
    <section className="panel">
      <div className="sectionHeader">
        <div>
          <span className="eyebrow">Connection</span>
          <h1>Mission control</h1>
        </div>
        <ShieldCheck size={22} />
      </div>
      <div className="metricsGrid">
        <Metric icon={<Cpu size={17} />} label="Backend" value={service?.backend.healthy ? "Healthy" : "Offline"} detail={service?.backend.baseUrl ?? "No URL"} />
        <Metric icon={<TerminalSquare size={17} />} label="Control" value={service?.control.healthy ? "Healthy" : "Offline"} detail={service?.control.baseUrl ?? "No URL"} />
        <Metric icon={<Bot size={17} />} label="Live agents" value={String(snapshot?.terminals.length ?? 0)} detail="Electron PTYs" />
        <Metric icon={<Activity size={17} />} label="Hermes" value={snapshot?.hermes?.installed ? "Ready" : "Unknown"} detail={snapshot?.hermes?.version ?? "Not loaded"} />
      </div>

      <div className="sectionHeader compact">
        <div>
          <span className="eyebrow">Workspaces</span>
          <h2>Active projects</h2>
        </div>
      </div>
      <div className="workspaceList">
        {(snapshot?.workspaces ?? []).map((workspace) => (
          <div className="workspaceRow" key={workspace.path}>
            <strong>{workspace.name}</strong>
            <span>{workspace.liveTerminals} live · {workspace.recentSessions} recent</span>
            <small>{workspace.path}</small>
          </div>
        ))}
        {snapshot && snapshot.workspaces.length === 0 && <p className="emptyText">No Athena workspaces returned by the configured API.</p>}
      </div>
    </section>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span className="metricIcon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function StatusLabel({ value }: { value: string }) {
  return <span className={`statusLabel ${value}`}>{value}</span>;
}

function labelForKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
