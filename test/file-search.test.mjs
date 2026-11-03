import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// files.js is ESM while this package intentionally has no "type": "module".
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "astra-file-search-"));
const bundled = path.join(temp, "files.mjs");
execFileSync(process.execPath, [
  path.resolve("node_modules/esbuild/bin/esbuild"), path.resolve("src/files.js"),
  "--bundle", "--platform=node", "--format=esm", "--outfile=" + bundled,
], { stdio: "pipe" });
const files = await import(pathToFileURL(bundled).href);

const status = (code) => (error) => error?.status === code;

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("configured read-only roots list, search and stream only safe paths", async (t) => {
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const allowed = path.join(temp, "allowed");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(path.join(allowed, "nested"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, "report.txt"), "inside");
  fs.writeFileSync(path.join(allowed, "nested", "report-2.txt"), "nested");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  for (let i = 0; i < 160; i++) fs.writeFileSync(path.join(allowed, "nested", `bulk-${i}.txt`), "x");

  const cfg = { allowed_folders: allowed };
  const roots = files.allowedRoots(cfg);
  assert.deepEqual(Object.keys(roots[0]).sort(), ["id", "name"]);
  assert.equal(roots.length, 1);
  assert.ok(!JSON.stringify(roots).includes(allowed), "root responses do not expose absolute paths");
  const id = roots[0].id;
  assert.equal(files.allowedRoots(cfg)[0].id, id, "canonical root ID is stable");

  const listed = files.listAllowed(cfg, id, "");
  assert.equal(listed.root, id);
  assert.equal(listed.path, "");
  assert.ok(listed.items.some((item) => item.name === "report.txt"));
  assert.equal(listed.truncated, false);

  const found = await files.searchAllowed(cfg, { root: id, query: "report" });
  assert.deepEqual(found.items.map((item) => item.path).sort(), ["nested/report-2.txt", "report.txt"]);
  assert.ok(found.items.every((item) => item.root === id && item.dir === false));
  assert.ok(!JSON.stringify(found).includes(allowed));

  const download = files.openAllowedDownload(cfg, id, "report.txt");
  assert.equal(download.name, "report.txt");
  assert.equal(download.size, 6);
  assert.equal(await read(download.stream), "inside");

  for (const bad of ["../secret.txt", "nested/../../secret.txt", "/secret.txt", "\\\\server\\share", "C:\\Windows\\win.ini", "report.txt:stream", "nested\\..\\report.txt"]) {
    assert.throws(() => files.openAllowedDownload(cfg, id, bad), status(400), bad);
  }
  assert.throws(() => files.listAllowed(cfg, "not-a-root", ""), status(404));

  // A junction is the Windows equivalent of the symlink escape checked on other platforms.
  const escape = path.join(allowed, "escape");
  try {
    fs.symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  } catch {}
  if (fs.existsSync(escape)) {
    assert.ok(!files.listAllowed(cfg, id, "").items.some((item) => item.name === "escape"), "escaping links are hidden");
    assert.throws(() => files.openAllowedDownload(cfg, id, "escape/secret.txt"), status(403));
  }

  const bounded = await files.searchAllowed(cfg, { root: id, query: "bulk", maxVisited: 1 });
  assert.equal(bounded.truncated, true, "caller can lower, but not raise, search budgets");

  const controller = new AbortController();
  const cancelled = files.searchAllowed(cfg, { root: id, query: "does-not-match", signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(cancelled, (error) => error?.name === "AbortError");

  cfg.allowed_folders = "";
  assert.throws(() => files.listAllowed(cfg, id, ""), status(404), "roots are re-read so revoked access applies immediately");
});
