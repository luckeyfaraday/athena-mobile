import { useEffect, useRef, type ReactNode } from "react";
import { Check, ChevronDown, KeyRound, Laptop, Monitor, RefreshCw, Settings2, X } from "lucide-react";
import { machineStateLabel, switcherMachines } from "../machines";
import type { MachinesSnapshot, RemoteMachine } from "../types";

// Picks whose agents the app shows: the laptop serving it, or another machine
// on the tailnet running Athena with remote access on. Mirrors desktop
// Athena's machine switcher (client/src/components/MachineSwitcher.tsx).

export type MachinesLoadState = { loading: boolean; error: string | null };

/** Header button naming the machine in view. */
export function MachineButton({
  name,
  remote,
  online,
  onOpen,
}: {
  name: string;
  remote: boolean;
  /** Its control API answered on the last refresh. */
  online: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={remote ? "machineButton remote" : "machineButton"}
      aria-haspopup="dialog"
      aria-label={`Viewing ${name}${online ? "" : ", not answering"}. Switch machine`}
      onClick={onOpen}
    >
      {remote ? <Monitor size={14} aria-hidden="true" /> : <Laptop size={14} aria-hidden="true" />}
      <span className="machineButtonName">{name}</span>
      <i className={online ? "machineButtonDot online" : "machineButtonDot"} aria-hidden="true" />
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}

/**
 * The laptop first, then other machines. The switcher lists only machines you
 * can open (or that just need a token); Settings passes `includeAll` to list
 * offline and Athena-less ones too, with why.
 */
export function MachineList({
  snapshot,
  activeId,
  localName,
  localRunning,
  includeAll,
  onSelect,
}: {
  snapshot: MachinesSnapshot | null;
  activeId: string | null;
  localName: string;
  localRunning: number | null;
  includeAll: boolean;
  onSelect: (machineId: string | null) => void;
}) {
  const machines = includeAll ? snapshot?.machines ?? [] : switcherMachines(snapshot, activeId);
  return (
    <div className="machineList" role="radiogroup" aria-label="Machines">
      <MachineRow
        name={localName}
        detail={localRunning ? `This laptop · ${localRunning} running` : "This laptop"}
        icon={<Laptop size={16} />}
        active={activeId === null}
        available
        onClick={() => onSelect(null)}
      />
      {machines.map((machine) => (
        <MachineRow
          key={machine.id}
          name={machine.name}
          detail={machineDetail(machine)}
          note={machine.status === "ready" || machine.status === "offline" ? null : machine.detail}
          icon={machine.status === "needs-token" ? <KeyRound size={16} /> : <Monitor size={16} />}
          active={machine.id === activeId}
          available={machine.status === "ready"}
          onClick={() => onSelect(machine.id)}
        />
      ))}
    </div>
  );
}

function machineDetail(machine: RemoteMachine): string {
  const os = machine.platform === "win32" || machine.os === "windows" ? "Windows" : machine.os === "macos" || machine.platform === "darwin" ? "macOS" : machine.os === "linux" ? "Linux" : null;
  return [os, machineStateLabel(machine)].filter(Boolean).join(" · ");
}

function MachineRow({
  name,
  detail,
  note,
  icon,
  active,
  available,
  onClick,
}: {
  name: string;
  detail: string;
  note?: string | null;
  icon: ReactNode;
  active: boolean;
  available: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={["machineRow", active ? "active" : "", available ? "" : "unavailable"].filter(Boolean).join(" ")}
      disabled={!available && !active}
      onClick={onClick}
    >
      <span className="machineRowIcon" aria-hidden="true">{icon}</span>
      <span className="machineRowText">
        <strong>{name}</strong>
        <small>{detail}</small>
        {note && <em>{note}</em>}
      </span>
      <span className="machineRowCheck" aria-hidden="true">{active && <Check size={16} />}</span>
    </button>
  );
}

export function MachineSheet({
  snapshot,
  state,
  activeId,
  localName,
  localRunning,
  onSelect,
  onRefresh,
  onManage,
  onClose,
}: {
  snapshot: MachinesSnapshot | null;
  state: MachinesLoadState;
  activeId: string | null;
  localName: string;
  localRunning: number | null;
  onSelect: (machineId: string | null) => void;
  onRefresh: () => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);
  const hidden = (snapshot?.machines.length ?? 0) - switcherMachines(snapshot, activeId).length;

  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div
        className="sheet machineSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-sheet-title"
        tabIndex={-1}
        ref={sheetRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheetHead">
          <div>
            <strong id="machine-sheet-title">Machines</strong>
            <small>{snapshot?.account ? `Tailscale · ${snapshot.account}` : "Over Tailscale, through this laptop"}</small>
          </div>
          <div className="sheetHeadActions">
            <button className="iconButton" type="button" onClick={onRefresh} disabled={state.loading} aria-label="Check machines again">
              <RefreshCw size={16} className={state.loading ? "spinning" : undefined} />
            </button>
            <button className="iconButton" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="sheetBody">
          <MachineList
            snapshot={snapshot}
            activeId={activeId}
            localName={localName}
            localRunning={localRunning}
            includeAll={false}
            onSelect={onSelect}
          />
          <MachinesNote snapshot={snapshot} state={state} hidden={hidden} />
          <button type="button" className="ghostButton wide" onClick={onManage}>
            <Settings2 size={14} /> All machines and settings
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why the list looks the way it does: Tailscale down, a failed check, or machines left out. */
export function MachinesNote({ snapshot, state, hidden = 0 }: { snapshot: MachinesSnapshot | null; state: MachinesLoadState; hidden?: number }) {
  if (state.error) return <p className="machinesNote error">Couldn't check machines: {state.error}</p>;
  if (!snapshot) return <p className="machinesNote">{state.loading ? "Looking for machines…" : "Machines haven't been checked yet."}</p>;
  if (snapshot.tailscale === "unavailable") {
    return <p className="machinesNote">Tailscale isn't available on the laptop, so other machines can't be reached.</p>;
  }
  if (snapshot.tailscale === "stopped") return <p className="machinesNote">Tailscale is stopped on the laptop.</p>;
  if (snapshot.machines.length === 0) {
    return <p className="machinesNote">No other computers on your tailnet. Install Athena on one and turn on remote access in its Settings → System.</p>;
  }
  if (hidden > 0) {
    return <p className="machinesNote">{hidden === 1 ? "1 more machine is" : `${hidden} more machines are`} offline or not running Athena.</p>;
  }
  return null;
}
