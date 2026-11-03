import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTaskManager, taskIdentity } from "../src/tasks.js";

const identity = { pid: 123, created: "133879550000000001", window: "987654321" };
const row = { ...identity, name: "Editor", title: "Unsaved document", memory: 1024, exe: "C:\\Apps\\Editor.exe" };
function fixture(overrides = {}) {
  const calls = [];
  const providers = { list: async () => [row], action: async (...args) => calls.push(args), state: async () => "exited", ...overrides };
  return { manager: makeTaskManager(providers), calls };
}

test("identities preserve precise creation time and window; reject shell-shaped and malformed data", () => {
  assert.deepEqual(taskIdentity({ ...identity, exe: "malicious" }), identity);
  assert.deepEqual(taskIdentity(identity, false), { pid: identity.pid, created: identity.created });
  for (const change of [{ pid: 0 }, { pid: 4 }, { pid: "123" }, { pid: 1.5 }, { created: 133879550000000001 },
    { created: "0" }, { created: "123'; Stop-Process *; '" }, { created: "99999999999999999999" }, { window: "0" }, { window: "-1" }]) {
    assert.throws(() => taskIdentity({ ...identity, ...change }), /Invalid task identity/);
  }
});

test("public list is a strict allowlist and does not leak executable or imply safe relaunch", async () => {
  const { manager } = fixture({ list: async () => [{ ...row, command: "secret", owner: "private" }] });
  assert.deepEqual(await manager.list(), [{ ...identity, name: row.name, title: row.title, memory: row.memory }]);
  await assert.rejects(manager.relaunch(identity), /unavailable/);
});

test("actions only forward a fresh exact process/window identity and an allowlisted verb", async () => {
  const { manager, calls } = fixture();
  for (const action of ["activate", "close", "kill"]) await manager.action({ ...identity, exe: "arbitrary.exe" }, action);
  assert.deepEqual(calls, ["activate", "close", "kill"].map((action) => [identity, action]));
  await assert.rejects(manager.action({ ...identity, created: "133879550000000002" }, "kill"), /changed/);
  await assert.rejects(manager.action({ ...identity, window: "1234" }, "close"), /changed/);
  await assert.rejects(manager.action(identity, "kill-tree"), /Unknown task action/);
  assert.equal(calls.length, 3);
});

test("native policy errors and list failures propagate; close never escalates", async () => {
  const verbs = [];
  const { manager } = fixture({ action: async (_id, verb) => { verbs.push(verb); throw new Error("Protected process"); } });
  await assert.rejects(manager.action(identity, "close"), /Protected process/);
  assert.deepEqual(verbs, ["close"]);
  await assert.rejects(fixture({ list: async () => { throw new Error("Access denied"); } }).manager.action(identity, "kill"), /Access denied/);
});

test("state only reports explicit running/exited, never treats access errors as exited", async () => {
  for (const status of ["running", "exited"]) assert.equal(await fixture({ state: async () => status }).manager.state(identity), status);
  await assert.rejects(fixture({ state: async () => null }).manager.state(identity), /Unknown process state/);
  await assert.rejects(fixture({ state: async () => { throw new Error("Access denied"); } }).manager.state(identity), /Access denied/);
});

test("safe relaunch is exact unique catalog mapping only, after exit, using catalog id not a path", async () => {
  let state = "running";
  let catalog = [{ id: "known-editor", exe: "c:\\apps\\EDITOR.EXE" }];
  const launched = [];
  const { manager } = fixture({ catalog: async () => catalog, launch: async (id) => launched.push(id), state: async () => state });
  assert.equal((await manager.list())[0].relaunchId, "known-editor");
  await assert.rejects(manager.relaunch(identity), /has not exited/);
  state = "exited";
  catalog = [{ id: "other", exe: row.exe }];
  await assert.rejects(manager.relaunch(identity), /catalog changed/);
  catalog = [{ id: "known-editor", exe: row.exe }];
  await manager.relaunch({ ...identity, exe: "C:\\Evil.exe", relaunchId: "evil" });
  assert.deepEqual(launched, ["known-editor"]);
  await assert.rejects(manager.relaunch(identity), /unavailable/);
});

test("ambiguous mappings, relative paths, or absent launch provider expose no relaunch capability", async () => {
  for (const options of [
    { catalog: async () => [{ id: "a", exe: row.exe }, { id: "b", exe: row.exe }], launch: async () => {} },
    { catalog: async () => [{ id: "a", exe: "Editor.exe" }], launch: async () => {} },
    { catalog: async () => [{ id: "a", exe: row.exe }] }
  ]) assert.equal((await fixture(options).manager.list())[0].relaunchId, undefined);
});

