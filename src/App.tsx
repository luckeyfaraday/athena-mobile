import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bell,
  BellOff,
  BellRing,
  Bot,
  ChevronDown,
  CircleStop,
  Cpu,
  FileText,
  History,
  Layers,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  X,
} from "lucide-react";
import { createAthenaClient, summarizeWorkspaces } from "./api/athenaClient";
import { readConfig } from "./config";
import { enablePush, pushState, sendTestPush, type PushState } from "./push/notifications";
import { ConversationView } from "./components/ConversationView";
import { MobileTerminal } from "./components/MobileTerminal";
import type { AthenaClient } from "./api/athenaClient";
import type {
  AgentSession,
  EmbeddedTerminalKind,
  EmbeddedTerminalSession,
  MobileSnapshot,
  SnapshotErrors,
  TranscriptRef,
} from "./types";

type Tab = "agents" | "launch" | "history" | "workspaces";

/** How the selected agent is shown: its conversation, or the live terminal. */
type AgentView = "chat" | "terminal";

type TranscriptView = {
  session: AgentSession;
  state: "loading" | "ready" | "error";
  text: string;
};

type NotificationTarget = {
  terminalId: string;
  workspace: string | null;
  /** Absent on targets persisted by older builds. */
  view?: AgentView | null;
};

const LAUNCH_KINDS: EmbeddedTerminalKind[] = ["codex", "claude", "opencode", "athena", "grok", "hermes", "shell"];
const SNAPSHOT_REFRESH_MS = 5000;
// Recent projects come from a slow scan of every workspace's sessions, so
// refresh them at most this often while Launch is open.
const RECENT_WORKSPACES_REFRESH_MS = 5 * 60_000;
const LAUNCHED_WORKSPACES_LIMIT = 8;

