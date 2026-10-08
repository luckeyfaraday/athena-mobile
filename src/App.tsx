import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
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
  RotateCcw,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import { createAthenaClient, fetchMachines, summarizeWorkspaces } from "./api/athenaClient";
import { readConfig, type AppConfig } from "./config";
import { ConversationView } from "./components/ConversationView";
import { MachineButton, MachineSheet, type MachinesLoadState } from "./components/Machines";
import { MobileTerminal } from "./components/MobileTerminal";
import { SettingsView, type ConnectionInfo } from "./components/SettingsView";
import { UsageButton, UsageSheetHost, useUsage } from "./components/Usage";
import { isWindowsMachine, machineStorageKey, normalizeFolderInput, pathBaseName } from "./machines";
import {
  applyTheme,
  readLaptopTheme,
  readThemePreference,
  resolveTheme,
  systemPrefersLight,
  writeLaptopTheme,
  writeThemePreference,
  type ThemeId,
  type ThemePreference,
} from "./themes";
import type { AthenaClient } from "./api/athenaClient";
import type {
  AgentSession,
  EmbeddedTerminalKind,
  EmbeddedTerminalSession,
  MachineRef,
  MachinesSnapshot,
  MobileSnapshot,
  SnapshotErrors,
} from "./types";

type Tab = "agents" | "launch" | "history" | "settings";

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
// Machines change rarely; re-ask while the app is open, and on demand.
const MACHINES_REFRESH_MS = 60_000;