const source = fs.readFileSync(new URL("../src/pc.js", import.meta.url), "utf8");
test("numeric clamps preserve valid zero coordinates and primary screen selection", () => {
  const clamps = source.match(/const finite = [^\n]+\nconst int = [^\n]+/)[0];
  const clamp = vm.runInNewContext(`${clamps}; int`);
  assert.equal(clamp(0, -1, 8, -1), 0);
  assert.equal(clamp(0, 0, 10000, 5000), 0);
  assert.equal(clamp(NaN, 0, 10000, 5000), 5000);
  assert.equal(clamp(Infinity, 0, 10000, 5000), 5000);
});

test("capture wrapper preserves continuous zoom, explicit edge centers, and legacy cursor mode", async () => {
  const requests = [];
  const clamps = source.match(/const finite = [^\n]+\nconst int = [^\n]+/)[0];
  const live = source.match(/export async function liveFrame\([\s\S]*?\n}/)[0].replace("export ", "");
  const fn = vm.runInNewContext(`${clamps}\n${live}; liveFrame`, { viewer: { ps: async (script) => { requests.push(script); return "{}"; } } });
  await fn({ screen: 0, zoom: 1.75, centerX: 0, centerY: 1 });
  assert.match(requests[0], /Live\(0, 960, 60, \[double\]1\.75000000, 0\.00000000, 1\.00000000\)/);
  await fn();
  assert.match(requests[1], /\[double\]::NaN, \[double\]::NaN/);
  await fn({ zoom: 2, centerX: null, centerY: null }); // API omits cx/cy as null
  assert.match(requests[2], /\[double\]2\.00000000, \[double\]::NaN, \[double\]::NaN/);
});

test("held modifiers whitelist and zero pointer coordinates are serialized safely without a real worker", async () => {
  const requests = [];
  const clamps = source.match(/const finite = [^\n]+\nconst int = [^\n]+/)[0];
  const input = source.match(/export async function input\([\s\S]*?\n}/)[0].replace("export ", "");
  const fn = vm.runInNewContext(`${clamps}\n${input}; input`, { Buffer, pointer: { ps: async (script) => requests.push(script) } });
  await fn([["h", 17, 1], ["k", 65, 1], ["h", 17, 0], ["p", 0, 0, 0]]);
  assert.match(requests[0], /Modifier\(17, \$true\)/);
  assert.match(requests[0], /Modifier\(17, \$false\)/);
  assert.match(requests[0], /Point\(0, 0 \/ 10000\.0, 0 \/ 10000\.0\)/);
  await assert.rejects(fn([["h", 91, 1]]), /bad held modifier/);
  await assert.rejects(fn([["h", 17, "1"]]), /bad held modifier/);
});

test("Windows C# helper compiles without invoking any PC actions", { skip: process.platform !== "win32", timeout: 120000 }, () => {
  const helper = source.split("const HELPER = String.raw`")[1].split("\n`;")[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astra-helper-compile-"));
  const file = path.join(dir, "helper.cs");
  try {
    fs.writeFileSync(file, helper);
    const script = `$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition ([IO.File]::ReadAllText('${file.replaceAll("'", "''")}')); 'COMPILE_OK'`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 110000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /COMPILE_OK/);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test("native task policy retains identity handles, checks owner/session/elevation, and avoids tree kill", () => {
  assert.match(source, /GetProcessTimes\(p\.Handle/);
  assert.match(source, /owner\.User\.Equals\(self\.User\)/);
  assert.match(source, /p\.SessionId != self\.SessionId/);
  assert.match(source, /GetTokenInformation\(token, 20/);
  assert.match(source, /Protected\(hostPid\)/);
  assert.match(source, /p\.Kill\(\)/);
  assert.doesNotMatch(source, /\.Kill\(true\)|taskkill|Stop-Process/);
  assert.match(source, /PostMessage\(h, 0x0010/);
  assert.match(source, /if \(!SetForegroundWindow\(h\)\) throw/);
  assert.match(source, /return run\("shutdown\.exe", \["\/s", "\/t", "0"\]\)/);
  assert.match(source, /createHash\("sha256"\)\.update\(HELPER\)/);
});