export function App() {
  const config = useMemo(() => readConfig(), []);
  const client = useMemo(() => createAthenaClient(config), [config]);

  // Hydrate the cross-reload state (tab, selected terminal, last snapshot) so a
  // backgrounded PWA that the OS evicted comes back to the same view with its last
  // known content already on screen, then revalidates — instead of a blank UI that
  // blocks on the first network round-trip.
  const [tab, setTab] = useState<Tab>(() => loadPersisted<Tab>(STORAGE_KEYS.tab, "agents"));
  const [agentView, setAgentView] = useState<AgentView>(() => loadPersisted<AgentView>(STORAGE_KEYS.agentView, "chat"));
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(() =>
    loadPersisted<MobileSnapshot | null>(STORAGE_KEYS.snapshot, null),
  );
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(() =>
    loadPersisted<string | null>(STORAGE_KEYS.selectedTerminalId, null),
  );
  const [pendingNotificationTarget, setPendingNotificationTarget] = useState<NotificationTarget | null>(() =>
    parseNotificationTarget(window.location.href) ??
    loadPersisted<NotificationTarget | null>(STORAGE_KEYS.pendingNotificationTarget, null),
  );
  const [launchTask, setLaunchTask] = useState("");
  const [launchKind, setLaunchKind] = useState<EmbeddedTerminalKind>("codex");
  // null until the user picks or types a folder; "" when they cleared the field.
  const [launchWorkspace, setLaunchWorkspace] = useState<string | null>(null);
  // Folders launched from this phone, and project folders from session history
  // in any workspace. Both persist so the picker is full before any fetch.
  const [launchedWorkspaces, setLaunchedWorkspaces] = useState<string[]>(() =>
    loadPersisted<string[]>(STORAGE_KEYS.launchedWorkspaces, []),
  );
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() =>
    loadPersisted<string[]>(STORAGE_KEYS.recentWorkspaces, []),
  );
  const [recentState, setRecentState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const recentFetchedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptView | null>(null);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);

  const terminals = snapshot?.terminals ?? [];
  const selectedTerminal =
    terminals.find((entry) => entry.id === selectedTerminalId) ??
    (selectedTerminalId && pendingNotificationTarget ? null : terminals[0] ?? null);
  const primaryWorkspace =
    selectedTerminal?.workspace || pendingNotificationTarget?.workspace || snapshot?.workspaces[0]?.path || config.projectDir;

  // Every workspace the user can spawn into: the configured project dir plus any
  // discovered from live terminals or recent sessions, de-duplicated and ordered.
  // Every workspace the user can spawn into: live terminals' workspaces first,
  // then folders launched from here, the configured project dir, and recent
  // projects from session history, de-duplicated in that order.
  const workspaceOptions = useMemo(() => {
    const paths = new Set<string>();
    for (const terminal of terminals) paths.add(terminal.workspace);
    for (const path of launchedWorkspaces) paths.add(path);
    if (config.projectDir) paths.add(config.projectDir);
    for (const workspace of snapshot?.workspaces ?? []) paths.add(workspace.path);
    for (const path of recentWorkspaces) paths.add(path);
    return Array.from(paths).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, terminals, launchedWorkspaces, recentWorkspaces, config.projectDir]);
  const launchWorkspaceResolved = launchWorkspace ?? (workspaceOptions[0] || primaryWorkspace || "");

  // The polling effect below captures `refresh` once (empty deps), so route the
  // live workspace through a ref it reads on every tick — otherwise each poll
  // reuses the first-render workspace (config.projectDir, before any snapshot
  // loaded) instead of the currently-selected terminal's workspace.
  const primaryWorkspaceRef = useRef(primaryWorkspace);
  useEffect(() => {
    primaryWorkspaceRef.current = primaryWorkspace;
  }, [primaryWorkspace]);

  async function refresh() {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    setError(null);
    try {
      const next = await client.snapshot(primaryWorkspaceRef.current || undefined);
      setSnapshot((previous) => keepLastLoaded(previous, next));
      setSelectedTerminalId((current) => current ?? next.terminals[0]?.id ?? null);
    } catch (refreshError) {
      setError(messageOf(refreshError));
    } finally {
      refreshInFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh();
      }
    }
  }

  function queueNotificationTarget(target: NotificationTarget) {
    if (target.workspace) {
      primaryWorkspaceRef.current = target.workspace;
      setLaunchWorkspace(target.workspace);
    }
    setPendingNotificationTarget(target);
    setSelectedTerminalId(target.terminalId);
    if (target.view) setAgentView(target.view);
    setTab("agents");
    void refresh();
  }

  // Poll only while the tab is foregrounded: a hidden PWA can't show updates, and
  // stopping the timer (plus the SSE in MobileTerminal) lets the browser keep the
  // page bfcache-eligible so it can be restored without a reload. On return we
  // refresh immediately rather than waiting out the next interval.
  useEffect(() => {
    let interval: number | undefined;
    const start = () => {
      if (interval !== undefined) return;
      void refresh();
      interval = window.setInterval(() => void refresh(), SNAPSHOT_REFRESH_MS);
    };
    const stop = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the cross-reload state back to storage as it changes.
  useEffect(() => persist(STORAGE_KEYS.tab, tab), [tab]);
  useEffect(() => persist(STORAGE_KEYS.launchedWorkspaces, launchedWorkspaces), [launchedWorkspaces]);
  useEffect(() => persist(STORAGE_KEYS.recentWorkspaces, recentWorkspaces), [recentWorkspaces]);

  // Load recent projects when Launch opens. The request is not cancelled on
  // cleanup: the result is still worth keeping if the user has moved on.
  useEffect(() => {
    if (tab !== "launch" || Date.now() - recentFetchedAt.current < RECENT_WORKSPACES_REFRESH_MS) return;
    recentFetchedAt.current = Date.now();
    setRecentState({ loading: true, error: null });
    client
      .recentWorkspaces()
      .then((paths) => {
        setRecentWorkspaces(paths);
        setRecentState({ loading: false, error: null });
      })
      .catch((recentError) => {
        // Retry on the next visit rather than waiting out the refresh interval.
        recentFetchedAt.current = 0;
        setRecentState({ loading: false, error: messageOf(recentError) });
      });
  }, [tab, client]);
  useEffect(() => persist(STORAGE_KEYS.agentView, agentView), [agentView]);
  useEffect(() => persist(STORAGE_KEYS.snapshot, snapshot), [snapshot]);
  useEffect(() => persist(STORAGE_KEYS.selectedTerminalId, selectedTerminalId), [selectedTerminalId]);
  useEffect(() => persist(STORAGE_KEYS.pendingNotificationTarget, pendingNotificationTarget), [pendingNotificationTarget]);

  // Apply a notification route only after the live terminal snapshot confirms
  // the target still exists. Until then, keep the target persisted so a cold
  // launch or mobile restore cannot drop the tap and fall back to another agent.
  useEffect(() => {
    if (!pendingNotificationTarget || !snapshot) return;
    const target = terminals.find(
      (terminal) =>
        terminal.id === pendingNotificationTarget.terminalId &&
        (!pendingNotificationTarget.workspace || terminal.workspace === pendingNotificationTarget.workspace),
    );
    if (!target) return;
    setSelectedTerminalId(target.id);
    setLaunchWorkspace(target.workspace);
    setTab("agents");
    setPendingNotificationTarget(null);
  }, [pendingNotificationTarget, snapshot, terminals]);

  // Deep-link from a notification: focus the agent it fired for. Covers both the
  // cold open (the SW launched a new window at /?terminal=…&workspace=…) and a
  // warm focus (the SW posts a message to the already-open app).
  useEffect(() => {
    const focusTerminal = (rawUrl: string) => {
      const target = parseNotificationTarget(rawUrl);
      if (target) queueNotificationTarget(target);
    };
    focusTerminal(window.location.href);
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "athena-notification-click") focusTerminal(event.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
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

  // Whole messages from the conversation composer. The control server pastes
  // the text and presses Enter the way each agent's TUI expects.
  async function sendMessage(text: string) {
    if (!selectedTerminal) return;
    try {
      await client.sendTerminalInput(selectedTerminal.id, text);
    } catch (sendError) {
      setError(messageOf(sendError));
      throw sendError;
    }
  }

  async function launchTerminal() {
    const task = launchTask.trim();
    const workspace = launchWorkspaceResolved.trim().replace(/(.)\/+$/, "$1");
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
      void client.openDesktopWorkspace(workspace).catch(() => {});
      setLaunchTask("");
      setLaunchedWorkspaces((current) =>
        [workspace, ...current.filter((path) => path !== workspace)].slice(0, LAUNCHED_WORKSPACES_LIMIT),
      );
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
  const banner = error ?? loadErrorMessage(snapshot);

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="brand">
          <img className="brandMark" src="/athena-icon-256.png" alt="Athena" width={30} height={30} />
          <div>
            <strong>Athena</strong>
            <span>{config.mode === "live" ? "Live control" : "Demo mode"}</span>
          </div>
        </div>
        <div className="topStatus">
          <StatusDot label="API" online={backendHealthy} />
          <StatusDot label="Ctrl" online={controlHealthy} />
          <NotificationsButton />
          <button className="iconButton" type="button" onClick={() => void refresh()} aria-label="Refresh">
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

      {banner && <div className="errorBanner">{banner}</div>}

      <main className="content">
        {tab === "agents" && (
          <AgentsView
            client={client}
            terminals={terminals}
            selected={selectedTerminal}
            streamUrl={selectedTerminal ? client.terminalStreamUrl(selectedTerminal.id) : null}
            view={agentView}
            busy={busy}
            onSelect={setSelectedTerminalId}
            onViewChange={setAgentView}
            onRaw={sendRaw}
            onSend={sendMessage}
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
            recentState={recentState}
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
  client,
  terminals,
  selected,
  streamUrl,
  view,
  busy,
  onSelect,
  onViewChange,
  onRaw,
  onSend,
  onStop,
  onGoLaunch,
}: {
  client: AthenaClient;
  terminals: EmbeddedTerminalSession[];
  selected: EmbeddedTerminalSession | null;
  streamUrl: string | null;
  view: AgentView;
  busy: boolean;
  onSelect: (id: string) => void;
  onViewChange: (view: AgentView) => void;
  onRaw: (data: string) => void;
  onSend: (text: string) => Promise<void>;
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
  const transcript = selected ? transcriptRefFor(selected) : null;
  const showChat = view === "chat" && transcript !== null;
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
            <div className="terminalCardTitle">
              <strong>{selected.title}</strong>
              <small>{selected.kind} · pid {selected.pid ?? "n/a"} · {selected.status}</small>
            </div>
            <div className="terminalCardActions">
              {transcript && (
                <div className="viewToggle" role="group" aria-label="Agent view">
                  <button
                    type="button"
                    className={showChat ? "active" : undefined}
                    onClick={() => onViewChange("chat")}
                    aria-label="Conversation"
                    aria-pressed={showChat}
                  >
                    <MessageSquareText size={15} />
                  </button>
                  <button
                    type="button"
                    className={showChat ? undefined : "active"}
                    onClick={() => onViewChange("terminal")}
                    aria-label="Terminal"
                    aria-pressed={!showChat}
                  >
                    <TerminalSquare size={15} />
                  </button>
                </div>
              )}
              <button className="dangerButton" type="button" onClick={() => onStop(selected)} disabled={busy}>
                <CircleStop size={16} /> Stop
              </button>
            </div>
          </div>

          {showChat && transcript ? (
            <ConversationView key={selected.id} client={client} transcript={transcript} onSend={onSend} />
          ) : (
            <MobileTerminal key={selected.id} sessionId={selected.id} streamUrl={streamUrl} onInput={onRaw} />
          )}

          <QuickKeys onRaw={onRaw} />
        </div>
      )}
    </section>
  );
}

// Agent terminals that Athena has linked to their native session can show the
// conversation; shells and not-yet-linked panes only have the terminal.
function transcriptRefFor(terminal: EmbeddedTerminalSession): TranscriptRef | null {
  if (terminal.kind === "shell" || !terminal.providerSessionId) return null;
  return { provider: terminal.kind, id: terminal.providerSessionId };
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
  recentState,
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
  recentState: { loading: boolean; error: string | null };
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
        {/* Any folder on the laptop; picking a project below fills it in. */}
        <input
          className="pathInput"
          value={selectedWorkspace}
          onChange={(event) => onWorkspaceChange(event.target.value)}
          placeholder="/home/alan/home_ai/projects/…"
          aria-label="Workspace folder"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {recentState.loading ? (
          <p className="emptyText">Loading recent projects…</p>
        ) : recentState.error ? (
          <p className="emptyText">Couldn't load recent projects ({recentState.error}).</p>
        ) : null}
        {workspaces.length > 0 && (
          <div className="workspacePicker">
            {workspaces.map((path) => (
              <button
                key={path}
                type="button"
                className={path === selectedWorkspace.trim() ? "workspaceOption active" : "workspaceOption"}
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

      <button className="primaryButton wide" type="button" onClick={onLaunch} disabled={busy || !selectedWorkspace.trim()}>
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
        <span>Native Codex, Claude, OpenCode, Athena Code, Grok, and Hermes sessions for this workspace appear here.</span>
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
                <small>{labelForKind(session.provider)} · {formatRelativeTime(session.updated_at)} · {session.status}</small>
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

// Header control for agent-attention push. Reflects the live permission/
// subscription state: tap to enroll when off, tap to fire a test ping when on.
// Disabled (with an explanatory tooltip) where push can't work — an insecure
// origin or a browser without the Push API.
function NotificationsButton() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [pending, setPending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void pushState().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const ready = state === "granted";
  const enrollable = state === "default";
  const blocked = state === "denied" || state === "insecure" || state === "unsupported";

  const baseTitle = ready
    ? "Notifications on — tap to send a test"
    : enrollable
      ? "Enable agent-attention notifications"
      : state === "insecure"
        ? "Open the app over HTTPS (tailscale serve) to enable notifications"
        : state === "denied"
          ? "Notifications blocked — allow them in browser settings"
          : state === "unsupported"
            ? "This browser does not support Web Push"
            : "Notifications";
  const title = lastError ? `${baseTitle}. Last error: ${lastError}` : baseTitle;

  const onClick = async () => {
    if (pending || state === "loading" || blocked) return;
    setPending(true);
    setLastError(null);
    try {
      if (ready) {
        await sendTestPush();
      } else {
        const result = await enablePush();
        setState(result.state);
        if (!result.ok && result.error) setLastError(result.error);
      }
    } catch (pushError) {
      setLastError(messageOf(pushError));
      void pushState().then(setState).catch(() => {});
    } finally {
      setPending(false);
    }
  };

  const Icon = ready ? BellRing : blocked ? BellOff : Bell;
  return (
    <button
      className={ready ? "iconButton notifyOn" : "iconButton"}
      type="button"
      onClick={() => void onClick()}
      disabled={pending || state === "loading" || blocked}
      aria-label={title}
      title={title}
    >
      <Icon size={17} />
    </button>
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

// Names the desktop app uses where plain capitalization would be wrong.
const KIND_LABELS: Record<string, string> = { athena: "Athena Code", opencode: "OpenCode" };

function labelForKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
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

// A section that failed to refresh keeps its last loaded contents instead of
// collapsing to an empty list, so a network blip on the phone doesn't read as
// "no agents" or tear down the open terminal. The failure still shows in the
// banner via loadErrorMessage.
function keepLastLoaded(previous: MobileSnapshot | null, next: MobileSnapshot): MobileSnapshot {
  if (!previous || !next.errors) return next;
  const terminals = next.errors.terminals ? previous.terminals : next.terminals;
  const recentSessions = next.errors.sessions ? previous.recentSessions : next.recentSessions;
  const hermes = next.errors.hermes ? previous.hermes : next.hermes;
  return { ...next, terminals, recentSessions, hermes, workspaces: summarizeWorkspaces(terminals, recentSessions) };
}

const SECTION_LABELS: Record<keyof SnapshotErrors, string> = {
  terminals: "live agents",
  sessions: "session history",
  hermes: "Hermes status",
};

function loadErrorMessage(snapshot: MobileSnapshot | null): string | null {
  const errors = snapshot?.errors ?? {};
  const failures = (Object.keys(SECTION_LABELS) as (keyof SnapshotErrors)[])
    .filter((section) => errors[section])
    .map((section) => `${SECTION_LABELS[section]} (${errors[section]})`);
  return failures.length ? `Couldn't refresh ${failures.join(", ")}.` : null;
}

function parseNotificationTarget(rawUrl: string): NotificationTarget | null {
  try {
    const params = new URL(rawUrl, window.location.origin).searchParams;
    const terminalId = params.get("terminal")?.trim();
    if (!terminalId) return null;
    const workspace = params.get("workspace")?.trim() || null;
    const view = params.get("view");
    return { terminalId, workspace, view: view === "chat" || view === "terminal" ? view : null };
  } catch {
    return null;
  }
}

// localStorage (not sessionStorage) so the view survives a full OS eviction of the
// backgrounded PWA, not just an in-tab reload.
const STORAGE_KEYS = {
  tab: "athena.tab",
  launchedWorkspaces: "athena.launchedWorkspaces",
  recentWorkspaces: "athena.recentWorkspaces",
  agentView: "athena.agentView",
  snapshot: "athena.snapshot",
  selectedTerminalId: "athena.selectedTerminalId",
  pendingNotificationTarget: "athena.pendingNotificationTarget",
} as const;

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Storage unavailable (private mode) or corrupt JSON — fall back to default.
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — non-fatal; the app just loses instant restore.
  }
}
