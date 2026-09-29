import assert from "node:assert/strict";
import test from "node:test";
import { recentProjectPaths } from "./workspaces.ts";

const P = "/home/alan/home_ai/projects";
const session = (workspace, updated_at) => ({ workspace, updated_at });

test("lists distinct workspaces, most recently used first", () => {
  const paths = recentProjectPaths([
    session(`${P}/a`, "2026-09-01T10:00:00Z"),
    session(`${P}/b`, "2026-09-03T10:00:00Z"),
    session(`${P}/a/`, "2026-09-02T10:00:00.123456Z"),
  ]);
  assert.deepEqual(paths, [`${P}/b`, `${P}/a`]);
});

test("folds a project's subfolders into the project", () => {
  const paths = recentProjectPaths([
    session(`${P}/bench/jev`, "2026-09-01T10:00:00Z"),
    session(`${P}/bench/jev/search/legacy`, "2026-09-05T10:00:00Z"),
    session(`${P}/bench/jev/search/vendor/cubiomes`, "2026-09-04T10:00:00Z"),
    session(`${P}/other`, "2026-09-03T10:00:00Z"),
  ]);
  // jev takes its newest subfolder's time, so it sorts first.
  assert.deepEqual(paths, [`${P}/bench/jev`, `${P}/other`]);
});

test("never folds unrelated projects into a shared parent such as home", () => {
  const paths = recentProjectPaths([
    session("/home/alan", "2026-09-01T10:00:00Z"),
    session("/home/alan/lucid-images/share", "2026-09-02T10:00:00Z"),
    session(`${P}/x-posting`, "2026-09-03T10:00:00Z"),
  ]);
  assert.deepEqual(paths, [`${P}/x-posting`, "/home/alan/lucid-images/share", "/home/alan"]);
});

test("lists a batch of sibling folders used within minutes as their parent", () => {
  const paths = recentProjectPaths([
    session("/home/alan/lucid/r4/wraith_a", "2026-09-26T00:20:00Z"),
    session("/home/alan/lucid/r4/wraith_b", "2026-09-26T00:21:00Z"),
    session("/home/alan/lucid/r4/smoke_c", "2026-09-26T00:22:00Z"),
    // Projects share a parent too, but were used on different days.
    session(`${P}/a`, "2026-09-20T10:00:00Z"),
    session(`${P}/b`, "2026-09-24T10:00:00Z"),
    session(`${P}/c`, "2026-09-28T10:00:00Z"),
  ]);
  assert.deepEqual(paths, [`${P}/c`, "/home/alan/lucid/r4", `${P}/b`, `${P}/a`]);
});

test("skips sessions without a workspace or a valid time, and applies the limit", () => {
  const paths = recentProjectPaths(
    [
      session("", "2026-09-01T10:00:00Z"),
      session(`${P}/bad-time`, "not a date"),
      session(`${P}/a`, "2026-09-01T10:00:00Z"),
      session(`${P}/b`, "2026-09-02T10:00:00Z"),
      session(`${P}/c`, "2026-09-03T10:00:00Z"),
    ],
    2,
  );
  assert.deepEqual(paths, [`${P}/c`, `${P}/b`]);
});
