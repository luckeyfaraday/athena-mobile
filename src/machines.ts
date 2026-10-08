// Pure helpers for choosing and talking to another machine. No runtime
// imports, so node --test can load this file directly.

import type { AgentSession, MachinesSnapshot, RemoteAgentSession, RemoteMachine } from "./types";

/** Short state shown under a machine's name. */
export function machineStateLabel(machine: RemoteMachine): string {
  switch (machine.status) {
    case "ready":
      return machine.version ? `Athena ${machine.version}` : "Ready";
    case "needs-token":
      return "Needs access token";
    case "refused":
      return "Refused this laptop";
    case "no-athena":
      return "Athena not answering";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
}

/**
 * Machines worth offering in the switcher: ready ones, ones that only need a
 * token (so it can say so), and the one being viewed even if it went away.
 * Offline and Athena-less machines are listed in Settings only.
 */
export function switcherMachines(snapshot: MachinesSnapshot | null, activeId: string | null): RemoteMachine[] {
  return (snapshot?.machines ?? []).filter(
    (machine) => machine.status === "ready" || machine.status === "needs-token" || machine.id === activeId,
  );
}

export function isWindowsMachine(machine: { platform: string | null } | null): boolean {
  return machine?.platform === "win32";
}

/** Last folder name of a POSIX or Windows path. */
export function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

/** A typed folder with trailing separators dropped, keeping a bare root ("/" or "C:\"). */
export function normalizeFolderInput(path: string): string {
  const trimmed = path.trim();
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  return trimmed.replace(/(.)[\\/]+$/, "$1");
}

/** A remote control server's session row in the backend's snake_case shape the views use. */
export function fromRemoteSession(session: RemoteAgentSession): AgentSession {
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    workspace: session.workspace,
    branch: session.branch,
    model: session.model,
    agent: session.agent,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    status: session.status,
    terminal_id: session.terminalId,
    pid: session.pid,
    resume_command: session.resumeCommand,
    metadata: session.metadata ?? {},
  };
}

/** Storage key for per-machine state; the laptop keeps the keys older builds used. */
export function machineStorageKey(base: string, machineId: string | null): string {
  return machineId ? `${base}@${machineId}` : base;
}
