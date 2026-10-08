import assert from "node:assert/strict";
import test from "node:test";
import { discoveryDir } from "./discovery.mjs";

test("discovery defaults to desktop Athena's folder and follows a headless server's data folder", () => {
  assert.equal(discoveryDir({}, "/home/ada"), "/home/ada/.context-workspace");
  assert.equal(discoveryDir({ ATHENA_SERVER_DATA_DIR: "/srv/athena" }, "/home/ada"), "/srv/athena");
  assert.equal(discoveryDir({ ATHENA_SERVER_DATA_DIR: "/srv/athena", ATHENA_DISCOVERY_DIR: "/d" }, "/home/ada"), "/d");
});
