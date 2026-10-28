// Phone Remote page. Talks to the plugin through window.astra.callBackend(method, params) and polls
// getState every couple of seconds, so a phone asking to pair shows up here without a reload.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const call = (m, p = {}) => window.astra.callBackend(m, p);

let state = null;
let qr = ""; // the QR code while pairing is open

const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "только что";
  if (s < 3600) return Math.round(s / 60) + " мин назад";
  if (s < 86400) return Math.round(s / 3600) + " ч назад";
  return new Date(iso).toLocaleDateString();
};

// Astra's plugin pages run in a frame where alert/confirm/prompt are blocked (confirm() just says
// "Cancel"), so the page asks and reports inline instead.
function flash(text) {
  let t = $("#flash");
  if (!t) {
    t = document.createElement("div");
    t.id = "flash";
    t.className = "status bad";
    t.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:10";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { t.hidden = true; }, 5000);
}

// first click turns the button into "are you sure?", a second one within 4 s does it
function twoStep(btn, question, action) {
  btn.onclick = async () => {
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      await action();
      return;
    }
    const label = btn.textContent;
    btn.dataset.armed = "1";
    btn.textContent = question;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = label; } }, 4000);
  };
}

function setHtml(el, html) {
  if (el.dataset.html === html) return false;
  el.dataset.html = html;
  el.innerHTML = html;
  return true;
}

async function load() {
  try {
    state = await call("getState");
  } catch (e) {
    $("#server").innerHTML = `<div class="status bad">Плагин не отвечает: ${esc(e.message || e)}</div>`;
    return;
  }
  if (!state.pairing) qr = "";
  paint();
}

function paint() {
  paintServer();
  paintRelay();
  paintPair();
  paintRequests();
  paintDevices();
  paintButtons();
  paintLog();
}

// Away from home: the relay (on by default), or Tailscale; say what works and what is missing
function remoteHint(s, addrs) {
  const r = s.relay;
  const awake = s.config?.keep_awake ? "ПК не уходит в сон, пока подключён телефон."
    : "Чтобы ПК был доступен, он не должен спать: включи «Не уходить в сон, пока подключён телефон» в настройках плагина.";
  if (r && r.status === "online") {
    return `<div class="status ok" style="margin-top:8px"><b>Вне дома</b>: работает через ретранслятор (${esc(r.url.replace(/^wss:\/\//, ""))}) — телефон достаёт ПК откуда угодно, без Tailscale и открытых портов. ${awake}</div>`;
  }
  if (r) {
    return `<div class="status warn" style="margin-top:8px"><b>Вне дома</b>: ретранслятор ${r.status === "connecting" ? "подключается…" : "недоступен"}${r.error ? ` — ${esc(r.error)}` : ""}. Дома телефон работает и без него.</div>`;
  }
  const ts = addrs.find((a) => a.tailscale);
  return ts
    ? `<div class="status ok" style="margin-top:8px"><b>Вне дома</b>: через Tailscale (${esc(ts.address)}). ${awake}</div>`
    : '<div class="status warn" style="margin-top:8px"><b>Вне дома</b>: выключено — разверни свой ретранслятор (карточка ниже), и телефон будет работать откуда угодно.</div>';
}

