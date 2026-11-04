import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

// src/reply.js is an ES module with no plugin behind it, bundled so the test needs no loader flags
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-"));
const out = path.join(dir, "reply.cjs");
buildSync({ entryPoints: [new URL("../src/reply.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
const { historyReply, replyChunks } = createRequire(import.meta.url)(out);

const quick = { silenceMs: 40, tickMs: 10 };
const collect = async (gen) => { const a = []; for await (const c of gen) a.push(c); return a; };
const never = () => new Promise(() => {});
async function* hangs(...first) { yield* first; await never(); }

test("a normal stream passes through and the history is not asked", async () => {
  async function* s() { yield { conversationId: "c" }; yield { text: "При" }; yield { text: "вет" }; yield { done: true }; }
  let asked = 0, how = "";
  const got = await collect(replyChunks(s(), () => { asked++; return "x"; }, { ...quick, onEnd: (e) => { how = e.how; } }));
  assert.deepEqual(got, [{ text: "При" }, { text: "вет" }, { done: true }]);
  assert.equal(asked, 0);
  assert.equal(how, "stream");
});

test("a stream that goes silent: the finished reply comes from the history", async () => {
  let ready = "";
  setTimeout(() => { ready = "Готовый ответ"; }, 80);
  const got = await collect(replyChunks(hangs({ conversationId: "c" }), () => ready, quick));
  assert.deepEqual(got, [{ text: "Готовый ответ" }, { done: true }]);
});

test("cut off mid-reply: only the rest is sent", async () => {
  const got = await collect(replyChunks(hangs({ text: "Ого, всё " }), () => "Ого, всё хорошо?", quick));
  assert.deepEqual(got, [{ text: "Ого, всё " }, { text: "хорошо?" }, { done: true }]);
});

test("the stream finishes with no text at all", async () => {
  async function* s() { yield { conversationId: "c" }; yield { done: true }; }
  const got = await collect(replyChunks(s(), () => "Ответ", quick));
  assert.deepEqual(got, [{ text: "Ответ" }, { done: true }]);
});

test("the stream ends early: the history, or an honest error", async () => {
  async function* s() { yield { text: "А" }; }
  assert.deepEqual(await collect(replyChunks(s(), () => "Аага", quick)), [{ text: "А" }, { text: "ага" }, { done: true }]);
  const lost = await collect(replyChunks(s(), () => "", quick));
  assert.deepEqual(lost.map((c) => Object.keys(c)[0]), ["text", "error"]);
});

test("an error from Astra stays an error, and a refused call still throws", async () => {
  async function* s() { yield { error: "нет" }; }
  assert.deepEqual(await collect(replyChunks(s(), () => "Ответ", quick)), [{ error: "нет" }]);
  async function* refused() { throw Object.assign(new Error("denied"), { code: 7 }); }
  await assert.rejects(collect(replyChunks(refused(), () => "", quick)), (e) => e.code === 7);
});

test("no reply anywhere: the phone is told instead of spinning", async () => {
  const got = await collect(replyChunks(hangs({ conversationId: "c" }), () => "", { ...quick, giveUpMs: 60 }));
  assert.equal(got.length, 1);
  assert.match(got[0].error, /не ответила/);
});

test("the stream failing while the reply is at the phone does not bring the plugin down", async () => {
  let failed = 0;
  const seen = () => { failed++; };
  process.on("unhandledRejection", seen);
  async function* s() { yield { text: "А" }; throw new Error("gone"); }
  await assert.rejects(async () => {
    for await (const _ of replyChunks(s(), () => "", quick)) await new Promise((r) => setTimeout(r, 20));
  }, /gone/);
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", seen);
  assert.equal(failed, 0);
});

test("the stream names its conversation", async () => {
  async function* s() { yield { conversationId: "c1" }; yield { done: true, text: "ok" }; }
  let id = "";
  await collect(replyChunks(s(), () => "", { ...quick, onConversation: (c) => { id = c; } }));
  assert.equal(id, "c1");
});

test("the history: the answer to this message, not another chat's or an older one", () => {
  const hist = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
  const now = Date.now(), iso = (d) => new Date(now + d).toISOString();
  const line = (role, content, d) => JSON.stringify({ role, content, created_at: iso(d) });
  fs.writeFileSync(path.join(hist, "a.jsonl"), [line("user", "Привет", -60000), line("assistant", "старый ответ", -59000)].join("\n") + "\n");
  const said = (t) => historyReply(hist, t, now).text;
  assert.equal(said("Привет"), "", "an older exchange is not this one");
  fs.writeFileSync(path.join(hist, "b.jsonl"), [line("user", "другое", 100), line("assistant", "чужой ответ", 200)].join("\n") + "\n");
  assert.equal(said("Привет"), "");
  fs.appendFileSync(path.join(hist, "a.jsonl"), line("user", "Привет", 100) + "\n");
  assert.equal(said("Привет"), "", "no answer yet");
  fs.appendFileSync(path.join(hist, "a.jsonl"), line("assistant", "новый ответ", 300) + "\n");
  assert.deepEqual(historyReply(hist, "Привет", now), { text: "новый ответ", conversation: "a" });
  assert.equal(historyReply(path.join(hist, "нет такой"), "Привет", now).text, "");
});
