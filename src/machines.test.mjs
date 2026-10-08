import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  fromRemoteSession,
  isWindowsMachine,
  machineStateLabel,
  machineStorageKey,
  normalizeFolderInput,
  pathBaseName,
  switcherMachines,
} from "./machines.ts";
import { parseThemePreference, resolveTheme, themeIds } from "./themes.ts";

const machine = (overrides) => ({
  id: "m",
  name: "m",
  os: "linux",
  online: true,
  ownDevice: true,
  status: "ready",
  detail: null,
  version: null,
  platform: null,
  homedir: null,
  ...overrides,
});

test("pathBaseName handles POSIX and Windows paths", () => {
  assert.equal(pathBaseName("/home/ada/projects/jev/"), "jev");
  assert.equal(pathBaseName("C:\\Users\\ada\\game-port"), "game-port");
  assert.equal(pathBaseName("/"), "/");
});

test("normalizeFolderInput drops trailing separators but keeps a root", () => {
  assert.equal(normalizeFolderInput(" /home/ada/jev/ "), "/home/ada/jev");
  assert.equal(normalizeFolderInput("C:\\Users\\ada\\"), "C:\\Users\\ada");
  assert.equal(normalizeFolderInput("/"), "/");
  assert.equal(normalizeFolderInput("C:\\"), "C:\\");
  assert.equal(normalizeFolderInput("c:"), "c:\\");
});

test("switcherMachines offers usable machines and keeps the one in view", () => {
  const snapshot = {
    machines: [
      machine({ id: "ready" }),
      machine({ id: "token", status: "needs-token" }),
      machine({ id: "offline", status: "offline" }),
      machine({ id: "gone", status: "no-athena" }),
    ],
  };
  assert.deepEqual(switcherMachines(snapshot, null).map((entry) => entry.id), ["ready", "token"]);
  assert.deepEqual(switcherMachines(snapshot, "gone").map((entry) => entry.id), ["ready", "token", "gone"]);
  assert.deepEqual(switcherMachines(null, null), []);
});

test("machineStateLabel names each status", () => {
  assert.equal(machineStateLabel(machine({ version: "0.4.1" })), "Athena 0.4.1");
  assert.equal(machineStateLabel(machine({})), "Ready");
  assert.equal(machineStateLabel(machine({ status: "needs-token" })), "Needs access token");
  assert.equal(machineStateLabel(machine({ status: "offline" })), "Offline");
});

test("isWindowsMachine reads the remote's platform", () => {
  assert.equal(isWindowsMachine({ platform: "win32" }), true);
  assert.equal(isWindowsMachine({ platform: "linux" }), false);
  assert.equal(isWindowsMachine(null), false);
});

test("fromRemoteSession converts the control server's camelCase rows", () => {
  const session = fromRemoteSession({
    id: "s1",
    provider: "codex",
    title: "Port",
    workspace: "C:\\Users\\ada\\jev",
    branch: null,
    model: "gpt-5",
    agent: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    status: "historical",
    terminalId: null,
    pid: null,
    resumeCommand: "codex resume s1",
    metadata: {},
  });
  assert.equal(session.created_at, "2026-10-01T00:00:00Z");
  assert.equal(session.updated_at, "2026-10-02T00:00:00Z");
  assert.equal(session.resume_command, "codex resume s1");
  assert.equal(session.terminal_id, null);
});

test("per-machine storage keeps the laptop's original keys", () => {
  assert.equal(machineStorageKey("athena.snapshot", null), "athena.snapshot");
  assert.equal(machineStorageKey("athena.snapshot", "node1"), "athena.snapshot@node1");
});

test("themes resolve from the phone's choice, the laptop's theme, or the system", () => {
  assert.equal(resolveTheme("laptop", "fjord", false), "fjord");
  assert.equal(resolveTheme("laptop", "system", true), "daylight");
  // Desktop Athena paints Classic until a theme is saved.
  assert.equal(resolveTheme("laptop", null, true), "classic");
  assert.equal(resolveTheme("system", "fjord", true), "daylight");
  assert.equal(resolveTheme("ember", "fjord", true), "ember");
  assert.equal(parseThemePreference("nope"), null);
  assert.equal(parseThemePreference("laptop"), "laptop");
});

test("every theme id has a token block in the copied desktop stylesheet", () => {
  const css = fs.readFileSync(new URL("./styles/themes.css", import.meta.url), "utf8");
  const blocks = new Set([...css.matchAll(/\[data-theme="([a-z-]+)"\]\s*\{/g)].map((match) => match[1]));
  // Classic is the default palette in tokens.css.
  assert.deepEqual(themeIds.filter((id) => id !== "classic" && !blocks.has(id)), []);
  assert.deepEqual([...blocks].filter((id) => !themeIds.includes(id)), []);
});
