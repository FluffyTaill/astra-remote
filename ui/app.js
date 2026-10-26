// Astra Remote page. Talks to the plugin through window.astra.callBackend(method, params) and polls
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
  paintPair();
  paintRequests();
  paintDevices();
  paintButtons();
  paintLog();
}

function paintServer() {
  const s = state;
  const addrs = s.addresses || [];
  setHtml($("#server"), s.error
    ? `<div class="status bad">${esc(s.error)}</div>`
    : s.port
      ? `<div class="status ok">Работает на порту <b>${s.port}</b> (HTTPS) · ${addrs.map((a) => `${esc(a.address)}${a.tailscale ? " (Tailscale)" : ""}`).join(", ") || "нет сети"}. Если приложение не подключается, разреши Node.js в брандмауэре Windows для частных сетей.</div>`
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
        alert(e.message || e);
      }
    };
    if ($("#cancel")) $("#cancel").onclick = async () => { qr = ""; state = await call("cancelPairing"); paint(); };
  }
}

function paintPair() {
  const box = $("#pairBox");
  if (!qr || !state.pairing) return setHtml(box, "");
  setHtml(box, `<div class="pair"><div class="qr">${qr}</div><div>
      <p style="margin:0 0 8px">В приложении <b>Astra Remote</b> на телефоне нажми «Сканировать QR-код» и наведи камеру сюда.</p>
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
    box.querySelectorAll("[data-allow],[data-deny]").forEach((b) => b.onclick = async () => {
      const allow = !!b.dataset.allow;
      const id = b.dataset.allow || b.dataset.deny;
      if (allow) {
        const r = list.find((x) => x.id === id);
        if (!confirm(`Разрешить «${r.name}» доступ к этому ПК?\n\nНа экране телефона должен быть код ${r.check}. Если кода нет или он другой — нажми «Отмена».`)) return;
      }
      state = await call("answerPairing", { id, allow });
      if (allow) qr = "";
      paint();
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
  setHtml($("#folder"), state.folder ? `<p class="muted" style="margin:10px 0 0">Общая папка для файлов: <b>${esc(state.folder)}</b> — с телефона файлы приходят в «С телефона», Astra кладёт файлы для телефона в «Для телефона».</p>` : "");
  if (!setHtml(box, html)) return;
  box.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => {
    const d = list.find((x) => x.id === b.dataset.revoke);
    if (!confirm(`Отключить «${d.name}»? Ему придётся подключаться заново.`)) return;
    state = await call("revoke", { id: d.id });
    paint();
  });
  box.querySelectorAll("[data-rename]").forEach((b) => b.onclick = async () => {
    const d = list.find((x) => x.id === b.dataset.rename);
    const name = prompt("Имя устройства", d.name);
    if (!name) return;
    state = await call("updateDevice", { id: d.id, patch: { name } });
    paint();
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
        try { await call("testButton", { n }); btn.textContent = "Сработало"; } catch (err) { btn.textContent = "Ошибка"; alert(err.message || err); }
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