// ── the relay card: each user runs their own (relay/README.md) ──────────────
const DEPLOY = "https://deploy.workers.cloudflare.com/?url=https://github.com/FluffyTaill/astra-remote";
function paintRelay() {
  const box = $("#relayCard");
  if (!box) return;
  const r = state.relay;
  const status = !r ? '<span class="muted">не настроен — вне дома телефон не достанет ПК</span>'
    : r.status === "online" ? '<b style="color:var(--ok,#a6cf8a)">работает</b>'
    : `<b style="color:var(--warn,#f1c95b)">${r.status === "connecting" ? "подключается…" : "недоступен"}</b>${r.error ? ` <span class="muted">— ${esc(r.error)}</span>` : ""}`;
  if (!setHtml(box, `<h2>Вне дома: свой ретранслятор</h2>
    <p class="muted" style="margin:0 0 10px">Чтобы телефон доставал ПК откуда угодно (без Tailscale и открытых портов), нужен ретранслятор —
      свой у каждого, бесплатно на Cloudflare. Он только передаёт данные: внутри та же защищённая связь с ПК.</p>
    <ol class="muted" style="margin:0 0 10px;padding-left:18px">
      <li>Нажми «Развернуть на Cloudflare», войди в Cloudflare (или заведи бесплатный аккаунт) и подтверди.</li>
      <li>Скопируй адрес ретранслятора (<code>https://astra-remote-relay.…workers.dev</code>) сюда и нажми «Сохранить».</li>
      <li>Открой приложение на телефоне дома — оно само узнает адрес.</li></ol>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn" id="relayDeploy">Развернуть на Cloudflare</button>
      <input id="relayUrl" style="flex:1;min-width:240px" placeholder="https://astra-remote-relay.имя.workers.dev" value="${esc((r?.url || "").replace(/^wss:/, "https:"))}">
      <button class="btn primary" id="relaySave">Сохранить</button></div>
    <p style="margin:10px 0 0">Сейчас: ${status}</p>
    <p class="muted" style="margin:6px 0 0;font-size:12px">Номер этого ПК: <code>${esc(state.relayId || "")}</code> — чтобы закрыть ретранслятор для чужих, впиши его в секрет ALLOWED_PCS (подробно — в relay/README.md).</p>`)) return;
  // the page lives in Astra's sandboxed frame, where a link cannot open a window: the plugin opens it in the browser
  $("#relayDeploy").onclick = () => call("openUrl", { url: DEPLOY }).catch((e) => flash(e.message || String(e)));
  $("#relaySave").onclick = async () => {
    try {
      state = await call("setRelay", { url: $("#relayUrl").value });
      paint();
      flash($("#relayUrl").value.trim() ? "Сохранено — ПК подключается к ретранслятору" : "Ретранслятор выключен");
    } catch (e) {
      flash(e.message || String(e));
    }
  };
}

function paintServer() {
  const s = state;
  const addrs = s.addresses || [];
  setHtml($("#server"), s.serverError
    ? `<div class="status bad">${esc(s.serverError)}</div>`
    : s.port
      ? `<div class="status ok">Работает на порту <b>${s.port}</b> (HTTPS) · ${addrs.map((a) => `${esc(a.address)}${a.tailscale ? " (Tailscale)" : ""}`).join(", ") || "нет сети"}. Если приложение не подключается, разреши Node.js в брандмауэре Windows.</div>${remoteHint(s, addrs)}`
      : '<div class="status warn">Сервер запускается…</div>');
  const ctl = $("#pairControls");
  if (setHtml(ctl, qr ? '<button class="btn" id="cancel">Отменить</button>' : `<button class="btn primary" id="start" ${s.port && addrs.length ? "" : "disabled"}>Подключить телефон</button>`)) {
    if ($("#start")) $("#start").onclick = async () => {
      try {
        const r = await call("startPairing");
        state = r;
        qr = r.qr;
        paint();
      } catch (e) {
        flash(e.message || String(e));
      }
    };
    if ($("#cancel")) $("#cancel").onclick = async () => { qr = ""; state = await call("cancelPairing"); paint(); };
  }
}

