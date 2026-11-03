// Confirmation-gated remote shutdown state machine.  It deliberately has no OS-specific code:
// the caller supplies process inspection and the actual shutdown operation.
import { randomBytes } from "node:crypto";

const CHALLENGE_TTL = 60_000;
const COUNTDOWN = 30_000;
const CHALLENGE_CAP = 16;

function problem(message, code = "POWER") {
  const error = new Error(message);
  error.code = code;
  error.status = ["FORBIDDEN", "DEVICE"].includes(code) ? 403 : ["CONFLICT", "PROCESS_STATE", "CANCELLED"].includes(code) ? 409 : code === "STOPPED" ? 503 : 400;
  return error;
}

function copyTarget(target) {
  if (!target) return null;
  return { pid: target.pid, created: target.created, name: target.name };
}

/**
 * @param {{
 *   config: () => object, deviceValid: (deviceId: string) => boolean,
 *   processState: (target: {pid:number, created:string, name:string}) => Promise<"running"|"exited">|"running"|"exited",
 *   shutdown: (job: object) => Promise<void>|void, log: (device: object, message: string, ok?: boolean) => void,
 *   now?: () => number, setTimeout?: Function, clearTimeout?: Function, pollMs?: number
 * }} deps
 */
export function createPowerManager(deps) {
  if (!deps || typeof deps.config !== "function" || typeof deps.deviceValid !== "function" ||
      typeof deps.processState !== "function" || typeof deps.shutdown !== "function" || typeof deps.log !== "function") {
    throw new TypeError("createPowerManager needs config, deviceValid, processState, shutdown and log");
  }

  const clock = deps.now || Date.now;
  const later = deps.setTimeout || setTimeout;
  const cancelTimer = deps.clearTimeout || clearTimeout;
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : 2_000;
  const challenges = new Map();
  let job = null;
  let stopped = false;
  let preparing = false;
  let timer = null;
  let deadlineTimer = null;

  const blank = () => ({
    status: "idle", id: null, ownerId: null, ownerName: null, mode: null,
    target: null, scheduleAt: null, deadline: null
  });

  function publicState(value = job) {
    if (!value) return blank();
    const out = {
      status: value.status, id: value.id, ownerId: value.ownerId, ownerName: value.ownerName,
      mode: value.mode, target: copyTarget(value.target), scheduleAt: value.scheduleAt, deadline: value.deadline
    };
    if (value.error) out.error = value.error;
    return out;
  }

  function log(device, message, ok) {
    try {
      const result = deps.log(device, message, ok);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch { /* logging must never permit or prevent a shutdown */ }
  }

  function permissions(mode = job?.mode) {
    const cfg = deps.config() || {};
    return !!cfg.allow_power && !!cfg.allow_shutdown && !!cfg.allow_remote_shutdown && !(mode === "process" && cfg.allow_tasks === false);
  }

  function validOwner(id) {
    try { return !!deps.deviceValid(id); } catch { return false; }
  }

  function clearTimers() {
    if (timer !== null) cancelTimer(timer);
    if (deadlineTimer !== null) cancelTimer(deadlineTimer);
    timer = null;
    deadlineTimer = null;
  }

  function arm(fn, ms, deadline = false) {
    const handle = later(fn, Math.max(0, ms));
    if (handle && typeof handle.unref === "function") handle.unref();
    if (deadline) deadlineTimer = handle;
    else timer = handle;
  }

  function terminal(status, error) {
    if (!job) return;
    clearTimers();
    job.status = status;
    job.error = error || undefined;
  }

  function current(id, statuses) {
    return !stopped && job && job.id === id && statuses.includes(job.status);
  }

  function deleteChallenge(id) {
    challenges.delete(id);
  }

  function cancelForPolicy(message = "Power request is no longer allowed") {
    for (const [key, challenge] of challenges) {
      if (!permissions() || !validOwner(challenge.device.id)) challenges.delete(key);
    }
    if (job && ["requested", "waiting", "countdown"].includes(job.status) &&
        (!permissions() || !validOwner(job.ownerId))) {
      terminal("cancelled", message);
      log(job.device, "power request cancelled", false);
    }
  }

  async function inspect(target, expected) {
    let status;
    try {
      status = await deps.processState(copyTarget(target));
    } catch (error) {
      throw problem("Cannot verify the selected process", "PROCESS_UNKNOWN");
    }
    if (status !== "running" && status !== "exited") throw problem("Cannot verify the selected process", "PROCESS_UNKNOWN");
    if (expected && status !== expected) throw problem(expected === "running" ? "The selected process has already exited" : "The selected process identity changed", "PROCESS_STATE");
    return status;
  }

  function validateTarget(target) {
    if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0 ||
        typeof target.created !== "string" || !target.created || typeof target.name !== "string" || !target.name) {
      throw problem("A process target needs pid, created and name", "TARGET");
    }
    return copyTarget(target);
  }

  function expireRequest(id) {
    if (!current(id, ["requested"]) || !job.challenge || clock() < job.challenge.expiresAt) return;
    deleteChallenge(job.challenge.id);
    terminal("cancelled", "Challenge expired");
  }

  async function watch(id) {
    if (!current(id, ["waiting"])) return;
    if (!permissions() || !validOwner(job.ownerId)) {
      terminal("cancelled", "Power request is no longer allowed");
      return;
    }
    let status;
    try {
      status = await inspect(job.target, null);
    } catch (error) {
      if (current(id, ["waiting"])) terminal("error", error.message);
      return;
    }
    if (!current(id, ["waiting"])) return;
    if (status === "exited") {
      beginCountdown(id);
      return;
    }
    arm(() => { watch(id); }, pollMs);
  }

  async function countdownCheck(id) {
    if (!current(id, ["countdown"])) return;
    if (!permissions() || !validOwner(job.ownerId)) {
      terminal("cancelled", "Power request is no longer allowed");
      return;
    }
    try {
      if (job.mode === "process") await inspect(job.target, "exited");
    } catch (error) {
      if (current(id, ["countdown"])) terminal("error", error.message);
      return;
    }
    if (!current(id, ["countdown"])) return;
    const remaining = job.deadline - clock();
    if (remaining > 0) arm(() => { countdownCheck(id); }, Math.min(pollMs, remaining));
  }

  async function execute(id) {
    if (!current(id, ["countdown"])) return;
    // A deadline is a fresh authorization boundary, not merely a timer firing.
    if (!permissions() || !validOwner(job.ownerId)) {
      terminal("cancelled", "Power request is no longer allowed");
      return;
    }
    try {
      if (job.mode === "process") await inspect(job.target, "exited");
    } catch (error) {
      if (current(id, ["countdown"])) terminal("error", error.message);
      return;
    }
    if (!current(id, ["countdown"])) return; // cancellation while an async check was in progress
    if (!permissions() || !validOwner(job.ownerId)) { terminal("cancelled", "Power request is no longer allowed"); return; }
    clearTimers();
    job.status = "executing"; // set synchronously: cancel and execution cannot both win this tick
    try {
      await deps.shutdown(publicState(job));
      if (current(id, ["executing"])) { job.status = "submitted"; log(job.device, "shutdown requested", true); }
    } catch (error) {
      if (current(id, ["executing"])) {
        job.status = "error";
        job.error = "Shutdown request failed";
        log(job.device, "shutdown request failed", false);
      }
    }
  }

  function beginCountdown(id) {
    if (!current(id, ["requested", "waiting", "countdown"])) return;
    clearTimers();
    job.status = "countdown";
    job.scheduleAt = clock();
    job.deadline = job.scheduleAt + COUNTDOWN;
    arm(() => { countdownCheck(id); }, Math.min(pollMs, COUNTDOWN));
    arm(() => { execute(id); }, COUNTDOWN, true);
  }

  async function prepare(device, request) {
    if (preparing) throw problem("Another power request is active", "CONFLICT");
    preparing = true;
    try { return await prepareRequest(device, request); }
    finally { preparing = false; }
  }

  async function prepareRequest(device, request) {
    if (stopped) throw problem("Power manager has stopped", "STOPPED");
    if (!permissions(request?.mode)) throw problem("Remote shutdown is disabled", "FORBIDDEN");
    if (!device || typeof device.id !== "string" || !device.id || !validOwner(device.id)) throw problem("Device is no longer authorized", "DEVICE");
    if (job && !["cancelled", "error", "submitted"].includes(job.status)) throw problem("Another power request is active", "CONFLICT");
    const mode = request && request.mode;
    if (mode !== "now" && mode !== "process") throw problem("Mode must be now or process", "MODE");
    let target = null;
    try {
      if (mode === "process") {
        target = validateTarget(request.target);
        await inspect(target, "running");
      }
    } catch (error) {
      job = { ...blank(), id: randomBytes(16).toString("base64url"), ownerId: device.id, ownerName: String(device.name || ""),
        device, mode, target, status: "error", error: error.message };
      throw error;
    }
    if (stopped) throw problem("Power manager has stopped", "STOPPED");
    if (job && !["cancelled", "error", "submitted"].includes(job.status)) throw problem("Another power request is active", "CONFLICT");
    if (!permissions() || !validOwner(device.id)) throw problem("Power request is no longer allowed", "FORBIDDEN");
    // One live request also makes cancelling a stale confirmation unambiguous.
    const id = randomBytes(16).toString("base64url");
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = clock() + CHALLENGE_TTL;
    if (challenges.size >= CHALLENGE_CAP) {
      for (const [key, value] of challenges) if (value.expiresAt <= clock()) challenges.delete(key);
      if (challenges.size >= CHALLENGE_CAP) throw problem("Too many pending confirmations", "BUSY");
    }
    const owner = { id: device.id, name: String(device.name || "") };
    job = { id, ownerId: owner.id, ownerName: owner.name, device: owner, mode, target, status: "requested",
      scheduleAt: null, deadline: null, challenge: { id: challenge, expiresAt } };
    challenges.set(challenge, { id, device: owner, mode, target: copyTarget(target), expiresAt });
    arm(() => { expireRequest(id); }, CHALLENGE_TTL);
    log(owner, "shutdown confirmation requested");
    return {
      challenge, expiresAt,
      summary: mode === "now" ? "Shut down this PC after a 30 second countdown" : `Shut down after ${target.name} exits`
    };
  }

  async function commit(device, confirmation) {
    if (stopped) throw problem("Power manager has stopped", "STOPPED");
    const token = confirmation && confirmation.challenge;
    const challenge = typeof token === "string" ? challenges.get(token) : null;
    if (!challenge || challenge.expiresAt <= clock()) {
      if (challenge) challenges.delete(token);
      if (job && job.status === "requested" && job.challenge?.id === token) terminal("cancelled", "Challenge expired");
      throw problem("Challenge is invalid or expired", "CHALLENGE");
    }
    if (!device || device.id !== challenge.device.id) throw problem("Challenge belongs to another device", "CHALLENGE");
    // Consume before any await.  A second concurrent commit cannot replay this approval.
    challenges.delete(token);
    if (!job || job.id !== challenge.id || job.status !== "requested" || job.challenge.id !== token) throw problem("Power request is no longer active", "CONFLICT");
    clearTimers();
    delete job.challenge;
    if (!permissions() || !validOwner(job.ownerId)) {
      terminal("cancelled", "Power request is no longer allowed");
      throw problem("Power request is no longer allowed", "FORBIDDEN");
    }
    if (job.mode === "process") {
      try {
        await inspect(job.target, "running");
      } catch (error) {
        if (current(challenge.id, ["requested"])) terminal("error", error.message);
        throw error;
      }
      if (!current(challenge.id, ["requested"])) throw problem("Power request was cancelled", "CANCELLED");
      if (!permissions() || !validOwner(job.ownerId)) {
        terminal("cancelled", "Power request is no longer allowed");
        throw problem("Power request is no longer allowed", "FORBIDDEN");
      }
      job.status = "waiting";
      job.scheduleAt = clock();
      log(job.device, "shutdown waiting for process to exit");
      arm(() => { watch(challenge.id); }, pollMs);
    } else {
      beginCountdown(challenge.id);
      log(job.device, "shutdown countdown started");
    }
    return publicState();
  }

  function cancel(device) {
    if (!job || ["cancelled", "error", "submitted"].includes(job.status)) return publicState();
    if (job.status === "executing") throw problem("Shutdown is already being requested", "CONFLICT");
    if (!device || device.id !== job.ownerId) throw problem("Only the requesting device may cancel", "DEVICE");
    if (job.challenge) challenges.delete(job.challenge.id);
    terminal("cancelled", "Cancelled by device");
    log(job.device, "power request cancelled");
    return publicState();
  }

  function reconcile() {
    if (stopped) return publicState();
    cancelForPolicy();
    if (job?.status === "requested" && job.challenge && job.challenge.expiresAt <= clock()) expireRequest(job.id);
    return publicState();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    challenges.clear();
    if (job && ["requested", "waiting", "countdown"].includes(job.status)) terminal("cancelled", "Power manager stopped");
    else clearTimers();
  }

  return { prepare, commit, cancel, state: () => publicState(), reconcile, stop };
}
