// The server with fake Astra deps, for server.test.mjs. The "owner" allows every pairing request
// after a moment, as if pressing "Allow" on the plugin page.
import { createServer, certFingerprint } from "../src/server.js";
import * as store from "../src/store.js";
import * as pc from "../src/pc.js";

await pc.ensureCertificate(store.PFX, store.tlsPass());
store.setButton(1, { label: "Test button" });
const cfg = {
  allow_chat: true, allow_screenshot: true, allow_power: true, allow_shutdown: process.env.AR_SHUTDOWN === "1", confirm_shutdown: true,
  allow_files: true, shared_folder: process.env.AR_SHARED, max_upload_mb: 1, allow_clipboard: true, allow_open_url: true, allow_input: true, allow_launch: true, key_days: 90
};
const server = createServer({
  config: () => cfg,
  fireButton: async () => {},
  chat: async function* (text) { yield { text: "echo: " + text }; yield { done: true }; },
  onChange: () => {},
  confirm: async () => false // the owner at the PC says no: a test must never really shut the machine down
});
setInterval(() => {
  for (const r of store.pairState()?.requests || []) {
    store.answerPairing(r.id, r.name !== "Intruder");
  }
}, 200);
server.listen(0, "127.0.0.1", () => console.log(`READY ${server.address().port} ${store.startPairing().secret} ${certFingerprint()}`));
