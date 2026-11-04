import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual generator with a fake recorder and chat stream, without starting the plugin.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function* chatAloud('), source.indexOf('\nconst QUIET ='));
function makeChatAloud(pc, chat) {
  return new Function('pc', 'chat', 'config', 'quietOnPc', 'loudAgain', 'console',
    `let voiceTurn = 0; ${body}; return chatAloud;`)(
    pc, chat, () => ({ voice_quiet_pc: false }), async () => null, async () => {}, { warn() {} });
}

test('capture failure does not discard the delayed chat response', async () => {
  let stopped = false;
  const pc = { VOICE_RATE: 24000, voiceStart: async () => {},
    voiceRead: async () => ({ error: '0x80070002' }), voiceStop: async () => { stopped = true; } };
  async function* chat() {
    await new Promise(resolve => setTimeout(resolve, 500));
    yield { text: 'Ответ Astra' };
    yield { done: true };
  }
  const chunks = [];
  for await (const chunk of makeChatAloud(pc, chat)('вопрос', false)) chunks.push(chunk);
  assert.ok(chunks.some(chunk => chunk.text === 'Ответ Astra'));
  assert.ok(chunks.some(chunk => chunk.done));
  assert.deepEqual(chunks.at(-1), { voiceEnd: true, heard: false });
  assert.ok(!chunks.some(chunk => chunk.error));
  assert.ok(stopped);
});

test('recorder startup failure falls back to text chat', async () => {
  const pc = { voiceStart: async () => { throw new Error('0x80070002'); } };
  async function* chat(_text, _fresh, aloud) {
    assert.equal(aloud, undefined);
    yield { text: 'Ответ Astra' };
    yield { done: true };
  }
  const chunks = [];
  for await (const chunk of makeChatAloud(pc, chat)('вопрос', false)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ text: 'Ответ Astra' }, { done: true }]);
});
