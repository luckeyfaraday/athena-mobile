import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_SETTLE_MS, AttentionTracker, FINISH_SETTLE_MS, MIN_WORK_MS, showsPrompt } from "./attention.mjs";

// Feed output every 100 ms from `from` to `to`, like a working agent's
// spinner. Real repaints average ~400 bytes per write (measured on Claude Code).
const REPAINT = `\x1b[2K\x1b[1G✻ Working… ${"─".repeat(380)}`;
function work(tracker, id, from, to, chunk = REPAINT) {
  for (let now = from; now <= to; now += 100) tracker.output(id, chunk, now);
}

test("recognizes Claude Code and Codex approval prompts through ANSI codes", () => {
  assert.ok(showsPrompt("\x1b[1mBash command\x1b[22m\r\n  rm -rf dist\r\n\x1b[2mDo you want to proceed?\x1b[22m\r\n❯ 1. Yes"));
  assert.ok(showsPrompt("Would you like to run the following command?\r\n› 1. Yes, proceed (y)"));
  assert.ok(showsPrompt("3. No, and tell Codex what to do differently (esc)"));
  assert.ok(showsPrompt("Overwrite existing file? [y/N]"));
  assert.ok(showsPrompt("Enter to select · ↑/↓ to navigate · Esc to cancel"));
});

test("ignores prose and status lines that only mention permissions", () => {
  assert.equal(showsPrompt("⏵⏵ bypass permissions on (shift+tab to cycle)"), false);
  assert.equal(showsPrompt("I fixed the permission check. Want me to commit?"), false);
  assert.equal(showsPrompt("Do you want me to open a PR?"), false);
});

test("reports an approval prompt once the terminal settles, then stays quiet", () => {
  const tracker = new AttentionTracker();
  work(tracker, "t1", 0, 3_000);
  tracker.output("t1", "Do you want to proceed?\r\n❯ 1. Yes", 3_100);

  assert.equal(tracker.due("t1", 3_100 + ACTION_SETTLE_MS - 1), null);
  assert.equal(tracker.due("t1", 3_100 + ACTION_SETTLE_MS), "action");
  tracker.acknowledge("t1");
  assert.equal(tracker.due("t1", 3_100 + FINISH_SETTLE_MS), null);
});

test("reports a finished turn only after real work and a longer silence", () => {
  const tracker = new AttentionTracker();
  work(tracker, "t1", 0, MIN_WORK_MS);

  assert.equal(tracker.due("t1", MIN_WORK_MS + ACTION_SETTLE_MS), null);
  assert.equal(tracker.due("t1", MIN_WORK_MS + FINISH_SETTLE_MS), "finished");
});

test("keeps reporting until acknowledged, so a rate-limited alert can go out later", () => {
  const tracker = new AttentionTracker();
  work(tracker, "t1", 0, MIN_WORK_MS);

  assert.equal(tracker.due("t1", MIN_WORK_MS + FINISH_SETTLE_MS), "finished");
  assert.equal(tracker.due("t1", MIN_WORK_MS + FINISH_SETTLE_MS + 5 * 60_000), "finished");
});

test("ignores short bursts such as typing echo", () => {
  const tracker = new AttentionTracker();
  work(tracker, "t1", 0, 5_000, "x");

  assert.equal(tracker.due("t1", 5_000 + FINISH_SETTLE_MS * 2), null);
});

test("output after a settle-length silence starts a new burst", () => {
  const tracker = new AttentionTracker();
  tracker.output("t1", "Do you want to proceed?", 0);
  assert.equal(tracker.due("t1", ACTION_SETTLE_MS), "action");
  tracker.acknowledge("t1");

  // The user answers after the alert; the agent resumes and asks again.
  work(tracker, "t1", ACTION_SETTLE_MS + 5_000, ACTION_SETTLE_MS + 8_000);
  tracker.output("t1", "Do you want to make this edit?", ACTION_SETTLE_MS + 8_100);
  assert.equal(tracker.due("t1", ACTION_SETTLE_MS * 2 + 8_100), "action");
});

test("answering within the settle window continues the burst without an alert", () => {
  const tracker = new AttentionTracker();
  tracker.output("t1", "Do you want to proceed?", 0);
  // Answered at the desk after 10 s: output resumes before the prompt settles.
  work(tracker, "t1", 10_000, 12_000);

  assert.equal(tracker.due("t1", 12_000 + ACTION_SETTLE_MS), null);
});

test("retain drops terminals that are no longer running", () => {
  const tracker = new AttentionTracker();
  tracker.output("gone", "Do you want to proceed?", 0);
  tracker.output("live", "Do you want to proceed?", 0);
  tracker.retain(new Set(["live"]));

  assert.equal(tracker.due("gone", ACTION_SETTLE_MS), null);
  assert.equal(tracker.due("live", ACTION_SETTLE_MS), "action");
});
