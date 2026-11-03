// Shared by the WebView and regression tests. No device key is exposed to JavaScript.
(function (root) {
  class RemoteInput {
    constructor(bridge, { state = () => {}, reset = () => {} } = {}) {
      this.bridge = bridge; this.onState = state; this.onReset = reset;
      this.active = false; this.ready = false; this.queue = []; this.pending = new Map();
      this.generation = 0; this.seq = 0; this.last = 0; this.retry = 0;
    }
    start() {
      this.stop(); this.active = true; this.connect();
      this.timer = setInterval(() => this.flush(), 25);
    }
    connect() {
      if (!this.active) return;
      this.id = "pad-" + Date.now() + "-" + (++this.generation);
      this.connectingAt = Date.now(); this.onState("Подключаю тачпад…");
      this.bridge.inputStart(this.id);
    }
    stop() {
      this.active = this.ready = false;
      clearInterval(this.timer); clearTimeout(this.retryTimer);
      if (this.id) this.bridge.inputStop(this.id);
      this.id = ""; this.queue = []; this.pending.clear(); this.onReset();
    }
    broken() {
      if (!this.active || !this.id) return;
      this.bridge.inputStop(this.id); this.id = ""; this.ready = false;
      this.queue = []; this.pending.clear(); this.onReset();
      this.onState("Восстанавливаю связь…");
      this.retryTimer = setTimeout(() => this.connect(), Math.min(3000, 400 * 2 ** Math.min(3, this.retry++)));
    }
    receive(id, text) {
      if (!this.active || id !== this.id) return;
      let message;
      try { message = JSON.parse(text); } catch { this.broken(); return; }
      if (message.error) { this.broken(); return; }
      if (message.ready) {
        this.ready = true; this.retry = 0; this.queue = [];
        this.onState("Тачпад подключён");
      }
      if (Number.isSafeInteger(message.ack) && message.ack > 0 && message.ack <= this.seq) {
        for (const n of this.pending.keys()) if (n <= message.ack) this.pending.delete(n);
      }
    }
    send(event) {
      // Never replay taps/typing made while the connection was down.
      if (!this.active || !this.ready) return;
      const now = Date.now();
      const previous = this.queue[this.queue.length - 1];
      if (previous && previous.event[0] === event[0] && (event[0] === "m" || event[0] === "w")) {
        previous.event[1] += event[1]; previous.event[2] += event[2]; previous.at = now;
      } else if (previous && event[0] === "t" && previous.event[0] === "t" && previous.event[1].length + event[1].length <= 2000) {
        previous.event[1] += event[1]; previous.at = now;
      } else this.queue.push({ event: event.slice(), at: now });
      if (this.queue.length > 200) this.broken();
    }
    flush() {
      if (!this.active || !this.id) return;
      const now = Date.now();
      if (!this.ready) { if (now - this.connectingAt > 35000) this.broken(); return; }
      const oldest = this.pending.values().next().value;
      if (oldest !== undefined && now - oldest > 2500) { this.broken(); return; }
      if (this.pending.size >= 8 || now - this.last < 25) return;
      // Stale unsent motion is disposable; click/key order is not.
      this.queue = this.queue.filter((entry) => !["m", "w"].includes(entry.event[0]) || now - entry.at <= 250);
      if (!this.queue.length) return;
      const events = this.queue.splice(0, 64).map((entry) => entry.event);
      const seq = ++this.seq;
      if (!this.bridge.inputSend(this.id, JSON.stringify({ seq, events }))) { this.broken(); return; }
      this.pending.set(seq, now); this.last = now;
    }
  }

  class AdaptiveScreen {
    constructor(maxWidth) {
      const max = Math.max(480, Math.min(1280, Math.round(maxWidth)));
      this.profiles = [
        { width: Math.min(max, 480), quality: 35, interval: 200 },
        { width: Math.min(max, 640), quality: 40, interval: 150 },
        { width: Math.min(max, 800), quality: 48, interval: 125 },
        { width: max, quality: 58, interval: 100 }
      ];
      this.level = 1; this.good = 0; this.average = null;
    }
    get profile() { return this.profiles[this.level]; }
    sample(milliseconds, bytes) {
      this.average = this.average === null ? milliseconds : this.average * 0.7 + milliseconds * 0.3;
      if (milliseconds > 650 || this.average > 400 || bytes > 240000) {
        this.level = Math.max(0, this.level - 1); this.good = 0; this.average = null;
      } else if (milliseconds < 160 && bytes < 120000) {
        if (++this.good >= 12) { this.level = Math.min(3, this.level + 1); this.good = 0; }
      } else this.good = 0;
    }
    failure() { this.level = Math.max(0, this.level - 1); this.good = 0; this.average = null; }
    delay(elapsed) {
      // When transfer dominates, leave a little breathing room for input packets.
      const interval = Math.max(this.profile.interval, Math.min(600, (this.average || 0) * 1.15));
      return Math.max(35, interval - elapsed);
    }
  }
  root.RemoteInput = RemoteInput; root.AdaptiveScreen = AdaptiveScreen;
})(globalThis);
