// STUB. The tabs lane provides the real `assertTabOwned(sessionId, tabId)`
// (throws when the session does not own the tab). Until the branches merge this
// accepts everything; per-tool handlers still do their own group check.
// MERGE: replace this file's body with a re-export of the tabs lane function,
// keeping the name and signature, e.g.
//   export { assertTabOwned } from "./<tabs-lane-module>.js";
export async function assertTabOwned(sessionId, tabId) {
  return true;
}
