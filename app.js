/* ARGON TV (web): lista M3U, reproductor HLS por el servidor de la PC, favoritos, categorias,
   prueba de canales. Control remoto con flechas / OK / Return / CH+ CH-. */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var PAIS = (params.get("pais") || "pe").toLowerCase().replace(/[^a-z]/g, "");
  var URLS = ["/m3u?pais=" + PAIS, "https://iptv-org.github.io/iptv/countries/" + PAIS + ".m3u", "lista.m3u"];
  var TIMEOUT_MS = 20000;
  var SERVER = false;   // true si la pagina viene del servidor de la PC (con intermediario)
  var BLOQUEADO = /xxx|adult|porn|erotic/i;

  var TABS = [
    { id: "fav", label: "★ Favoritos" },
    { id: "ok", label: "✔ Funcionan" },
    { id: "all", label: "Todos" },
    { id: "kids", label: "Niños", g: ["kids", "animation", "family"] },
    { id: "news", label: "Noticias", g: ["news"] },
    { id: "movies", label: "Películas", g: ["movies", "series"] },
    { id: "music", label: "Música", g: ["music"] },
    { id: "sports", label: "Deportes", g: ["sports", "outdoor"] },
    { id: "other", label: "Otros" },
    { id: "lists", label: "⚙ Mis listas" },
    { id: "test", label: "▶ Probar todos" }
  ];

  var $ = function (id) { return document.getElementById(id); };
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var channels = [], tabs = [], list = [];
  var fav = load("argon_fav", []);
  var res = load("argon_res", {});
  var ti = 0, gi = 0, area = "tabs";
  var playerOpen = false, curIndex = -1, hls = null, timer = null, token = 0, triedNative = false;
  var overlayTimer = null, btnFocus = 0, testing = false, baseStatus = "";
  var ulists = load("argon_lists", []);   // [{id, name, urls:[]}] (se guarda tambien en la PC)
  var seeded = load("argon_seeded", []);  // listas automaticas ya creadas una vez (no se vuelven a crear si las borras)
  var byUrl = {};
  var editingId = null, confirmDel = null, popUrl = null, pendingAdd = null;
  var query = "";   // texto del buscador (normalizado)
  function norm(s) {
    s = String(s || "");
    try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }

  /* ---------- listas personalizadas ---------- */
  function findList(id) { for (var i = 0; i < ulists.length; i++) if (ulists[i].id === id) return ulists[i]; return null; }
  function saveLists() {
    save("argon_lists", ulists); save("argon_seeded", seeded);
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/lists", true);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ lists: ulists, seeded: seeded }));
    } catch (e) {}
  }
  function fetchLists(cb) {
    var x = new XMLHttpRequest();
    x.open("GET", "/lists", true); x.timeout = 8000;
    x.onload = function () {
      try {
        var d = JSON.parse(x.responseText);
        if (d && d.lists) { ulists = d.lists; save("argon_lists", ulists); }
        if (d && d.seeded) { seeded = d.seeded; save("argon_seeded", seeded); }
      } catch (e) {}
      cb();
    };
    x.onerror = x.ontimeout = function () { cb(); };
    x.send();
  }
  function rebuildTabs(goId) {
    var cur = goId || (tabs[ti] && tabs[ti].id);
    buildTabs();
    ti = 0;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === cur) ti = i;
    filterList(); render();
  }

  function setStatus(t) { $("status").textContent = t; }
  function clean(n) {
    var c = n.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, " ").replace(/\s+/g, " ").trim();
    return c || n;
  }
  function matchesDefined(c) {
    return TABS.some(function (t) { return t.g && c.gs.some(function (g) { return t.g.indexOf(g) >= 0; }); });
  }
  function isFav(c) { return fav.indexOf(c.url) >= 0; }

  function buildTabs() {
    var hasOther = channels.some(function (c) { return !matchesDefined(c); });
    tabs = TABS.filter(function (t) {
      if (t.g) return channels.some(function (c) { return c.gs.some(function (g) { return t.g.indexOf(g) >= 0; }); });
      if (t.id === "other") return hasOther;
      return true;
    });
    var mine = ulists.map(function (l) { return { id: "L:" + l.id, label: "≡ " + l.name }; });
    Array.prototype.splice.apply(tabs, [1, 0].concat(mine));
  }

  function filterList() {
    if (query) {
      list = channels.filter(function (c) { return norm(clean(c.name)).indexOf(query) >= 0; });
      if (gi >= list.length) gi = Math.max(0, list.length - 1);
      return;
    }
    var t = tabs[ti];
    if (t.id.indexOf("L:") === 0) {
      var ul = findList(t.id.slice(2));
      list = ul ? ul.urls.map(function (u) { return byUrl[u]; }).filter(Boolean) : [];
      if (gi >= list.length) gi = Math.max(0, list.length - 1);
      return;
    }
    list = channels.filter(function (c) {
      if (t.id === "lists") return false;
      if (t.id === "fav") return isFav(c);
      if (t.id === "ok") return res[c.url] === "ok";
      if (t.id === "all") return true;
      if (t.id === "test") return false;
      if (t.id === "other") return !matchesDefined(c);
      return c.gs.some(function (g) { return t.g.indexOf(g) >= 0; });
    });
    if (gi >= list.length) gi = Math.max(0, list.length - 1);
  }

  function renderTabs() {
    var nav = $("tabs"); nav.innerHTML = "";
    tabs.forEach(function (t, i) {
      var d = document.createElement("div");
      d.className = "tab" + (i === ti ? " active" : "") + (area === "tabs" && i === ti ? " focus" : "");
      d.textContent = t.label;
      nav.appendChild(d);
    });
  }

  function emptyText() {
    var id = tabs[ti].id;
    if (id === "fav") return "Aún no hay favoritos. Entra a 'Todos', abre un canal y elige ★ Favorito.";
    if (id === "ok") return "Todavía no hay canales confirmados. Ve a '▶ Probar todos' y pulsa OK.";
    if (id === "test") return testing
      ? "Probando los canales desde la PC... Pulsa OK para detener."
      : (SERVER ? "Pulsa OK para probar todos los canales desde la PC (tarda unos minutos). Los que respondan quedan en '✔ Funcionan'."
                : "Esta opción necesita la PC encendida con el servidor. Sin PC, cada canal que abras se marca solo con ✔ o ✖.");
    if (id.indexOf("L:") === 0) return "Esta lista está vacía. Ve a 'Todos' (o cualquier pestaña) y pulsa el botón + de un canal para agregarlo aquí.";
    return "No hay canales aquí todavía.";
  }

  function el(tag, cls, text, attrs) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    for (var k in (attrs || {})) d.setAttribute(k, attrs[k]);
    return d;
  }

  function renderManager(box) {
    var m = el("div", "mgr");
    var editing = editingId ? findList(editingId) : null;
    m.appendChild(el("h2", null, editing ? "Cambiar nombre de “" + editing.name + "”" : "Crear una lista nueva"));
    var row = el("div", "mgr-new");
    var inp = el("input", null, null, { id: "lname", maxlength: "40", placeholder: "Nombre de la lista (ej.: Niña)", type: "text" });
    if (editing) inp.value = editing.name;
    row.appendChild(inp);
    row.appendChild(el("button", "mbtn red", editing ? "Guardar nombre" : "+ Crear lista", { "data-m": "save" }));
    if (editing) row.appendChild(el("button", "mbtn", "Cancelar", { "data-m": "cancel" }));
    m.appendChild(row);
    if (pendingAdd && byUrl[pendingAdd]) m.appendChild(el("p", "mgr-hint", "El canal “" + clean(byUrl[pendingAdd].name) + "” se agregará a la lista que crees."));
    m.appendChild(el("h2", null, "Mis listas"));
    if (!ulists.length) m.appendChild(el("p", "mgr-hint", "Todavía no tienes listas."));
    ulists.forEach(function (l) {
      var r = el("div", "mgr-row");
      r.appendChild(el("span", "mgr-name", "≡ " + l.name));
      r.appendChild(el("span", "mgr-count", l.urls.length + (l.urls.length === 1 ? " canal" : " canales")));
      r.appendChild(el("button", "mbtn", "Ver", { "data-m": "see", "data-id": l.id }));
      r.appendChild(el("button", "mbtn", "Renombrar", { "data-m": "ren", "data-id": l.id }));
      r.appendChild(el("button", "mbtn" + (confirmDel === l.id ? " red" : ""), confirmDel === l.id ? "¿Seguro? Sí, borrar" : "Borrar", { "data-m": "del", "data-id": l.id }));
      m.appendChild(r);
    });
    m.appendChild(el("p", "mgr-hint", "Para meter canales en una lista: en cualquier pestaña pulsa el botón + de la tarjeta del canal. " +
      (SERVER ? "Tip: es más cómodo armar las listas desde la PC entrando a http://localhost:8080 (se guardan en la PC y la TV las ve al recargar)."
              : "Las listas se guardan en esta TV.")));
    box.appendChild(m);
  }

  function managerAction(b) {
    var a = b.getAttribute("data-m"), id = b.getAttribute("data-id");
    if (a === "save") {
      var name = ($("lname").value || "").trim().slice(0, 40);
      if (!name) { setStatus("Escribe un nombre para la lista."); $("lname").focus(); return; }
      if (editingId) { var l = findList(editingId); if (l) l.name = name; editingId = null; }
      else {
        var nl = { id: Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: name, urls: [] };
        if (pendingAdd) { nl.urls.push(pendingAdd); pendingAdd = null; }
        ulists.push(nl);
        setStatus("Lista “" + name + "” creada.");
      }
      confirmDel = null; saveLists(); rebuildTabs("lists");
    } else if (a === "cancel") { editingId = null; render(); }
    else if (a === "see") { rebuildTabs("L:" + id); }
    else if (a === "ren") { editingId = id; confirmDel = null; render(); var i = $("lname"); if (i) { i.focus(); i.select(); } }
    else if (a === "del") {
      if (confirmDel !== id) { confirmDel = id; render(); return; }
      ulists = ulists.filter(function (l) { return l.id !== id; });
      confirmDel = null; editingId = null; saveLists(); rebuildTabs("lists");
    }
  }

  /* ventana para elegir en que lista va un canal */
  function openPop(url) { popUrl = url; renderPop(); }
  function closePop() { popUrl = null; var p = $("addpop"); if (p) p.parentNode.removeChild(p); filterList(); render(); }
  function renderPop() {
    var old = $("addpop"); if (old) old.parentNode.removeChild(old);
    var ov = el("div", null, null, { id: "addpop" });
    var bx = el("div", "pop");
    bx.appendChild(el("h2", null, "Agregar “" + clean(byUrl[popUrl] ? byUrl[popUrl].name : "") + "” a:"));
    if (!ulists.length) bx.appendChild(el("p", "mgr-hint", "Todavía no tienes listas."));
    ulists.forEach(function (l) {
      var inl = l.urls.indexOf(popUrl) >= 0;
      bx.appendChild(el("button", "pbtn" + (inl ? " on" : ""), (inl ? "✔ " : "＋ ") + l.name, { "data-pl": l.id }));
    });
    bx.appendChild(el("button", "pbtn", "＋ Crear lista nueva", { "data-pl": "__new" }));
    bx.appendChild(el("button", "pbtn red", "Cerrar", { "data-pl": "__close" }));
    ov.appendChild(bx);
    document.body.appendChild(ov);
  }
  function popAction(id) {
    if (id === "__close") return closePop();
    if (id === "__new") { pendingAdd = popUrl; editingId = null; closePop(); rebuildTabs("lists"); var i = $("lname"); if (i) i.focus(); return; }
    var l = findList(id); if (!l) return;
    var k = l.urls.indexOf(popUrl);
    if (k >= 0) l.urls.splice(k, 1); else l.urls.push(popUrl);
    saveLists(); renderPop();
  }

  function renderGrid() {
    var box = $("grid"); box.innerHTML = "";
    if (!query && tabs[ti].id === "lists") { renderManager(box); return; }
    if (!list.length) {
      var e = document.createElement("div");
      e.className = "empty"; e.textContent = query ? "No encontré canales con “" + $("q").value.trim() + "”." : emptyText();
      box.appendChild(e); return;
    }
    list.forEach(function (c, i) {
      var d = document.createElement("div");
      d.className = "card" + (area === "grid" && i === gi ? " focus" : "");
      var n = document.createElement("div"); n.className = "n"; n.textContent = clean(c.name);
      var g = document.createElement("div"); g.className = "g";
      var l = document.createElement("span");
      var r = document.createElement("span");
      var s = res[c.url];
      r.className = s === "ok" ? "ok" : s === "fail" ? "bad" : "";
      r.textContent = s === "ok" ? "✔ funciona" : s === "fail" ? "✖ no responde" : "";
      var st = document.createElement("span");
      st.className = "favbtn" + (isFav(c) ? " on" : "");
      st.textContent = isFav(c) ? "★" : "☆";
      st.setAttribute("data-i", i);
      var ad = el("span", "addbtn", "+", { "data-i": i });
      g.appendChild(l); g.appendChild(r);
      if (c.logo && /^https?:/i.test(c.logo)) {
        d.className += " haslogo";
        var lb = el("div", "logobox");
        var im = el("img", null, null, { alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        im.onerror = function () { lb.parentNode && lb.parentNode.classList.remove("haslogo"); lb.parentNode && lb.parentNode.removeChild(lb); };
        im.src = c.logo;
        lb.appendChild(im);
        d.appendChild(lb);
      }
      d.appendChild(n); d.appendChild(g); d.appendChild(st); d.appendChild(ad);
      box.appendChild(d);
    });
    var f = box.querySelector(".focus");
    if (f && f.scrollIntoView) { try { f.scrollIntoView({ block: "center" }); } catch (x) { f.scrollIntoView(); } }
  }

  function render() { renderTabs(); renderGrid(); }

  function cols() {
    var cs = $("grid").querySelectorAll(".card");
    if (!cs.length) return 1;
    var top = cs[0].offsetTop, n = 0;
    for (var i = 0; i < cs.length; i++) { if (cs[i].offsetTop === top) n++; else break; }
    return Math.max(1, n);
  }

  /* ---------- prueba de canales (desde la PC) ---------- */
  function startTest() {
    if (!SERVER) { setStatus("“Probar todos” necesita la PC encendida con el servidor de ARGON TV."); return; }
    if (testing) { testing = false; return; }
    testing = true;
    var q = channels.slice(), done = 0, okc = 0, total = q.length, active = 0, N = 4;
    function upd() {
      setStatus("Probando desde la PC: " + done + "/" + total + "   ✔ " + okc + "   ✖ " + (done - okc) + "   (OK para detener)");
    }
    function pump() {
      while (testing && active < N && q.length) {
        (function (c) {
          active++;
          var x = new XMLHttpRequest(), fin_ = false;
          x.open("GET", "/check?u=" + encodeURIComponent(c.url), true);
          x.timeout = 30000;
          function fin(ok) {
            if (fin_) return; fin_ = true;
            active--; done++;
            if (ok) { okc++; res[c.url] = "ok"; } else if (res[c.url] !== "ok") res[c.url] = "fail";
            if (done % 10 === 0) save("argon_res", res);
            upd(); pump();
          }
          x.onload = function () { var ok = false; try { ok = JSON.parse(x.responseText).ok; } catch (e) {} fin(ok); };
          x.onerror = x.ontimeout = function () { fin(false); };
          x.send();
        })(q.shift());
      }
      if (active === 0) {
        testing = false; save("argon_res", res);
        setStatus("Prueba terminada: " + okc + " de " + done + " canales responden. Míralos en '✔ Funcionan'.");
        filterList(); render();
      }
    }
    upd(); render(); pump();
  }

  /* ---------- reproductor ---------- */
  var inZone = false;   // el puntero esta en la parte de abajo de la pantalla
  function hideLater(ms) {
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { if (!inZone) $("overlay").classList.add("hide"); }, ms);
  }
  function showOverlay(ms) {
    $("overlay").classList.remove("hide");
    if (inZone) { clearTimeout(overlayTimer); return; }   // se queda mientras el puntero este abajo
    hideLater(ms || 3000);
  }
  function overlayHidden() { return $("overlay").classList.contains("hide"); }
  function setMsg(t) { $("pmsg").textContent = t; }
  function renderBtns() {
    var bs = $("pbtns").querySelectorAll("button");
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("focus", i === btnFocus);
    $("bfav").textContent = (curIndex >= 0 && isFav(list[curIndex])) ? "★ Quitar de favoritos" : "★ Favorito";
  }

  function mark(my, value, msg) {
    if (my !== token || !playerOpen) return;
    clearTimeout(timer);
    var url = list[curIndex].url;
    if (value === "ok" || res[url] !== "ok") res[url] = value;
    save("argon_res", res);
    setMsg(value === "ok" ? "En vivo" : "Este canal no responde" + (msg ? " (" + msg + ")" : ""));
    if (value === "fail") showOverlay(5000);
  }

  function stopMedia() {
    token++; clearTimeout(timer);
    var v = $("video");
    try { if (hls) hls.destroy(); } catch (e) {}
    hls = null;
    try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
  }

  function native(src) {
    var v = $("video");
    triedNative = true;
    v.src = src;
    var p = v.play(); if (p && p.catch) p.catch(function () {});
  }

  function startPlay() {
    stopMedia();
    var my = token, ch = list[curIndex], v = $("video");
    var src = SERVER ? "/p?u=" + encodeURIComponent(ch.url) : ch.url;
    // sin PC en una pagina https: los canales http:// se bloquean; se intenta su version https://
    if (!SERVER && location.protocol === "https:" && /^http:/i.test(src)) src = src.replace(/^http:/i, "https:");
    triedNative = false;
    $("pname").textContent = clean(ch.name);
    setMsg("Cargando...");
    renderBtns(); showOverlay();
    timer = setTimeout(function () { mark(my, "fail", "sin respuesta" + pista()); }, TIMEOUT_MS);
    v.onplaying = function () { mark(my, "ok"); };
    var canNative = !!v.canPlayType("application/vnd.apple.mpegurl");
    var hlsOk = !!(window.Hls && Hls.isSupported());

    function viaHls() {
      hls = new Hls({ maxBufferLength: 20, manifestLoadingTimeOut: 10000, levelLoadingTimeOut: 10000, fragLoadingTimeOut: 15000 });
      hls.on(Hls.Events.MANIFEST_PARSED, function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); });
      hls.on(Hls.Events.ERROR, function (ev, d) {
        if (!d.fatal || my !== token) return;
        if (SERVER && !triedNative && canNative) {
          try { hls.destroy(); } catch (e) {} hls = null; native(src);
        } else mark(my, "fail", d.details + (d.response && d.response.code ? " " + d.response.code : "") + pista());
      });
      hls.loadSource(src);
      hls.attachMedia(v);
    }

    if (SERVER) {
      v.onerror = function () { mark(my, "fail", "video " + (v.error ? v.error.code : "")); };
      if (hlsOk) viaHls(); else if (canNative) native(src); else mark(my, "fail", "este navegador no reproduce HLS");
    } else {
      // sin PC: el reproductor propio de la TV no necesita permisos CORS; si falla, se intenta con hls.js
      v.onerror = function () {
        if (my !== token) return;
        if (hlsOk && !hls) { v.removeAttribute("src"); viaHls(); }
        else mark(my, "fail", "video " + (v.error ? v.error.code : "") + pista());
      };
      if (canNative) native(src); else if (hlsOk) viaHls(); else mark(my, "fail", "este navegador no reproduce HLS");
    }

    function pista() {
      if (SERVER) return "";
      if (location.protocol === "https:" && /^http:/i.test(ch.url)) return " · se intentó con https y no funcionó: este canal solo abre con la PC encendida";
      return " · puede que solo abra con la PC encendida";
    }
  }

  var wasFull = false;
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function goFull() {
    var el = $("player");
    var f = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!f) return;
    try { var p = f.call(el); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function leaveFull() {
    var d = document, ex = d.exitFullscreen || d.webkitExitFullscreen;
    if (ex && fsEl()) { try { var p = ex.call(d); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  var manualExit = false;
  function toggleFull() {
    if (fsEl()) { manualExit = true; leaveFull(); } else goFull();
  }
  function onFsChange() {
    var b = $("bfull"); if (b) b.textContent = fsEl() ? "⛶ Salir de pantalla completa" : "⛶ Pantalla completa";
    if (fsEl()) { wasFull = true; return; }
    if (manualExit) { manualExit = false; wasFull = false; return; }
    // salio de pantalla completa (por ejemplo con el boton Return): cerrar tambien el reproductor
    if (wasFull && playerOpen) { wasFull = false; closePlayer(); } else wasFull = false;
  }
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  function openPlayer(i) {
    curIndex = i; playerOpen = true; btnFocus = 1; inZone = false;
    $("player").hidden = false;
    goFull();
    try { history.pushState({ p: 1 }, "", "#play"); } catch (e) {}
    startPlay();
  }
  function closeInternal() {
    if (!playerOpen) return;
    playerOpen = false; stopMedia(); wasFull = false; leaveFull();
    $("player").hidden = true;
    area = "grid"; gi = Math.max(0, curIndex);
    render();
  }
  function closePlayer() {
    if (location.hash === "#play") { try { history.back(); return; } catch (e) {} }
    closeInternal();
  }
  window.addEventListener("popstate", function () { if (playerOpen) closeInternal(); });

  function toggleFavUrl(url) {
    var i = fav.indexOf(url);
    if (i >= 0) fav.splice(i, 1); else fav.push(url);
    save("argon_fav", fav);
  }
  function toggleFav() { toggleFavUrl(list[curIndex].url); renderBtns(); }

  function zap(dir) {
    if (!list.length) return;
    curIndex = (curIndex + dir + list.length) % list.length;
    startPlay();
  }

  function playerKey(e) {
    var k = e.key, c = e.keyCode;
    if (c === 10009 || k === "Escape" || k === "Backspace" || c === 8 || c === 27) { closePlayer(); e.preventDefault(); return; }
    // cambiar de canal: CH+/CH- (427/428), PageUp/PageDown, pista siguiente/anterior, y flechas arriba/abajo
    // DERECHA = canal siguiente, IZQUIERDA = canal anterior (tambien CH+/CH-, PageUp/PageDown)
    if (c === 427 || c === 33 || c === 176 || k === "ChannelUp" || k === "PageUp" || k === "MediaTrackNext" || k === "ArrowRight" || c === 39) { zap(1); e.preventDefault(); return; }
    if (c === 428 || c === 34 || c === 177 || k === "ChannelDown" || k === "PageDown" || k === "MediaTrackPrevious" || k === "ArrowLeft" || c === 37) { zap(-1); e.preventDefault(); return; }
    if (overlayHidden()) { showOverlay(); e.preventDefault(); return; }
    showOverlay();
    var bs = $("pbtns").querySelectorAll("button");
    // ARRIBA/ABAJO eligen boton de la barra, OK lo pulsa
    if (k === "ArrowUp" || c === 38) { btnFocus = Math.max(0, btnFocus - 1); renderBtns(); }
    else if (k === "ArrowDown" || c === 40) { btnFocus = Math.min(bs.length - 1, btnFocus + 1); renderBtns(); }
    else if (k === "Enter" || c === 13) { act(bs[btnFocus].getAttribute("data-act")); }
    e.preventDefault();
  }

  function act(a) {
    if (a === "prev") zap(-1);
    else if (a === "next") zap(1);
    else if (a === "fav") toggleFav();
    else if (a === "full") toggleFull();
    else if (a === "back") closePlayer();
  }

  // con el puntero del Browser: los botones aparecen al acercarlo a la parte de abajo (ultimo cuarto)
  $("player").addEventListener("mousemove", function (e) {
    if (!playerOpen) return;
    var abajo = e.clientY >= window.innerHeight * 0.75;
    if (abajo) { inZone = true; showOverlay(); }
    else if (inZone) { inZone = false; hideLater(1500); }
  });
  $("player").addEventListener("mouseleave", function () { if (inZone) { inZone = false; hideLater(1500); } });

  /* ---------- navegacion ---------- */
  document.addEventListener("keydown", function (e) {
    var ae = document.activeElement;
    if (ae && ae.id === "q") {                     // escribiendo en el buscador
      var k2 = e.key, c2 = e.keyCode;
      if (k2 === "Enter" || c2 === 13 || k2 === "ArrowDown" || c2 === 40) {
        if (list.length) { ae.blur(); area = "grid"; gi = 0; render(); }
        e.preventDefault();
      } else if (k2 === "Escape" || c2 === 27 || c2 === 10009) { ae.value = ""; setQuery(""); ae.blur(); e.preventDefault(); }
      return;
    }
    if (ae && ae.tagName === "INPUT") {          // escribiendo el nombre de una lista
      if (e.key === "Enter" || e.keyCode === 13) { var sb = document.querySelector('[data-m="save"]'); if (sb) managerAction(sb); e.preventDefault(); }
      return;
    }
    if (popUrl) {
      if (e.keyCode === 10009 || e.key === "Escape" || e.keyCode === 27) { closePop(); e.preventDefault(); }
      return;
    }
    if (playerOpen) { playerKey(e); return; }
    var k = e.key, c = e.keyCode, handled = true;
    if (k === "ArrowLeft" || c === 37) {
      if (area === "tabs") { ti = Math.max(0, ti - 1); gi = 0; filterList(); }
      else gi = Math.max(0, gi - 1);
    } else if (k === "ArrowRight" || c === 39) {
      if (area === "tabs") { ti = Math.min(tabs.length - 1, ti + 1); gi = 0; filterList(); }
      else gi = Math.min(list.length - 1, gi + 1);
    } else if (k === "ArrowDown" || c === 40) {
      if (area === "tabs") { if (list.length) { area = "grid"; gi = 0; } }
      else gi = Math.min(list.length - 1, gi + cols());
    } else if (k === "ArrowUp" || c === 38) {
      if (area === "grid") { if (gi - cols() < 0) area = "tabs"; else gi -= cols(); }
    } else if (k === "Enter" || c === 13) {
      if (area === "tabs" && tabs[ti].id === "test") startTest();
      else if (area === "grid" && list.length) openPlayer(gi);
      else if (area === "tabs" && list.length) { area = "grid"; gi = 0; }
    } else handled = false;
    if (handled) { e.preventDefault(); render(); }
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest && t.closest("#addpop [data-pl]")) { popAction(t.closest("[data-pl]").getAttribute("data-pl")); return; }
    if (t.id === "addpop") { closePop(); return; }
    if (t.closest && t.closest("[data-m]")) { managerAction(t.closest("[data-m]")); return; }
    if (t.closest && t.closest(".addbtn")) {
      var ai = +t.closest(".addbtn").getAttribute("data-i"); gi = ai; area = "grid";
      openPop(list[ai].url); return;
    }
    if (t.tagName === "INPUT") return;
    if (t.classList && t.classList.contains("tab")) {
      ti = Array.prototype.indexOf.call($("tabs").children, t); gi = 0; area = "tabs"; filterList(); render();
      if (tabs[ti].id === "test") startTest();
    } else if (t.closest && t.closest(".favbtn")) {
      var fi = +t.closest(".favbtn").getAttribute("data-i");
      toggleFavUrl(list[fi].url); gi = fi; area = "grid";
      if (tabs[ti].id === "fav") filterList();
      render();
    } else if (t.closest && t.closest(".card")) {
      gi = Array.prototype.indexOf.call($("grid").children, t.closest(".card")); area = "grid"; openPlayer(gi);
    } else if (t.closest && t.closest("#pbtns [data-act]")) {
      var b = t.closest("#pbtns [data-act]");
      btnFocus = Array.prototype.indexOf.call($("pbtns").children, b); renderBtns(); showOverlay();
      act(b.getAttribute("data-act"));
    }
  });

  /* Lista automatica "Canales peruanos": los canales cuyo identificador publico termina en .pe
     (p. ej. tvg-id="ATV.pe@SD"). Se crea una sola vez; luego es una lista normal que puedes editar o borrar. */
  function seedPeru() {
    if (seeded.indexOf("peru") >= 0 || findList("peru")) return;
    var urls = channels.filter(function (c) { return /\.pe(@|$)/i.test(c.tid || ""); })
                       .map(function (c) { return c.url; });
    if (!urls.length) return;
    ulists.unshift({ id: "peru", name: "Canales peruanos", urls: urls });
    seeded.push("peru");
    saveLists();
  }

  /* ---------- buscador ---------- */
  function setQuery(v) {
    query = norm(v);
    gi = 0; area = query ? "grid" : "tabs";
    filterList(); render();
    setStatus(query ? (list.length + " canales encontrados para “" + v.trim() + "” · borra el texto para volver") : baseStatus);
  }
  $("q").addEventListener("input", function () { setQuery(this.value); });
  $("q").addEventListener("search", function () { setQuery(this.value); });   // la x de la casilla

  /* ---------- carga ---------- */
  function init() {
    channels = channels.filter(function (c) { return !BLOQUEADO.test(c.name + " " + c.group); });
    channels.forEach(function (c) {
      c.gs = (c.group || "").toLowerCase().split(";").map(function (g) { return g.trim(); }).filter(Boolean);
      byUrl[c.url] = c;
    });
    seedPeru();
    buildTabs();
    var hasFav = channels.some(isFav);
    var start = hasFav ? "fav" : (findList("peru") ? "L:peru" : "all");
    ti = 0;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === start) ti = i;
    filterList();
    area = "tabs";
    var hlsOk = !!(window.Hls && Hls.isSupported());
    var nat = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
    baseStatus = (SERVER ? "Modo PC" : "Modo sin PC") + " · " + channels.length + " canales (" + PAIS.toUpperCase() + ") · OK para ver · CH+/CH− o ▲▼ cambian de canal · hls.js: " +
      (hlsOk ? "sí" : "no") + " · HLS nativo: " + (nat ? "sí" : "no");
    setStatus(baseStatus);
    render();
  }

  function loadList(i) {
    if (i >= URLS.length) { setStatus("No se pudo descargar la lista de canales. Revisa el internet de la PC y de la TV."); return; }
    var x = new XMLHttpRequest();
    x.open("GET", URLS[i], true); x.timeout = 30000;
    x.onload = function () {
      if (x.status === 200 || (x.status === 0 && x.responseText)) {
        var l = parseM3U(x.responseText);
        if (l.length) { channels = l; SERVER = (i === 0); if (SERVER) fetchLists(init); else init(); return; }
      }
      loadList(i + 1);
    };
    x.onerror = x.ontimeout = function () { loadList(i + 1); };
    x.send();
  }

  loadList(0);
})();