function paintPair() {
  const box = $("#pairBox");
  if (!qr || !state.pairing) return setHtml(box, "");
  setHtml(box, `<div class="pair"><div class="qr">${qr}</div><div>
      <p style="margin:0 0 8px">В приложении <b>Phone Remote</b> на телефоне нажми «Сканировать QR-код» и наведи камеру сюда.</p>
      <p class="muted" style="margin:0 0 8px">Затем здесь появится запрос с кодом из 4 цифр — разреши его, только если такой же код на экране твоего телефона.</p>
      <p class="muted" style="margin:0">QR-код действует ещё <span id="left"></span> и подходит для одного телефона.</p>
    </div></div>`);
  const left = Math.max(0, Math.round((state.pairing.until - Date.now()) / 1000));
  $("#left").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function paintRequests() {
  const list = state.pairing?.requests || [];
  const box = $("#requests");
  if (setHtml(box, list.map((r) => `<div class="req">
      <div><div class="muted" style="font-size:12.5px">Запрос на подключение</div><b>${esc(r.name)}</b> <span class="muted">· ${esc(r.ip)}</span></div>
      <div class="check">${esc(r.check)}</div>
      <span style="flex:1"></span>
      <button class="btn primary" data-allow="${r.id}">Разрешить</button>
      <button class="btn danger" data-deny="${r.id}">Отклонить</button></div>`).join(""))) {
    // the 4-digit code is right next to the button: comparing it with the phone is the confirmation
    box.querySelectorAll("[data-allow],[data-deny]").forEach((b) => b.onclick = async () => {
      const allow = !!b.dataset.allow;
      const id = b.dataset.allow || b.dataset.deny;
      try {
        state = await call("answerPairing", { id, allow });
        if (allow) qr = "";
        paint();
      } catch (e) {
        flash(e.message || String(e));
      }
    });
  }
}

function paintDevices() {
  const list = state.devices || [];
  const box = $("#devices");
  const html = list.length
    ? `<table><thead><tr><th>Имя</th><th>Последний раз</th><th>Адрес</th><th></th></tr></thead><tbody>${list.map((d) => `
        <tr><td><b>${esc(d.name)}</b><div class="muted" style="font-size:12px">с ${new Date(d.created).toLocaleDateString()}${d.expires ? ` · ключ до ${new Date(d.expires).toLocaleDateString()}` : ""}</div></td>
        <td>${ago(d.lastSeen)}</td><td class="muted">${esc(d.lastIp)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn small" data-rename="${d.id}">Переименовать</button> <button class="btn small danger" data-revoke="${d.id}">Отключить</button></td></tr>`).join("")}</tbody></table>`
    : '<p class="muted" style="margin:0">Пока ни одного. Нажми «Подключить телефон».</p>';
  if (setHtml($("#folder"), state.folder ? `<p class="muted" style="margin:10px 0 0">Общая папка для файлов: <b>${esc(state.folder)}</b> — с телефона файлы приходят в «С телефона», Astra кладёт файлы для телефона в «Для телефона».
      <button class="btn small" id="openFolder" style="margin-left:6px">Открыть папку</button></p>` : "") && $("#openFolder")) {
    $("#openFolder").onclick = () => call("openFolder").catch((e) => flash(e.message || String(e)));
  }
  if (!setHtml(box, html)) return;
  box.querySelectorAll("[data-revoke]").forEach((b) => twoStep(b, "Точно отключить?", async () => {
    state = await call("revoke", { id: b.dataset.revoke });
    paint();
  }));
  box.querySelectorAll("[data-rename]").forEach((b) => b.onclick = () => {
    const d = list.find((x) => x.id === b.dataset.rename);
    const cell = b.closest("tr").querySelector("td b");
    const input = document.createElement("input");
    input.value = d.name;
    input.maxLength = 40;
    input.style.cssText = "font:inherit;width:160px";
    cell.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== d.name) state = await call("updateDevice", { id: d.id, patch: { name } });
      box.dataset.html = ""; // force a repaint of the list
      paint();
    };
    input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
    input.onblur = () => finish(true);
  });
}

function paintButtons() {
  const body = $("#buttons");
  const list = state.buttons || [];
  // the inputs are drawn once; later polls only update the command badges, so typing is never interrupted
  if (body.children.length !== list.length) {
    body.innerHTML = list.map((b) => `<tr data-n="${b.n}">
      <td class="muted">${b.n}</td>
      <td><input type="text" class="emoji" maxlength="4" value="${esc(b.icon)}" placeholder="★"></td>
      <td><input type="text" class="label" maxlength="30" value="${esc(b.label)}" placeholder="не показывается"></td>
      <td><span class="badge"></span></td>
      <td style="text-align:right"><button class="btn small" data-test>Проверить</button></td></tr>`).join("");
    body.querySelectorAll("tr").forEach((tr) => {
      const n = Number(tr.dataset.n);
      const save = async () => {
        state = await call("setButton", { n, patch: { icon: tr.querySelector(".emoji").value.trim(), label: tr.querySelector(".label").value.trim() } });
      };
      tr.querySelectorAll("input").forEach((i) => { i.onchange = save; });
      tr.querySelector("[data-test]").onclick = async (e) => {
        const btn = e.currentTarget;
        btn.textContent = "…";
        try { await call("testButton", { n }); btn.textContent = "Сработало"; } catch (err) { btn.textContent = "Ошибка"; flash(err.message || String(err)); }
        setTimeout(() => { btn.textContent = "Проверить"; }, 1600);
      };
    });
  }
  for (const b of list) {
    const badge = body.querySelector(`tr[data-n="${b.n}"] .badge`);
    badge.className = "badge " + (b.bound ? "on" : "off");
    badge.textContent = b.bound ? "привязана" : "нет команды";
  }
}

function paintLog() {
  const list = state.actions || [];
  setHtml($("#log"), list.length
    ? `<table><tbody>${list.map((a) => `<tr><td class="muted" style="width:150px">${new Date(a.at).toLocaleString()}</td><td>${esc(a.device)}</td><td>${esc(a.action)}</td><td>${a.ok ? "" : "ошибка"}</td></tr>`).join("")}</tbody></table>`
    : '<p class="muted" style="margin:0">Пусто.</p>');
}

load();
setInterval(() => { if (!document.hidden) load(); }, 2000);
setInterval(() => { if (qr && state?.pairing) paintPair(); }, 1000);
