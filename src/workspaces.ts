// Recent project folders for the Launch picker, derived from native sessions
// across every workspace (the backend's /agents/sessions/all).

import type { AgentSession } from "./types";

const RECENT_PROJECT_LIMIT = 15;
// Batch jobs start one agent per folder (…/nightmares-r4/wraith_*, ten folders
// within three minutes). That many siblings used that close together are one
// job, listed once as their parent folder.
const BATCH_MIN_FOLDERS = 3;
const BATCH_WINDOW_MS = 15 * 60_000;

/**
 * Distinct session workspaces, most recently used first. Agents often run in
 * a project's subfolders (a bench run's `jev/minecraft_portal_search/legacy`),
 * so a folder folds into its nearest listed ancestor when that ancestor is a
 * single project. An ancestor whose listed descendants span several of its
 * children, like a home directory someone once ran an agent in, holds
 * unrelated projects and never absorbs them.
 */
export function recentProjectPaths(
  sessions: Pick<AgentSession, "workspace" | "updated_at">[],
  limit = RECENT_PROJECT_LIMIT,
): string[] {
  const lastUsed = new Map<string, number>();
  for (const session of sessions) {
    const path = session.workspace?.replace(/\/+$/, "");
    const at = Date.parse(session.updated_at);
    if (!path || Number.isNaN(at)) continue;
    lastUsed.set(path, Math.max(lastUsed.get(path) ?? at, at));
  }

  const paths = Array.from(lastUsed.keys());
  const projects = new Map<string, number>();
  for (const path of paths) {
    const project = projectFor(path, paths);
    projects.set(project, Math.max(projects.get(project) ?? 0, lastUsed.get(path) ?? 0));
  }
  foldBatches(projects);
  return Array.from(projects.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path]) => path);
}

function foldBatches(projects: Map<string, number>): void {
  const byParent = new Map<string, string[]>();
  for (const path of projects.keys()) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && !projects.has(parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), path]);
  }
  for (const [parent, children] of byParent) {
    const times = children.map((child) => projects.get(child) ?? 0);
    if (children.length < BATCH_MIN_FOLDERS || Math.max(...times) - Math.min(...times) > BATCH_WINDOW_MS) continue;
    for (const child of children) projects.delete(child);
    projects.set(parent, Math.max(...times));
  }
}

function projectFor(path: string, paths: string[]): string {
  const nearest = paths
    .filter((other) => path.startsWith(`${other}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!nearest) return path;
  const children = new Set(
    paths.filter((other) => other.startsWith(`${nearest}/`)).map((other) => other.slice(nearest.length + 1).split("/")[0]),
  );
  return children.size === 1 ? nearest : path;
}
