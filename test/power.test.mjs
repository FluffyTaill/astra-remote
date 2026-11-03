import test from "node:test";
import assert from "node:assert/strict";
import { createPowerManager } from "../src/power.js";

function clock() {
  let time = 1_000_000;
  let next = 0;
  const timers = new Map();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const handle = { id: ++next, unref() {} };
      timers.set(handle.id, { at: time + ms, fn });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle?.id); },
    async advance(ms) {
      time += ms;
      for (;;) {
        const due = [...timers].filter(([, value]) => value.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      await flush();
    },
    flush,
    size: () => timers.size
  };
}

function fixture({ process = () => "running" } = {}) {
  const fake = clock();
  const cfg = { allow_power: true, allow_shutdown: true, allow_remote_shutdown: true };
  const valid = new Set(["phone"]);
  const shutdowns = [];
  const logs = [];
  const manager = createPowerManager({
    config: () => cfg,
    deviceValid: (id) => valid.has(id),
    processState: process,
    shutdown: async (job) => shutdowns.push(job),
    log: (...entry) => logs.push(entry),
    now: fake.now, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout, pollMs: 2_000
  });
  return { manager, fake, cfg, valid, shutdowns, logs };
}

const phone = { id: "phone", name: "Pixel" };
const target = { pid: 42, created: "2026-01-01T00:00:00.000Z", name: "Editor", exe: "C:/secret/editor.exe" };

async function confirmed(f, request = { mode: "now" }) {
  const prepared = await f.manager.prepare(phone, request);
  return f.manager.commit(phone, { challenge: prepared.challenge });
}

test("challenge is device-bound, expires, and is single-use", async () => {
  const f = fixture();
  const prepared = await f.manager.prepare(phone, { mode: "now" });
  await assert.rejects(f.manager.commit({ id: "other", name: "Other" }, { challenge: prepared.challenge }), /another device/);
  await f.manager.commit(phone, { challenge: prepared.challenge });
  await assert.rejects(f.manager.commit(phone, { challenge: prepared.challenge }), /invalid or expired/);

  f.manager.cancel(phone);
  const stale = await f.manager.prepare(phone, { mode: "now" });
  await f.fake.advance(60_000);
  await assert.rejects(f.manager.commit(phone, { challenge: stale.challenge }), /invalid or expired/);
  assert.equal(f.manager.state().status, "cancelled");
});

test("two commits cannot replay one challenge", async () => {
  const f = fixture();
  const { challenge } = await f.manager.prepare(phone, { mode: "now" });
  const result = await Promise.allSettled([
    f.manager.commit(phone, { challenge }), f.manager.commit(phone, { challenge })
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.manager.state().status, "countdown");
});

test("only one live request exists and its owner can cancel it", async () => {
  const f = fixture();
  await f.manager.prepare(phone, { mode: "now" });
  await assert.rejects(f.manager.prepare(phone, { mode: "now" }), /active/);
  assert.throws(() => f.manager.cancel({ id: "other" }), /Only the requesting/);
  assert.equal(f.manager.cancel(phone).status, "cancelled");
  assert.equal((await f.manager.prepare(phone, { mode: "now" })).summary.includes("30 second"), true);
});

test("now request shuts down only at the deadline and stop prevents late callbacks", async () => {
  const f = fixture();
  await confirmed(f);
  await f.fake.advance(29_999);
  assert.equal(f.shutdowns.length, 0);
  await f.fake.advance(1);
  assert.equal(f.shutdowns.length, 1);

  const late = fixture();
  await confirmed(late);
  late.manager.stop();
  await late.fake.advance(60_000);
  assert.equal(late.shutdowns.length, 0);
  assert.equal(late.manager.state().status, "cancelled");
});

test("config revocation cancels outstanding confirmation and countdown", async () => {
  const f = fixture();
  await f.manager.prepare(phone, { mode: "now" });
  f.cfg.allow_remote_shutdown = false;
  assert.equal(f.manager.reconcile().status, "cancelled");
  f.cfg.allow_remote_shutdown = true;
  await confirmed(f);
  f.valid.delete("phone");
  await f.fake.advance(2_000);
  assert.equal(f.manager.state().status, "cancelled");
  await f.fake.advance(60_000);
  assert.equal(f.shutdowns.length, 0);
});

test("process requests validate exact identity at prepare and commit, then wait for exit", async () => {
  let state = "running";
  const calls = [];
  const f = fixture({ process: (seen) => { calls.push(seen); return state; } });
  const prepared = await f.manager.prepare(phone, { mode: "process", target });
  assert.deepEqual(calls[0], { pid: 42, created: target.created, name: "Editor" });
  assert.equal(f.manager.state().target.exe, undefined, "state never exposes executable paths");
  await f.manager.commit(phone, { challenge: prepared.challenge });
  assert.equal(f.manager.state().status, "waiting");
  state = "exited";
  await f.fake.advance(2_000);
  assert.equal(f.manager.state().status, "countdown");
  await f.fake.advance(30_000);
  assert.equal(f.shutdowns.length, 1);
});

test("a process exit before commit or an unreadable process cancels safely", async () => {
  let state = "running";
  const f = fixture({ process: () => state });
  const p = await f.manager.prepare(phone, { mode: "process", target });
  state = "exited"; // PID/creation provider says the exact process is gone, never silently shut down
  await assert.rejects(f.manager.commit(phone, { challenge: p.challenge }), /already exited/);
  assert.equal(f.manager.state().status, "error");

  const unknown = fixture({ process: () => { throw new Error("access denied"); } });
  await assert.rejects(unknown.manager.prepare(phone, { mode: "process", target }), /Cannot verify/);
  assert.equal(unknown.manager.state().status, "error");
});

test("cancellation wins before an async deadline revalidation", async () => {
  const pending = [];
  const f = fixture({ process: () => new Promise((resolve) => pending.push(resolve)) });
  const preparedPromise = f.manager.prepare(phone, { mode: "process", target });
  await f.fake.flush();
  pending.shift()("running");
  const p = await preparedPromise;
  const committed = f.manager.commit(phone, { challenge: p.challenge });
  await f.fake.flush();
  pending.shift()("running");
  await committed;
  const watch = f.fake.advance(2_000);
  await f.fake.flush();
  pending.shift()("exited");
  await watch;
  const deadline = f.fake.advance(30_000);
  await f.fake.flush();
  // execute is awaiting the exact-process identity check; cancelling changes state first.
  f.manager.cancel(phone);
  pending.shift()("exited");
  await deadline;
  assert.equal(f.shutdowns.length, 0);
  assert.equal(f.manager.state().status, "cancelled");
});
