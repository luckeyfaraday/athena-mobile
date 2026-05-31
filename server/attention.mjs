// Agent-attention classifier — ported verbatim from context-workspace
// (client/src/workspace-attention.ts) so the notifier can run the same
// detection the desktop UI uses, without importing across repos.
//
// Returns "action" when an agent appears to be waiting on the user
// (approval/permission/input), "update" when it reports finishing work, or
// null for ordinary output.

export function classifyTerminalAttention(data) {
  // Strip ANSI escape sequences so the regexes see plain words.
  const text = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ");
  if (/\b(approve|approval|permission|allow|confirm|confirmation|required|requires|proceed|continue)\b/i.test(text)) {
    if (/\b(waiting|needs?|requires?|requesting|press|select|confirm|approve|allow|permission)\b/i.test(text)) return "action";
  }
  if (/\b(task complete|completed|finished|done|implemented|fixed|passed|succeeded|opened pr|ready for review)\b/i.test(text)) return "update";
  return null;
}