export function App() {
  const config = useMemo(() => readConfig(), []);
  // Usage always describes the host's signed-in accounts, whichever machine is in view.
  const laptopClient = useMemo(() => createAthenaClient(config), [config]);

  // Hydrate the cross-reload state (tab, machine, theme) so a backgrounded PWA
  // that the OS evicted comes back to the same view before any network answer.
  const [tab, setTab] = useState<Tab>(() => parseTab(loadPersisted<string>(STORAGE_KEYS.tab, "agents")));
  const [machines, setMachines] = useState<MachinesSnapshot | null>(() =>
    loadPersisted<MachinesSnapshot | null>(STORAGE_KEYS.machines, null),
  );
  const [machinesState, setMachinesState] = useState<MachinesLoadState>({ loading: false, error: null });
  const [pendingNotificationTarget, setPendingNotificationTarget] = useState<NotificationTarget | null>(() =>
    parseNotificationTarget(window.location.href) ??
    loadPersisted<NotificationTarget | null>(STORAGE_KEYS.pendingNotificationTarget, null),
  );
  // Alerts come from the host's agents, so an unhandled one opens the host.
  const [machineId, setMachineId] = useState<string | null>(() =>
    pendingNotificationTarget ? null : loadPersisted<string | null>(STORAGE_KEYS.machineId, null),
  );
  const [machineSheetOpen, setMachineSheetOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo>({ service: null, hermes: null, running: null });

  const activeMachine = machineId ? machines?.machines.find((machine) => machine.id === machineId) ?? null : null;
  const machineName = activeMachine?.name ?? loadPersisted<string | null>(STORAGE_KEYS.machineName, null) ?? "Other machine";
  const localName = machines?.self.name ?? "This host";
  // Only the id picks the machine; name and platform just label it, so the
  // client survives a machines refresh.
  const machineRef = useMemo<MachineRef | null>(
    () => (machineId ? { id: machineId, name: machineName, platform: activeMachine?.platform ?? null, homedir: activeMachine?.homedir ?? null } : null),
    [machineId, machineName, activeMachine?.platform, activeMachine?.homedir],
  );
  const client = useMemo(() => createAthenaClient(config, machineRef), [config, machineRef]);

  // ── Theme: the phone's choice, desktop Athena's theme on the host, or the phone's light/dark setting.
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [laptopTheme, setLaptopTheme] = useState<string | null>(readLaptopTheme);
  const [prefersLight, setPrefersLight] = useState(systemPrefersLight);
  const theme: ThemeId = resolveTheme(themePreference, laptopTheme, prefersLight);
  // A layout effect, so children's effects (the terminal's palette) read the new tokens.
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setPrefersLight(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const changeTheme = (preference: ThemePreference) => {
    setThemePreference(preference);
    writeThemePreference(preference);
  };

  // ── Usage: one poller for the header pill, Settings, and the details sheet.
  const usage = useUsage(laptopClient);
  const [usageOpenKey, setUsageOpenKey] = useState<string | null>(null);
  const usageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openUsage = (accountKey: string, button: HTMLButtonElement) => {
    usageTriggerRef.current = button;
    setUsageOpenKey(accountKey);
  };
  const closeUsage = useCallback(() => {
    setUsageOpenKey(null);
    usageTriggerRef.current?.focus();
  }, []);

  // ── Machines on the tailnet, as the host sees them.
  const machinesInFlight = useRef(false);
  const loadMachines = useCallback(
    async (fresh = false) => {
      if (machinesInFlight.current) return;
      machinesInFlight.current = true;
      setMachinesState((current) => ({ ...current, loading: true }));
      try {
        const next = await fetchMachines(config, fresh);
        setMachines(next);
        setLaptopTheme(next.self.theme);
        writeLaptopTheme(next.self.theme);
        setMachinesState({ loading: false, error: null });
      } catch (machinesError) {
        setMachinesState({ loading: false, error: messageOf(machinesError) });
      } finally {
        machinesInFlight.current = false;
      }
    },
    [config],
  );
  useEffect(() => {
    let interval: number | undefined;
    const start = () => {
      if (interval !== undefined) return;
      void loadMachines();
      interval = window.setInterval(() => void loadMachines(), MACHINES_REFRESH_MS);
    };
    const stop = () => {
      window.clearInterval(interval);
      interval = undefined;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadMachines]);

  const selectMachine = (next: string | null) => {
    const machine = next ? machines?.machines.find((entry) => entry.id === next) : null;
    if (next && machine?.status !== "ready" && next !== machineId) return;
    setMachineSheetOpen(false);
    if (next === machineId) return;
    setMachineId(next);
    persist(STORAGE_KEYS.machineName, machine?.name ?? null);
    setConnection({ service: null, hermes: null, running: null });
    if (tab === "settings") setTab("agents");
  };

  useEffect(() => persist(STORAGE_KEYS.tab, tab), [tab]);
  useEffect(() => persist(STORAGE_KEYS.machines, machines), [machines]);
  useEffect(() => persist(STORAGE_KEYS.machineId, machineId), [machineId]);
  useEffect(() => persist(STORAGE_KEYS.pendingNotificationTarget, pendingNotificationTarget), [pendingNotificationTarget]);

  // Deep-link from a notification: focus the agent it fired for. Covers both the
  // cold open (the SW launched a new window at /?terminal=…&workspace=…) and a
  // warm focus (the SW posts a message to the already-open app). Alerts come
  // from the host's agents, so they always switch back to the host.
  useEffect(() => {
    const focusTerminal = (rawUrl: string) => {
      const target = parseNotificationTarget(rawUrl);
      if (!target) return;
      setMachineId(null);
      setPendingNotificationTarget(target);
      setTab("agents");
    };
    focusTerminal(window.location.href);
    // The target is saved now; leave the URL clean so a later reload doesn't replay the tap.
    clearNotificationQuery();
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "athena-notification-click") focusTerminal(event.data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const controlOnline = Boolean(connection.service?.control.healthy);

  return (
    <div className="appShell">
      <header className="topBar">
        <img className="brandMark" src="/athena-icon-256.png" alt="Athena" width={28} height={28} />
        <MachineButton
          name={machineId ? machineName : localName}
          remote={machineId !== null}
          online={controlOnline}
          onOpen={() => {
            setMachineSheetOpen(true);
            void loadMachines(true);
          }}
        />
        <div className="topActions">
          {config.mode === "demo" && <span className="modeTag">Demo</span>}
          <UsageButton usage={usage} onOpen={openUsage} />
        </div>
      </header>

      <MachineConsole
        key={machineId ?? "laptop"}
        config={config}
        client={client}
        machine={machineRef}
        tab={tab}
        theme={theme}
        notificationTarget={machineId === null ? pendingNotificationTarget : null}
        onNotificationHandled={() => setPendingNotificationTarget(null)}
        onTabChange={setTab}
        onConnection={setConnection}
      />

      {tab === "settings" && (
        <main className="content">
          <SettingsView
            machines={machines}
            machinesState={machinesState}
            activeMachineId={machineId}
            machineName={machineName}
            localName={localName}
            connection={connection}
            themePreference={themePreference}
            theme={theme}
            laptopTheme={laptopTheme}
            usage={usage}
            onSelectMachine={selectMachine}
            onRefreshMachines={() => void loadMachines(true)}
            onThemeChange={changeTheme}
            onOpenUsage={openUsage}
          />
        </main>
      )}

      {machineSheetOpen && (
        <MachineSheet
          snapshot={machines}
          state={machinesState}
          activeId={machineId}
          localName={localName}
          localRunning={machineId === null ? connection.running : null}
          onSelect={selectMachine}
          onRefresh={() => void loadMachines(true)}
          onManage={() => {
            setMachineSheetOpen(false);
            setTab("settings");
          }}
          onClose={() => setMachineSheetOpen(false)}
        />
      )}
      <UsageSheetHost usage={usage} openKey={usageOpenKey} onSelect={setUsageOpenKey} onClose={closeUsage} />

      <nav className="tabBar" aria-label="Sections">
        <TabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={<TerminalSquare size={19} />} label="Agents" badge={connection.running ?? 0} />
        <TabButton active={tab === "launch"} onClick={() => setTab("launch")} icon={<Play size={19} />} label="Launch" />
        <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={<History size={19} />} label="History" />
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={19} />} label="Settings" />
      </nav>
    </div>
  );
}

// Everything about one machine's agents: live terminals, launching, history.
// Keyed by machine in App, so switching machines starts from that machine's
// own saved state instead of carrying selections across.
function MachineConsole({
  config,
  client,
  machine,
  tab,
  theme,
  notificationTarget,
  onNotificationHandled,
  onTabChange: setTab,
  onConnection,
}: {
  config: AppConfig;
  client: AthenaClient;
  machine: MachineRef | null;
  tab: Tab;
  theme: ThemeId;
  notificationTarget: NotificationTarget | null;
  onNotificationHandled: () => void;
  onTabChange: (tab: Tab) => void;
  onConnection: (connection: ConnectionInfo) => void;
}) {
  const machineId = machine?.id ?? null;
  const key = (base: string) => machineStorageKey(base, machineId);
  // Polling outlives renders; always use the newest client (its labels can change).
  const clientRef = useRef(client);
  clientRef.current = client;

  const [agentView, setAgentView] = useState<AgentView>(() => loadPersisted<AgentView>(STORAGE_KEYS.agentView, "chat"));
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(() =>
    loadPersisted<MobileSnapshot | null>(key(STORAGE_KEYS.snapshot), null),
  );
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(() =>
    notificationTarget?.terminalId ?? loadPersisted<string | null>(key(STORAGE_KEYS.selectedTerminalId), null),
  );
  const pendingNotificationTarget = notificationTarget;
  const [launchTask, setLaunchTask] = useState("");
  const [launchKind, setLaunchKind] = useState<EmbeddedTerminalKind>("codex");
  // null until the user picks or types a folder; "" when they cleared the field.
  const [launchWorkspace, setLaunchWorkspace] = useState<string | null>(null);
  // Folders launched from this phone, and project folders from session history
  // in any workspace. Both persist so the picker is full before any fetch.
  const [launchedWorkspaces, setLaunchedWorkspaces] = useState<string[]>(() =>
    loadPersisted<string[]>(key(STORAGE_KEYS.launchedWorkspaces), []),
  );
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() =>
    loadPersisted<string[]>(key(STORAGE_KEYS.recentWorkspaces), []),
  );
  const [recentState, setRecentState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const recentFetchedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptView | null>(null);
  const refreshInFlight = useRef(false);
  // When the newest live terminal list was requested (0: only a saved copy so
  // far), and when the pending notification target arrived. A target is only
  // dropped by a list requested after it arrived.
  const terminalsRequestedAt = useRef(0);
  const targetArrivedAt = useRef(Date.now());
  const refreshQueued = useRef(false);

  const terminals = snapshot?.terminals ?? [];
  const selectedTerminal =
    terminals.find((entry) => entry.id === selectedTerminalId) ??
    (selectedTerminalId && pendingNotificationTarget ? null : terminals[0] ?? null);
  // The configured project folder is a laptop path; another machine starts
  // from its own open folders instead.
  const projectDir = machine ? "" : config.projectDir;
  const primaryWorkspace =
    selectedTerminal?.workspace ||
    pendingNotificationTarget?.workspace ||
    snapshot?.workspaces[0]?.path ||
    projectDir ||
    recentWorkspaces[0] ||
    "";

  // Every workspace the user can spawn into: live terminals' workspaces first,
  // then folders launched from here, the configured project dir, and recent
  // projects from session history, de-duplicated in that order.
  const workspaceOptions = useMemo(() => {
    const paths = new Set<string>();
    for (const terminal of terminals) paths.add(terminal.workspace);
    for (const path of launchedWorkspaces) paths.add(path);
    if (projectDir) paths.add(projectDir);
    for (const workspace of snapshot?.workspaces ?? []) paths.add(workspace.path);
    for (const path of recentWorkspaces) paths.add(path);
    return Array.from(paths).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, terminals, launchedWorkspaces, recentWorkspaces, projectDir]);
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
    const requestedAt = Date.now();
    try {
      const next = await clientRef.current.snapshot(primaryWorkspaceRef.current || undefined);
      if (!next.errors?.terminals) terminalsRequestedAt.current = requestedAt;
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

  // A notification tapped while the app was open: follow it to its workspace.
  useEffect(() => {
    if (!notificationTarget) return;
    // The list on screen may predate the agent the alert is about.
    targetArrivedAt.current = Date.now();
    if (notificationTarget.workspace) {
      primaryWorkspaceRef.current = notificationTarget.workspace;
      setLaunchWorkspace(notificationTarget.workspace);
    }
    setSelectedTerminalId(notificationTarget.terminalId);
    if (notificationTarget.view) setAgentView(notificationTarget.view);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationTarget]);

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
  useEffect(() => persist(key(STORAGE_KEYS.launchedWorkspaces), launchedWorkspaces), [launchedWorkspaces]);
  useEffect(() => persist(key(STORAGE_KEYS.recentWorkspaces), recentWorkspaces), [recentWorkspaces]);

  // Load recent projects when Launch opens, or History on another machine,
  // which has no configured folder to fall back on. The request is not
  // cancelled on cleanup: the result is still worth keeping if the user has moved on.
  useEffect(() => {
    const wanted = tab === "launch" || (tab === "history" && machine !== null);
    if (!wanted || Date.now() - recentFetchedAt.current < RECENT_WORKSPACES_REFRESH_MS) return;
    recentFetchedAt.current = Date.now();
    setRecentState({ loading: true, error: null });
    client
      .recentWorkspaces()
      .then((paths) => {
        setRecentWorkspaces(paths);
        setRecentState({ loading: false, error: null });
        // History lists the primary folder's sessions; fetch them now it has one.
        if (!primaryWorkspaceRef.current && paths[0]) {
          primaryWorkspaceRef.current = paths[0];
          void refresh();
        }
      })
      .catch((recentError) => {
        // Retry on the next visit rather than waiting out the refresh interval.
        recentFetchedAt.current = 0;
        setRecentState({ loading: false, error: messageOf(recentError) });
      });
  }, [tab, client, machine]);
  useEffect(() => persist(STORAGE_KEYS.agentView, agentView), [agentView]);
  useEffect(() => persist(key(STORAGE_KEYS.snapshot), snapshot), [snapshot]);
  useEffect(() => persist(key(STORAGE_KEYS.selectedTerminalId), selectedTerminalId), [selectedTerminalId]);

  // Header dot, tab badge, and Settings → Connection read this machine's state.
  useEffect(() => {
    onConnection({
      service: snapshot?.service ?? null,
      hermes: snapshot?.hermes ?? null,
      running: snapshot ? snapshot.terminals.filter((terminal) => terminal.status === "running").length : null,
    });
  }, [snapshot, onConnection]);

  // Apply a notification route only after the live terminal snapshot confirms
  // the target still exists. Until then, keep the target persisted so a cold
  // launch or mobile restore cannot drop the tap and fall back to another
  // agent. A fresh list without it means the agent is gone: drop the target.
  useEffect(() => {
    if (!pendingNotificationTarget || !snapshot) return;
    const target = terminals.find(
      (terminal) =>
        terminal.id === pendingNotificationTarget.terminalId &&
        (!pendingNotificationTarget.workspace || terminal.workspace === pendingNotificationTarget.workspace),
    );
    if (!target) {
      if (terminalsRequestedAt.current > targetArrivedAt.current && !snapshot.errors?.terminals) {
        setSelectedTerminalId(null);
        onNotificationHandled();
      }
      return;
    }
    setSelectedTerminalId(target.id);
    setLaunchWorkspace(target.workspace);
    setTab("agents");
    onNotificationHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNotificationTarget, snapshot, terminals]);

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
    const workspace = normalizeFolderInput(launchWorkspaceResolved);
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

  const banner = error ?? loadErrorMessage(snapshot);
  const machineName = machine?.name ?? null;

  // Settings belongs to App; keep this machine's state (and its polling) alive underneath.
  if (tab === "settings") return null;

  return (
    <>
      {banner && <div className="errorBanner">{banner}</div>}

      <main className="content">
        {tab === "agents" && (
          <AgentsView
            client={client}
            machineName={machineName}
            terminals={terminals}
            selected={selectedTerminal}
            streamUrl={selectedTerminal ? client.terminalStreamUrl(selectedTerminal.id) : null}
            view={agentView}
            theme={theme}
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
            machine={machine}
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
            machineName={machineName}
            workspace={primaryWorkspace}
            sessions={snapshot?.recentSessions ?? []}
            transcripts={client.historyTranscripts}
            busy={busy}
            onResume={resumeSession}
            onViewTranscript={openTranscript}
          />
        )}
      </main>

      {transcript && <TranscriptSheet view={transcript} onClose={() => setTranscript(null)} />}
    </>
  );
}

function AgentsView({
  client,
  machineName,
  terminals,
  selected,
  streamUrl,
  view,
  theme,
  busy,
  onSelect,
  onViewChange,
  onRaw,
  onSend,
  onStop,
  onGoLaunch,
}: {
  client: AthenaClient;
  /** Set when the agents run on another machine. */
  machineName: string | null;
  terminals: EmbeddedTerminalSession[];
  selected: EmbeddedTerminalSession | null;
  streamUrl: string | null;
  view: AgentView;
  theme: ThemeId;
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
        <strong>No live agents{machineName ? ` on ${machineName}` : ""}</strong>
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
  const hasConversation = selected !== null && selected.kind !== "shell" && Boolean(selected.providerSessionId);
  const showChat = view === "chat" && hasConversation;
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
                <small>{labelForKind(terminal.kind)}</small>
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
              <small>{labelForKind(selected.kind)} · {selected.status === "running" ? "running" : selected.status}{selected.pid ? ` · pid ${selected.pid}` : ""}</small>
            </div>
            <div className="terminalCardActions">
              {hasConversation && (
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

          {showChat ? (
            <ConversationView key={selected.id} client={client} terminal={selected} onSend={onSend} />
          ) : (
            <MobileTerminal key={selected.id} sessionId={selected.id} streamUrl={streamUrl} onInput={onRaw} theme={theme} />
          )}

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
  machine,
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
  machine: MachineRef | null;
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
  const recentLabel = machine ? "folders open in Athena there" : "recent projects";
  return (
    <section className="panel">
      <header className="panelHead">
        <span className="eyebrow">{machine ? `New terminal on ${machine.name}` : "New terminal"}</span>
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
        {/* Any folder on that machine; picking a project below fills it in. */}
        <input
          className="pathInput"
          value={selectedWorkspace}
          onChange={(event) => onWorkspaceChange(event.target.value)}
          placeholder={folderPlaceholder(machine)}
          aria-label="Workspace folder"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        {recentState.loading ? (
          <p className="emptyText">Loading {recentLabel}…</p>
        ) : recentState.error ? (
          <p className="emptyText">Couldn't load {recentLabel} ({recentState.error}).</p>
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
        <Plus size={17} /> Launch {labelForKind(kind)}{machine ? ` on ${machine.name}` : ""}
      </button>
    </section>
  );
}

function HistoryView({
  machineName,
  workspace,
  sessions,
  transcripts,
  busy,
  onResume,
  onViewTranscript,
}: {
  machineName: string | null;
  /** The folder whose sessions are listed: the selected agent's. */
  workspace: string;
  sessions: AgentSession[];
  /** Past transcripts can be opened here (the host's only, for now). */
  transcripts: boolean;
  busy: boolean;
  onResume: (session: AgentSession) => void;
  onViewTranscript: (session: AgentSession) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="emptyState">
        <History size={28} />
        <strong>No recent sessions{workspace ? ` in ${workspaceName(workspace)}` : ""}</strong>
        <span>Native Codex, Claude, OpenCode, Athena Code, Grok, and Hermes sessions for this workspace{machineName ? ` on ${machineName}` : ""} appear here.</span>
      </div>
    );
  }

  return (
    <section className="panel">
      <header className="panelHead">
        <span className="eyebrow">Native history{machineName ? ` · ${machineName}` : ""}</span>
        <h1>{workspace ? workspaceName(workspace) : "Sessions"}</h1>
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
              {transcripts && (
                <button className="ghostButton" type="button" onClick={() => onViewTranscript(session)}>
                  <FileText size={15} /> Transcript
                </button>
              )}
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

// Names the desktop app uses where plain capitalization would be wrong.
const KIND_LABELS: Record<string, string> = { athena: "Athena Code", opencode: "OpenCode" };

function labelForKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function workspaceName(path: string): string {
  return pathBaseName(path);
}

function folderPlaceholder(machine: MachineRef | null): string {
  if (!machine) return "/home/alan/home_ai/projects/…";
  if (isWindowsMachine(machine)) return `${machine.homedir ?? "C:\\Users\\you"}\\…`;
  return `${machine.homedir ?? "~"}/…`;
}

// "workspaces" was the Spaces tab, folded into Settings.
function parseTab(value: string): Tab {
  if (value === "agents" || value === "launch" || value === "history" || value === "settings") return value;
  return value === "workspaces" ? "settings" : "agents";
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

function clearNotificationQuery(): void {
  const url = new URL(window.location.href);
  if (!["terminal", "workspace", "view"].some((key) => url.searchParams.has(key))) return;
  for (const key of ["terminal", "workspace", "view"]) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
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
  machines: "athena.machines",
  machineId: "athena.machineId",
  machineName: "athena.machineName",
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
