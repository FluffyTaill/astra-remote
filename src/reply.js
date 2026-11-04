// A chat reply for the phone. Astra streams it to the plugin, and also writes every finished reply to
// its chat history on this PC; when the stream goes silent or ends without the text, the reply is
// taken from there, so an answer Astra did give is never lost on the way.
import fs from "node:fs";
import path from "node:path";

// The assistant's answer to `text`, sent no earlier than `since` (ms), from the newest history files.
// A conversation's file is one JSON message per line: { role, content, created_at }.
export function historyReply(dir, text, since) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.at >= since - 2000).sort((a, b) => b.at - a.at).slice(0, 5);
  } catch {
    return "";
  }
  const want = String(text).trim();
  for (const { f } of files) {
    let rows = [];
    try {
      rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-40).map((l) => JSON.parse(l));
    } catch {
      continue;
    }
    // the last time this text was sent, not before this request: another chat's reply is not ours
    let at = -1;
    rows.forEach((m, i) => {
      if (m.role === "user" && String(m.content ?? "").trim() === want && Date.parse(m.created_at) >= since - 2000) at = i;
    });
    if (at < 0) continue;
    const reply = rows.slice(at + 1).find((m) => m.role === "assistant" && String(m.content ?? "").trim());
    if (reply) return String(reply.content);
  }
  return "";
}

// The stream's chunks as { text } / { done } / { error }. `read()` gives the finished reply from the
// history, "" while there is none; it is asked after `silenceMs` without a chunk and when the stream
// ends unfinished. `onEnd` hears how the reply went, for the log.
export async function* replyChunks(stream, read, { silenceMs = 3000, tickMs = 500, onEnd = () => {} } = {}) {
  const it = stream[Symbol.asyncIterator]();
  let got = "", chunks = 0, last = Date.now(), next = it.next();
  const finish = (how) => onEnd({ how, chunks, chars: got.length });
  // what the history has beyond what already reached the phone
  const rest = () => {
    const reply = read();
    if (!reply) return null;
    return reply.startsWith(got) ? reply.slice(got.length) : "";
  };
  for (;;) {
    let timer;
    const tick = new Promise((r) => { timer = setTimeout(() => r(null), tickMs); });
    const r = await Promise.race([next, tick]);
    clearTimeout(timer);
    if (r === null) {
      if (Date.now() - last < silenceMs) continue;
      const more = rest();
      if (more === null) continue;
      if (more) yield { text: more };
      yield { done: true };
      finish("history, the stream went silent");
      next.catch(() => {}); // what it does from here on no longer matters
      it.return?.().catch?.(() => {});
      return;
    }
    if (r.done) break;
    const chunk = r.value;
    chunks++;
    last = Date.now();
    next = it.next();
    if (chunk.error) {
      yield { error: chunk.error };
      finish("error: " + chunk.error);
      return;
    }
    if (chunk.text) {
      got += chunk.text;
      yield { text: chunk.text };
    }
    if (chunk.done) {
      if (!got) {
        // finished with no text at all: the reply is written just after the stream's end
        for (let i = 0; i < 10; i++) {
          const more = rest();
          if (more) {
            yield { text: more };
            yield { done: true };
            finish("history, the stream had no text");
            return;
          }
          await new Promise((res) => setTimeout(res, 200));
        }
      }
      yield { done: true };
      finish("stream");
      return;
    }
  }
  const more = rest();
  if (more !== null) {
    if (more) yield { text: more };
    yield { done: true };
    finish("history, the stream ended early");
    return;
  }
  yield { error: "Ответ Astra прервался до завершения. Проверь соединение и повтори запрос." };
  finish("the stream ended early, no reply in the history");
}
