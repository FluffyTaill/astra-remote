import * as path from "node:path";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const decimal = (value) => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 9223372036854775807n;

// Identifiers remain strings: FILETIME and HWND are not safe JavaScript numbers.
export function taskIdentity(value, requireWindow = true) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || value.pid <= 4 || value.pid > 2147483647
    || !decimal(value.created) || (requireWindow && !decimal(value.window))) throw fail("Invalid task identity");
  return { pid: value.pid, created: value.created, ...(requireWindow ? { window: value.window } : {}) };
}
const key = ({ pid, created, window }) => `${pid}:${created}:${window}`;
const executable = (value) => typeof value === "string" && path.win32.isAbsolute(value) && /\.exe$/i.test(value)
  ? path.win32.normalize(value).toLowerCase() : null;

// Providers are trusted local adapters. OS authorization stays in pc.js and is repeated at action time.
// No request-supplied executable, name, command or path is ever used to launch or terminate anything.
export function makeTaskManager({ list, action, state, catalog, launch }) {
  if (![list, action, state].every((fn) => typeof fn === "function")) throw new TypeError("Task providers required");
  const seen = new Map();
  async function catalogMatch(exe) {
    if (!exe || typeof catalog !== "function" || typeof launch !== "function") return null;
    const rows = await catalog();
    if (!Array.isArray(rows)) throw new TypeError("Invalid task catalog");
    const matches = rows.filter((row) => row && typeof row.id === "string" && row.id && executable(row.exe) === exe);
    return matches.length === 1 ? matches[0].id : null;
  }
  async function read() {
    const rows = await list();
    if (!Array.isArray(rows)) throw new TypeError("Invalid task list");
    return rows.map((row) => ({ ...taskIdentity(row), name: String(row.name ?? ""), title: String(row.title ?? ""),
      memory: Number.isFinite(row.memory) && row.memory >= 0 ? row.memory : 0, exe: executable(row.exe) }));
  }
  async function checkedState(identity) {
    const result = await state(taskIdentity(identity, false));
    if (result !== "running" && result !== "exited") throw new Error("Unknown process state");
    return result;
  }
  return {
    async list() {
      const rows = await read();
      return Promise.all(rows.map(async ({ exe, ...row }) => {
        const relaunchId = await catalogMatch(exe);
        seen.set(key(row), { ...row, exe, relaunchId });
        while (seen.size > 512) seen.delete(seen.keys().next().value);
        return { ...row, ...(relaunchId ? { relaunchId } : {}) };
      }));
    },
    async action(identity, verb) {
      const id = taskIdentity(identity);
      if (!["activate", "close", "kill"].includes(verb)) throw fail("Unknown task action");
      const row = (await read()).find((row) => key(row) === key(id));
      if (!row) throw fail("Task changed or is unavailable", 409);
      // The native provider must validate again; refreshing the list is not an authorization boundary.
      await action(id, verb);
      return { ok: true, action: verb };
    },
    state: checkedState,
    async relaunch(identity) {
      const id = taskIdentity(identity);
      const original = seen.get(key(id));
      if (!original?.relaunchId) throw fail("Safe relaunch is unavailable", 409);
      if (await checkedState(id) !== "exited") throw fail("Task has not exited", 409);
      if (await catalogMatch(original.exe) !== original.relaunchId) throw fail("Application catalog changed", 409);
      await launch(original.relaunchId);
      seen.delete(key(id));
      return { ok: true };
    }
  };
}
