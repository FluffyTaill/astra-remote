/* Allowed files, running applications, phone-confirmed power and precise remote screen. */
(function (root) {
  // Coordinate mapping uses the DISPLAYED frame, never the next frame's requested viewport.
  function framePoint(frame, box, naturalWidth, naturalHeight, x, y) {
    if (!frame || !naturalWidth || !naturalHeight || !box.width || !box.height) return null;
    const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const width = naturalWidth * scale, height = naturalHeight * scale;
    const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
    const fx = (x - left) / width, fy = (y - top) / height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return ["p", frame.screen, Math.round((frame.rect[0] + fx * frame.rect[2]) * 10000), Math.round((frame.rect[1] + fy * frame.rect[3]) * 10000)];
  }
  const tools = { active: false, generation: 0, timer: null, screen: false };
  function close() {
    tools.active = false; tools.generation++; clearInterval(tools.timer); tools.timer = null;
    if (tools.screen) { padStop(); tools.screen = false; try { AR.remoteScreen(false); } catch {} }
    $("#layer").innerHTML = "";
  }
  function panel(title, body, screen = false) {
    close(); tools.active = true; tools.screen = screen;
    $("#layer").innerHTML = `<section class="remote-panel ${screen ? "remote-screen" : ""}" aria-label="${esc(title)}"><div class="remote-head"><button class="icon-btn" id="remoteClose" aria-label="Закрыть">${ICON.close}</button><h2>${esc(title)}</h2><span id="remoteStatus" class="hint" role="status"></span></div>${body}</section>`;
    $("#remoteClose").onclick = close;
    return tools.generation;
  }
  const valid = (generation) => tools.active && tools.generation === generation;
  function error(container, e) { if (container) container.innerHTML = `<p class="hint" role="alert">${esc(e.message || String(e))}</p>`; }

  const previousFiles = root.__files;
  root.__files = (event) => {
    if (previousFiles) previousFiles(event);
    const host = $("#libraryDownload");
    if (!host || !String(event.kind).startsWith("down")) return;
    host.textContent = event.kind === "downDone" ? "Сохранено: " + event.name : event.kind === "downError" ? event.info : "Скачиваю «" + event.name + "»: " + fmtSize(event.done) + (event.total > 0 ? " / " + fmtSize(event.total) : "");
    if (event.kind === "downDone" && event.info) {
      const actions = document.createElement("div"); actions.className = "remote-actions";
      for (const [label, handler] of [["Открыть", () => AR.openDownloaded(event.info)], ["Отправить…", () => AR.shareDownloaded(event.info)]]) {
        const button = document.createElement("button"); button.className = "btn"; button.textContent = label; button.onclick = handler; actions.appendChild(button);
      }
      host.appendChild(actions);
    }
  };

  async function openLibrary() {
    const generation = panel("Найти на ПК", `<div class="remote-body"><p class="hint">Только папки, разрешённые владельцем ПК. Файлы нельзя изменить или удалить.</p><select id="libraryRoot" aria-label="Разрешённая папка"></select><form class="remote-search" id="libraryForm"><input class="field" id="libraryQuery" placeholder="Часть имени файла" maxlength="120" autocomplete="off"><button class="btn primary" type="submit">Найти</button></form><div class="toolbar"><button class="btn" id="libraryBrowse">Содержимое папки</button><button class="btn" id="libraryUp">Выше</button></div><p class="hint" id="libraryPath"></p><div class="remote-note" id="libraryDownload" aria-live="polite">Скачанные файлы появятся в «Загрузки / Astra Remote».</div><div id="libraryResults" aria-live="polite">Загружаю папки…</div></div>`);
    let path = "", request = 0;
    const result = $("#libraryResults"), select = $("#libraryRoot");
    async function load(search) {
      const current = ++request, id = select.value;
      if (!id) return;
      result.textContent = search ? "Ищу файлы…" : "Загружаю…";
      try {
        const query = $("#libraryQuery").value.trim();
        if (search && query.length < 2) throw new Error("Введи хотя бы два символа имени");
        const url = search ? `/api/library/search?root=${encodeURIComponent(id)}&q=${encodeURIComponent(query)}` : `/api/library/list?root=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`;
        const listing = await getJson(url);
        if (!valid(generation) || current !== request) return;
        $("#libraryPath").textContent = search ? "Результаты поиска" : path || "Корень папки";
        const items = listing.items || [];
        result.innerHTML = `${listing.truncated ? '<div class="remote-note">Поиск ограничен по времени или количеству файлов. Уточни название или выбери папку глубже.</div>' : ""}${items.length ? items.map((item, i) => fileRow(item, i)).join("") : '<p class="hint">Ничего не найдено.</p>'}`;
        result.querySelectorAll("[data-i]").forEach((button) => button.onclick = () => {
          const item = items[Number(button.dataset.i)], relative = item.path || (path ? path + "/" : "") + item.name;
          if (item.dir) { path = relative; load(false); return; }
          if (item.size > 200 * 1048576 && !confirm(`Скачать «${item.name}» (${fmtSize(item.size)})?`)) return;
          AR.downloadAllowed(id, relative, item.name); toast("Скачиваю в «Загрузки / Astra Remote»");
        });
      } catch (e) { if (valid(generation) && current === request) error(result, e); }
    }
    $("#libraryForm").onsubmit = (event) => { event.preventDefault(); load(true); };
    $("#libraryBrowse").onclick = () => load(false);
    $("#libraryUp").onclick = () => { path = path.split("/").slice(0, -1).join("/"); load(false); };
    select.onchange = () => { path = ""; load(false); };
    try {
      const data = await getJson("/api/library/roots");
      if (!valid(generation)) return;
      select.innerHTML = data.roots.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
      if (!data.roots.length) { result.textContent = "На ПК не заданы папки. Добавь их в настройках плагина → «Папки для поиска»."; return; }
      load(false);
    } catch (e) { if (valid(generation)) error(result, e); }
  }

  async function openTasks() {
    const generation = panel("Работающие программы", `<div class="remote-body"><div class="toolbar"><button class="btn" id="taskReload">Обновить</button><button class="btn" id="taskScreen">Экран ПК</button></div><p class="hint">Штатное закрытие может показать диалог сохранения на ПК. Принудительное завершение теряет несохранённые данные.</p><div id="taskList" aria-live="polite">Загружаю…</div></div>`);
    let busy = false;
    async function load() {
      if (busy || !valid(generation) || document.hidden) return;
      busy = true;
      try {
        const data = await getJson("/api/tasks"); if (!valid(generation)) return;
        const list = $("#taskList");
        list.innerHTML = data.tasks.length ? data.tasks.map((item, i) => `<article class="remote-app"><strong>${esc(item.name)}</strong><div class="hint">${esc(item.title || "Без заголовка")} · ${fmtSize(item.memory)} · PID ${item.pid}</div><div class="remote-actions"><button class="btn" data-task="${i}" data-action="activate">Переключить</button><button class="btn" data-task="${i}" data-action="close">Закрыть</button><button class="btn danger" data-task="${i}" data-action="kill">Завершить</button>${state?.allow?.remote_shutdown ? `<button class="btn" data-task="${i}" data-action="shutdown">Выключить после выхода</button>` : ""}</div></article>`).join("") : '<p class="hint">Доступных пользовательских окон нет. Системные и защищённые процессы не показываются.</p>';
        list.querySelectorAll("[data-task]").forEach((button) => button.onclick = async () => {
          const target = data.tasks[Number(button.dataset.task)], action = button.dataset.action;
          button.disabled = true;
          try {
            if (action === "shutdown") { await confirmPower("process", target); if (valid(generation)) openPower(); return; }
            if (action === "kill") {
              const prepared = await post("/api/tasks/prepare", { target });
              if (!valid(generation) || !confirm(`Принудительно завершить «${prepared.name}»?\n\nНесохранённые данные будут потеряны. Это не обычное закрытие окна.`)) return;
              await post("/api/tasks/action", { action, challenge: prepared.challenge });
            } else {
              if (action === "close" && !confirm(`Попросить «${target.name}» закрыться? Диалог сохранения может остаться на ПК.`)) return;
              await post("/api/tasks/action", { action, target });
            }
            toast(action === "activate" ? "Окно переключено" : action === "close" ? "Запрос закрытия отправлен" : "Программа завершена");
            await load();
          } catch (e) { toast(e.message); }
          finally { if (button.isConnected) button.disabled = false; }
        });
      } catch (e) { if (valid(generation)) error($("#taskList"), e); }
      finally { busy = false; }
    }
    $("#taskReload").onclick = load; $("#taskScreen").onclick = openScreen;
    load(); tools.timer = setInterval(load, 5000);
  }

  async function confirmPower(mode, target) {
    const generation = tools.generation;
    const prepared = await post("/api/power/prepare", { mode, target });
    if (!tools.active || tools.generation !== generation) { await post("/api/power/cancel"); return false; }
    const question = mode === "process" ? `Выключить ПК после выхода «${target.name}»?\n\nВыход не означает успешное завершение задачи. После выхода будет 30 секунд на отмену. Задание продолжит работать без телефона.` : "Выключить этот ПК?\n\nПосле подтверждения начнётся отсчёт 30 секунд. Его можно отменить с телефона. Подтверждение у компьютера не потребуется.";
    if (!confirm(question + "\n\nНесохранённые документы могут остановить выключение.")) { await post("/api/power/cancel"); return false; }
    await post("/api/power/commit", { challenge: prepared.challenge }); return true;
  }
  async function openPower() {
    const generation = panel("Выключение ПК", `<div class="remote-body"><div class="remote-note">Новый режим требует отдельного разрешения в настройках плагина на ПК. Без принудительного закрытия документов.</div><button class="btn danger wide" id="shutdownNow">Выключить ПК…</button><button class="btn wide" id="shutdownAfter" style="margin-top:10px">После выхода программы…</button><div class="card" style="margin-top:14px"><h2>Текущее задание</h2><div id="powerJob" aria-live="polite">Проверяю…</div><button class="btn wide" id="powerCancel" hidden>Отменить задание</button></div></div>`);
    let busy = false;
    async function load() {
      if (!valid(generation) || busy || document.hidden) return; busy = true;
      try {
        const job = await getJson("/api/power/job"); if (!valid(generation)) return;
        const active = ["requested", "waiting", "countdown", "executing"].includes(job.status);
        $("#powerCancel").hidden = !active || job.status === "executing";
        $("#shutdownNow").disabled = active || !state?.allow?.remote_shutdown;
        $("#shutdownAfter").disabled = active || !state?.allow?.remote_shutdown || !state?.allow?.tasks;
        const labels = { idle: "Заданий нет", requested: "Ожидается подтверждение на телефоне. Можно отменить.", waiting: `Ожидаю выхода «${job.target?.name || "программы"}»`, countdown: "Выключение через " + Math.max(0, Math.ceil(((job.deadline || 0) - Date.now()) / 1000)) + " с", executing: "Отправляю Windows запрос выключения…", submitted: "Запрос выключения отправлен Windows. Несохранённые документы могут его остановить.", cancelled: "Задание отменено", error: "Не удалось выполнить: " + (job.error || "неизвестная ошибка") };
        $("#powerJob").textContent = labels[job.status] || "Заданий нет";
      } catch (e) { if (valid(generation)) error($("#powerJob"), e); }
      finally { busy = false; }
    }
    $("#shutdownNow").onclick = async () => { try { await confirmPower("now"); load(); } catch (e) { toast(e.message); } };
    $("#shutdownAfter").onclick = openTasks;
    $("#powerCancel").onclick = async () => { try { await post("/api/power/cancel"); load(); } catch (e) { toast(e.message); } };
    load(); tools.timer = setInterval(load, 1000);
  }

  function openScreen() {
    close(); tab = "screen"; store.set("tab", tab); render();
  }
  async function mountScreen(host) {
    if (state?.allow?.screenshot === false) { host.innerHTML = '<div class="card hint">Разреши просмотр экрана в настройках плагина на ПК.</div>'; return; }
    close(); tools.active = true; tools.screen = true;
    const canInput = state?.allow?.input !== false;
    const count = state?.screens || 1;
    const generation = tools.generation;
    host.innerHTML = `<section class="remote-panel remote-screen remote-embedded" aria-label="Экран"><div class="remote-head"><h2>Экран</h2><button class="chip" id="remoteSave">Сохранить снимок</button></div><div class="remote-controls"><select id="remoteMonitor" aria-label="Монитор"><option value="-1">За курсором</option>${Array.from({ length: count }, (_, i) => `<option value="${i}">Монитор ${i + 1}</option>`).join("")}</select><button class="chip on" id="remoteMode">Тачпад</button><button class="chip" id="remoteZoom">×1</button><button class="chip" id="remoteReset">Весь экран</button><button class="chip" id="remoteKeyboard">Клавиатура</button><span class="hint" id="padConnection">Подключаю…</span></div><div class="remote-stage" id="remoteStage"><img id="remoteImage" alt="Экран выбранного монитора ПК"><div class="remote-wait" id="remoteWait">Получаю экран…</div></div><div class="remote-controls" id="remoteKeys"><button class="chip" data-mod="17">Ctrl</button><button class="chip" data-mod="16">Shift</button><button class="chip" data-mod="18">Alt</button><button class="chip" id="remoteDrag">Тянуть</button><button class="chip" data-key="27">Esc</button><button class="chip" data-key="9">Tab</button><button class="chip" data-key="13">Enter</button><button class="chip" data-key="8">⌫</button><button class="chip" id="remoteRight">Правая</button>${PAD_KEYS.filter(k => ![27, 9, 13, 8].includes(k[1])).map((k, i) => `<button class="chip" data-shortcut="${i}">${esc(k[0])}</button>`).join("")}<button class="chip" data-wheel="120">Прокрутка ↑</button><button class="chip" data-wheel="-120">↓</button><input id="remoteType" aria-label="Печатать на ПК" placeholder="Текст на ПК" autocomplete="off" autocapitalize="off" spellcheck="false"></div><p class="hint remote-help">Экран следует за курсором. Тачпад: один палец — мышь, касание — клик; два — прокрутка, касание двумя — правый клик. Щипок — масштаб.</p></section>`;
    const stage = $("#remoteStage"), image = $("#remoteImage"), points = new Map(), modifiers = new Set();
    let frame = null, mode = "pad", zoom = 1, monitor = -1, drag = false, gesture = null, distance = 0, center = null, revision = 0;
    const adaptive = new AdaptiveScreen(Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1));
    const reset = () => {
      points.clear(); gesture = null; distance = 0; center = null; modifiers.clear(); drag = false;
      $("#remoteKeys")?.querySelectorAll(".on").forEach((button) => button.classList.remove("on"));
    };
    pad.resetGesture = reset;
    if (canInput) pad.start();
    else {
      $("#padConnection").textContent = "Только просмотр — ввод выключен на ПК";
      host.querySelectorAll("#remoteKeys button, #remoteType, #remoteMode, #remoteKeyboard").forEach(el => el.disabled = true);
    }
    $("#remoteSave").onclick = () => { if (frame) AR.saveImage(frame.img); else toast("Дождись кадра"); };
    $("#remoteKeyboard").onclick = () => { const input = $("#remoteType"); input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
    $("#remoteRight").onclick = () => padSend(["b", 1, 0]);
    const shortcuts = PAD_KEYS.filter(k => ![27, 9, 13, 8].includes(k[1]));
    host.querySelectorAll("[data-shortcut]").forEach(button => button.onclick = () => { const k = shortcuts[Number(button.dataset.shortcut)]; padSend(["k", k[1], k[2] || 0]); });
    const release = () => {
      for (const key of modifiers) padSend(["h", key, 0]); modifiers.clear();
      if (drag) padSend(["b", 0, 2]); drag = false;
      $("#remoteKeys").querySelectorAll(".on").forEach((button) => button.classList.remove("on"));
    };
    $("#remoteMonitor").onchange = (event) => { release(); monitor = Number(event.target.value); zoom = 1; frame = null; revision++; };
    $("#remoteMode").onclick = (event) => { release(); mode = mode === "direct" ? "pad" : "direct"; event.target.textContent = mode === "direct" ? "Касание" : "Тачпад"; };
    $("#remoteReset").onclick = () => { zoom = 1; revision++; };
    $("#remoteZoom").onclick = () => { zoom = zoom >= 3.9 ? 1 : Math.min(4, zoom * 2); revision++; };
    $("#remoteKeys").querySelectorAll("[data-mod]").forEach((button) => button.onclick = () => {
      if (!pad.ready) return;
      const key = Number(button.dataset.mod), down = !modifiers.has(key);
      if (down) modifiers.add(key); else modifiers.delete(key);
      button.classList.toggle("on", down); padSend(["h", key, down ? 1 : 0]);
    });
    $("#remoteDrag").onclick = (event) => { if (!pad.ready) return; drag = !drag; event.target.classList.toggle("on", drag); padSend(["b", 0, drag ? 1 : 2]); };
    $("#remoteKeys").querySelectorAll("[data-key]").forEach((button) => button.onclick = () => padSend(["k", Number(button.dataset.key), 0]));
    $("#remoteKeys").querySelectorAll("[data-wheel]").forEach((button) => button.onclick = () => padSend(["w", Number(button.dataset.wheel), 0]));
    const typer = $("#remoteType"); let previous = "​"; typer.value = previous;
    typer.oninput = () => {
      const current = typer.value; let i = 0;
      while (i < previous.length && i < current.length && previous[i] === current[i]) i++;
      for (let n = previous.length - i; n > 0; n--) padSend(["k", 8, 0]);
      const text = current.slice(i).replace(/​/g, ""); if (text) padSend(["t", text]);
      previous = current;
      if (!current.startsWith("​") || current.includes("\n") || current.length > 80) { previous = "​"; typer.value = previous; }
    };
    const point = (x, y) => framePoint(frame, stage.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, x, y);
    stage.onpointerdown = (event) => {
      if (!canInput) return;
      stage.setPointerCapture(event.pointerId); points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size === 1) gesture = { start: Date.now(), moved: 0, multi: false, fingers: 1 };
      if (points.size >= 2 && gesture) { gesture.multi = true; gesture.fingers = Math.max(gesture.fingers, points.size); distance = 0; center = null; }
    };
    stage.onpointermove = (event) => {
      const previous = points.get(event.pointerId); if (!previous) return;
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gesture) gesture.moved += Math.abs(dx) + Math.abs(dy);
      if (points.size >= 2) {
        const pair = [...points.values()].slice(0, 2), d = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        const mid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }, box = stage.getBoundingClientRect();
        if (distance > 0 && d > 0 && Math.abs(d - distance) > 3) zoom = Math.max(1, Math.min(4, zoom * d / distance));
        else if (center && mode === "pad") padSend(["w", Math.round((mid.y - center.y) * 4), Math.round((center.x - mid.x) * 4)]);
        distance = d; center = mid; revision++; return;
      }
      if (gesture?.multi) return;
      if (mode === "pad") padSend(["m", Math.round(dx * 1.6), Math.round(dy * 1.6)]);
      else if (drag) { const mapped = point(event.clientX, event.clientY); if (mapped) padSend(mapped); }

    };
    stage.onpointerup = (event) => {
      if (!points.has(event.pointerId)) return;
      if (points.size === 1 && gesture && gesture.moved < 12 && Date.now() - gesture.start < 350) {
        if (gesture.fingers >= 2) padSend(["b", 1, 0]);
        else if (mode === "direct") { const mapped = point(event.clientX, event.clientY); if (mapped) { padSend(mapped); if (!drag) padSend(["b", 0, 0]); } }
        else if (!drag) padSend(["b", 0, 0]);
      }
      points.delete(event.pointerId); if (!points.size) { gesture = null; distance = 0; center = null; }
    };
    stage.onpointercancel = () => { release(); reset(); };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    while (valid(generation)) {
      if (document.hidden) { await sleep(400); continue; }
      const started = Date.now(), requestedRevision = revision;
      try {
        const profile = adaptive.profile;
        const next = await getJson(`/api/screen/live?screen=${monitor}&zoom=${zoom.toFixed(3)}&w=${profile.width}&q=${profile.quality}`);
        if (!valid(generation)) break;
        // Discard a superseded monitor/crop response; never label it as the new viewport.
        if (requestedRevision !== revision) { await sleep(35); continue; }
        const decoded = new Image(); decoded.src = "data:image/jpeg;base64," + next.img; await decoded.decode();
        if (!valid(generation)) break;
        if (requestedRevision !== revision) continue;
        image.src = decoded.src; frame = next; $("#remoteWait").hidden = true;
        $("#remoteZoom").textContent = "×" + zoom.toFixed(1);
        adaptive.sample(Date.now() - started, next.img.length * 0.75);
      } catch (e) { if (!valid(generation)) break; adaptive.failure(); $("#remoteWait").textContent = e.message; $("#remoteWait").hidden = false; await sleep(1200); }
      await sleep(adaptive.delay(Date.now() - started));
    }
  }
  Object.assign(tools, { close, openLibrary, openTasks, openPower, openScreen, mountScreen, framePoint });
  root.RemoteTools = tools;
})(globalThis);
