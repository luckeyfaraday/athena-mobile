import { useEffect, useState, type ReactNode } from "react";
import { Bell, BellOff, BellRing, Check, RefreshCw } from "lucide-react";
import { enablePush, pushState, sendTestPush, type PushState } from "../push/notifications";
import { isThemeId, themeDefinition, themes, type ThemeId, type ThemePreference } from "../themes";
import type { HermesStatus, MachinesSnapshot, ServiceState } from "../types";
import { MachineList, MachinesNote, type MachinesLoadState } from "./Machines";
import { UsageList, type UsageState } from "./Usage";

export type ConnectionInfo = {
  service: ServiceState | null;
  hermes: HermesStatus | null;
  running: number | null;
};

// Settings, grouped the way desktop Athena's Settings room groups them.
export function SettingsView({
  machines,
  machinesState,
  activeMachineId,
  machineName,
  localName,
  connection,
  themePreference,
  theme,
  laptopTheme,
  usage,
  onSelectMachine,
  onRefreshMachines,
  onThemeChange,
  onOpenUsage,
}: {
  machines: MachinesSnapshot | null;
  machinesState: MachinesLoadState;
  activeMachineId: string | null;
  machineName: string;
  localName: string;
  connection: ConnectionInfo;
  themePreference: ThemePreference;
  theme: ThemeId;
  laptopTheme: string | null;
  usage: UsageState;
  onSelectMachine: (machineId: string | null) => void;
  onRefreshMachines: () => void;
  onThemeChange: (preference: ThemePreference) => void;
  onOpenUsage: (accountKey: string, button: HTMLButtonElement) => void;
}) {
  const laptopLabel = isThemeId(laptopTheme) ? themeDefinition(laptopTheme).label : null;
  return (
    <section className="panel settingsView">
      <header className="panelHead">
        <span className="eyebrow">Athena Mobile</span>
        <h1>Settings</h1>
      </header>

      <SettingsGroup
        title="Machines"
        note={
          <button type="button" className="textButton" onClick={onRefreshMachines} disabled={machinesState.loading}>
            <RefreshCw size={12} className={machinesState.loading ? "spinning" : undefined} /> Check again
          </button>
        }
      >
        <MachineList
          snapshot={machines}
          activeId={activeMachineId}
          localName={localName}
          localRunning={activeMachineId === null ? connection.running : null}
          includeAll
          onSelect={onSelectMachine}
        />
        <MachinesNote snapshot={machines} state={machinesState} />
        <p className="settingsFootnote">
          The laptop reaches each machine over Tailscale. Turn on remote access in Athena there (Settings → System). A
          machine on another Tailscale account also needs its access token, added in Athena on this laptop.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Appearance" note={<span>{themeDefinition(theme).label}</span>}>
        <div className="themeGallery" role="radiogroup" aria-label="Theme">
          <ThemeCard
            id="laptop"
            label="Match laptop"
            description={laptopLabel ? `Follows Athena on the laptop, now ${laptopLabel}.` : "Follows Athena's theme on the laptop."}
            preview={isThemeId(laptopTheme) ? laptopTheme : theme}
            selected={themePreference === "laptop"}
            onSelect={onThemeChange}
          />
          <ThemeCard
            id="system"
            label="Match phone"
            description="Classic in dark mode, Daylight in light mode."
            preview={["classic", "daylight"]}
            selected={themePreference === "system"}
            onSelect={onThemeChange}
          />
          {themes.map((definition) => (
            <ThemeCard
              key={definition.id}
              id={definition.id}
              label={definition.label}
              description={definition.description}
              preview={definition.id}
              selected={themePreference === definition.id}
              onSelect={onThemeChange}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Subscription usage" note={<span>On the laptop</span>}>
        <UsageList usage={usage} onOpen={onOpenUsage} />
      </SettingsGroup>

      <SettingsGroup title="Notifications">
        <NotificationsRow />
      </SettingsGroup>

      <SettingsGroup title="Connection">
        <div className="settingsCard">
          <SettingsRow
            label={activeMachineId ? `${machineName} control` : "Control"}
            detail={connection.service?.control.healthy ? "Terminals, streams, and launches" : connection.service?.control.detail ?? "Not checked"}
            value={<Health ok={Boolean(connection.service?.control.healthy)} />}
          />
          <SettingsRow
            label="Laptop backend"
            detail={connection.service?.backend.healthy ? "Usage and the laptop's session history" : connection.service?.backend.detail ?? "Not checked"}
            value={<Health ok={Boolean(connection.service?.backend.healthy)} />}
          />
          {activeMachineId === null && (
            <SettingsRow
              label="Hermes"
              detail={connection.hermes?.version ?? connection.hermes?.message ?? "Not loaded"}
              value={<Health ok={Boolean(connection.hermes?.installed)} label={connection.hermes?.installed ? "Ready" : "Unknown"} />}
            />
          )}
          <SettingsRow
            label="Mode"
            detail={connection.service?.mode === "demo" ? "Sample data; nothing reaches Athena" : "Connected to Athena through this laptop"}
            value={<span className="settingsValue">{connection.service?.mode === "demo" ? "Demo" : "Live"}</span>}
          />
        </div>
      </SettingsGroup>
    </section>
  );
}

function SettingsGroup({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="settingsGroup">
      <div className="settingsGroupHead">
        <h2>{title}</h2>
        {note && <div className="settingsGroupNote">{note}</div>}
      </div>
      {children}
    </section>
  );
}

function SettingsRow({ label, detail, value }: { label: string; detail: string; value: ReactNode }) {
  return (
    <div className="settingsRow">
      <div className="settingsRowLabel">
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      {value}
    </div>
  );
}

function Health({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={ok ? "healthBadge ok" : "healthBadge"}>
      <i aria-hidden="true" />
      {label ?? (ok ? "Healthy" : "Offline")}
    </span>
  );
}

// A small rendering of the app in a theme. Tokens are declared on every
// [data-theme] element, so the preview paints in its own palette.
function ThemeCard({
  id,
  label,
  description,
  preview,
  selected,
  onSelect,
}: {
  id: ThemePreference;
  label: string;
  description: string;
  preview: ThemeId | [ThemeId, ThemeId];
  selected: boolean;
  onSelect: (preference: ThemePreference) => void;
}) {
  const previews = Array.isArray(preview) ? preview : [preview];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? "themeCard selected" : "themeCard"}
      onClick={() => onSelect(id)}
    >
      <span className={previews.length > 1 ? "themeCardPreview split" : "themeCardPreview"} aria-hidden="true">
        {previews.map((themeId) => (
          <span key={themeId} className="themePreview" data-theme={themeId}>
            <span className="themePreviewBar">
              <i />
              <b />
            </span>
            <span className="themePreviewCard">
              <span className="themePreviewLine" />
              <span className="themePreviewLine short" />
              <span className="themePreviewDots">
                <i className="codex" />
                <i className="claude" />
                <i className="opencode" />
              </span>
            </span>
            <span className="themePreviewButton" />
          </span>
        ))}
        {selected && (
          <span className="themeCardCheck">
            <Check size={12} />
          </span>
        )}
      </span>
      <span className="themeCardCaption">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

// Agent-attention push for this phone: enroll when off, send a test when on.
// Explains itself where push can't work (an insecure origin, or no Push API).
function NotificationsRow() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

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
  const blocked = state === "denied" || state === "insecure" || state === "unsupported";
  const detail = ready
    ? "On. You're alerted when an agent on the laptop waits for you, finishes, or crashes."
    : state === "default"
      ? "Get alerted when an agent on the laptop waits for you, finishes, or crashes."
      : state === "insecure"
        ? "Open the app over HTTPS (tailscale serve) to turn notifications on."
        : state === "denied"
          ? "Blocked. Allow notifications for this app in the browser's settings."
          : state === "unsupported"
            ? "This browser doesn't support Web Push."
            : "Checking…";

  const onClick = async () => {
    if (pending || state === "loading" || blocked) return;
    setPending(true);
    setResult(null);
    try {
      if (ready) {
        await sendTestPush();
        setResult("Test notification sent.");
      } else {
        const enabled = await enablePush();
        setState(enabled.state);
        if (!enabled.ok && enabled.error) setResult(enabled.error);
      }
    } catch (pushError) {
      setResult(pushError instanceof Error ? pushError.message : String(pushError));
      void pushState().then(setState).catch(() => {});
    } finally {
      setPending(false);
    }
  };

  const Icon = ready ? BellRing : blocked ? BellOff : Bell;
  return (
    <div className="settingsCard">
      <div className="settingsRow">
        <div className="settingsRowLabel">
          <strong>Agent alerts</strong>
          <small>{detail}</small>
          {result && <small className="settingsResult">{result}</small>}
        </div>
        <button
          type="button"
          className={ready ? "ghostButton" : "primaryButton small"}
          onClick={() => void onClick()}
          disabled={pending || state === "loading" || blocked}
        >
          <Icon size={14} /> {ready ? "Send test" : "Turn on"}
        </button>
      </div>
    </div>
  );
}
