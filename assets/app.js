(function () {
  "use strict";
  document.documentElement.classList.add("js");

  var VIEWS = ["route", "exam", "practice", "trade", "sources"];
  var KEY = "rtfa.v1";
  var Q = window.RTFA_QUESTIONS || [];
  var TOPICS = window.RTFA_TOPICS || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------- storage (per-browser convenience only) ----------
  var state = { done: {}, tasks: {}, mocks: [], last: {} };
  try {
    var raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object") {
      state.done = raw.done || {}; state.tasks = raw.tasks || {};
      state.mocks = raw.mocks || []; state.last = raw.last || {};
    }
  } catch (e) { /* storage unavailable: run without it */ }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} schedulePush(); }

  // ---------- sync with the host (twentysixseven) ----------
  // When served by the host, progress is also stored per profile on the server (GET/PUT /api/progress/rtfa) so it
  // follows you across devices. Opened as a plain file or from another server, nothing changes: localStorage only.
  var PROGRESS_URL = "/api/progress/rtfa", SYNC_KEY = "rtfa.v1.sync";
  var sync = { on: false, rev: 0, base: null, timer: null, busy: false };
  function core() { return { done: state.done, tasks: state.tasks, mocks: state.mocks, last: state.last }; }
  function snap() { return JSON.stringify(core()); }
  function readSync() { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || "null"); } catch (e) { return null; } }
  function writeSync() { try { localStorage.setItem(SYNC_KEY, JSON.stringify({ rev: sync.rev, base: sync.base })); } catch (e) {} }
  function adopt(d) { state.done = d.done || {}; state.tasks = d.tasks || {}; state.mocks = d.mocks || []; state.last = d.last || {}; }
  function merge(d) { // union: never lose progress made on either side
    var k, seen = {};
    for (k in (d.done || {})) state.done[k] = 1;
    for (k in (d.tasks || {})) state.tasks[k] = 1;
    state.mocks.forEach(function (m) { seen[m.d + "/" + m.s] = 1; });
    (d.mocks || []).forEach(function (m) { if (!seen[m.d + "/" + m.s]) state.mocks.push(m); });
    state.mocks.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    for (k in (d.last || {})) if (!state.last[k]) state.last[k] = d.last[k];
  }
  function remote(method, body) {
    return fetch(PROGRESS_URL, { method: method, credentials: "same-origin", cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.replace("/"); throw new Error("signed out"); }
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      });
  }
  function schedulePush(delay) {
    if (!sync.on || snap() === sync.base) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(push, delay == null ? 1500 : delay);
  }
  function push(attempt) {
    if (!sync.on) return;
    clearTimeout(sync.timer);
    if (sync.busy) { schedulePush(500); return; }
    var sent = snap();
    if (sent === sync.base) return;
    sync.busy = true;
    remote("PUT", { data: JSON.parse(sent), rev: sync.rev }).then(function (r) {
      if (r.status === 200) { sync.rev = r.json.rev; sync.base = sent; writeSync(); return; }
      if (r.status === 409 && (attempt || 0) < 3) { // another device saved first: merge its copy in, try again
        if (r.json.data) merge(r.json.data);
        sync.rev = r.json.rev; save(); sync.busy = false; return push((attempt || 0) + 1);
      }
      throw new Error("HTTP " + r.status);
    }).catch(function () { setTimeout(function () { schedulePush(0); }, 30000); }) // offline: retry later
      .then(function () { sync.busy = false; });
  }
  var notHosted = false;
  function showBlocked() {
    document.body.innerHTML = '<main style="max-width:520px;margin:20vh auto;padding:0 16px;font:400 16px/1.4 Plein,system-ui,sans-serif;color:var(--ink,#303030)"><p style="font-size:1.4rem;font-weight:500;margin:0 0 8px">Sign in first</p><p style="color:var(--muted,#828282);margin:0">This page only opens through your profile. Start the hub and open it from there.</p></main>';
  }
  function initSync() {
    return fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (me) {
        if (!me || !("profile" in me)) { notHosted = true; return; }  // not served by the hub: do not run
        if (!me.profile) { notHosted = true; location.replace("/"); return; }  // nobody signed in
        sync.on = true;
        var prev = readSync();
        return remote("GET").then(function (r) {
          if (r.status !== 200) throw new Error("HTTP " + r.status);
          var unchanged = prev && prev.base === snap();      // nothing done here since the last sync
          if (r.json.data) { if (unchanged) adopt(r.json.data); else merge(r.json.data); }
          sync.rev = r.json.rev; sync.base = unchanged ? snap() : (r.json.data ? null : null);
          save();                                            // pushes the merged result if it differs from the server
          writeSync();
        });
      }).catch(function () { /* host unreachable: keep working locally */ });
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  // ---------- courses ----------
  var courses = {};
  $$(".course").forEach(function (c) {
    var name = c.getAttribute("data-course");
    var lessons = $$(".lesson", c);
    var rail = $(".rail", c), select = $(".lesson-select", c);
    var group = null, og = null;
    lessons.forEach(function (l, i) {
      var g = l.getAttribute("data-group");
      if (g !== group) {
        group = g;
        rail.appendChild(el("div", { class: "group", text: g }));
        og = el("optgroup", { label: g }); select.appendChild(og);
      }
      var a = el("a", { href: "#" + l.id, "data-lesson": l.id }, [el("span", { class: "tick" }), el("span", { text: l.getAttribute("data-title") })]);
      rail.appendChild(a);
      og.appendChild(el("option", { value: l.id, text: (i + 1) + ". " + l.getAttribute("data-title") }));

      var foot = el("div", { class: "lesson-foot" });
      var left = el("div", { class: "btnrow" }), right = el("div", { class: "btnrow" });
      var done = el("button", { class: "btn", type: "button", "data-done": l.id });
      left.appendChild(done);
      var topic = l.getAttribute("data-topic");
      if (topic) {
        var d = el("button", { class: "btn ghost", type: "button", text: "Drill this topic" });
        d.addEventListener("click", function () { startDrill(topic); location.hash = "practice"; });
        left.appendChild(d);
      }
      if (lessons[i - 1]) right.appendChild(el("a", { class: "btn ghost", href: "#" + lessons[i - 1].id, text: "← Previous" }));
      if (lessons[i + 1]) right.appendChild(el("a", { class: "btn ghost", href: "#" + lessons[i + 1].id, text: "Next →" }));
      foot.appendChild(left); foot.appendChild(right);
      l.appendChild(foot);
      done.addEventListener("click", function () {
        if (state.done[l.id]) delete state.done[l.id]; else state.done[l.id] = 1;
        save(); paintProgress();
      });
    });
    select.addEventListener("change", function () { location.hash = select.value; });
    courses[name] = { root: c, lessons: lessons, select: select, rail: rail };
  });

  function showLesson(name, id) {
    var c = courses[name];
    var target = c.lessons.filter(function (l) { return l.id === id; })[0] || c.lessons[0];
    c.lessons.forEach(function (l) { l.classList.toggle("on", l === target); });
    $$("a", c.rail).forEach(function (a) {
      if (a.getAttribute("data-lesson") === target.id) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
    c.select.value = target.id;
    state.last[name] = target.id; save();
  }

  function paintProgress() {
    Object.keys(courses).forEach(function (name) {
      var c = courses[name], n = 0;
      c.lessons.forEach(function (l) {
        var d = !!state.done[l.id]; if (d) n++;
        var a = $('a[data-lesson="' + l.id + '"]', c.rail); if (a) a.classList.toggle("done", d);
        var b = $('[data-done="' + l.id + '"]', l);
        if (b) { b.textContent = d ? "Completed ✓ (undo)" : "Mark as complete"; b.classList.toggle("ghost", d); }
      });
      var bar = $("#p-" + name), num = $("#p-" + name + "-n");
      if (bar) bar.style.width = (c.lessons.length ? (100 * n / c.lessons.length) : 0) + "%";
      if (num) num.textContent = n + " / " + c.lessons.length;
    });
    var best = state.mocks.reduce(function (m, x) { return Math.max(m, x.s); }, -1);
    var pm = $("#p-mock"); if (pm) pm.textContent = best < 0 ? "not sat yet" : best + " / 20" + (best >= 15 ? " (pass)" : "");
    var resume = $("#resume");
    if (resume && courses.exam) {
      var next = courses.exam.lessons.filter(function (l) { return !state.done[l.id]; })[0];
      var any = courses.exam.lessons.some(function (l) { return state.done[l.id]; });
      if (next) { resume.href = "#" + next.id; resume.textContent = any ? "Continue: " + next.getAttribute("data-title") : "Start the exam course"; }
      else { resume.href = "#practice"; resume.textContent = "Course complete. Sit a mock"; }
    }
    var mh = $("#mock-history");
    if (mh) mh.textContent = state.mocks.length ? "Previous scores: " + state.mocks.slice(-6).map(function (m) { return m.s + "/20"; }).join(", ") : "";
  }

  // ---------- routing (plain #name only) ----------
  function route() {
    var h = (location.hash || "").replace(/^#/, "") || "route";
    var view = h, lesson = null;
    if (VIEWS.indexOf(h) < 0) {
      if (h.indexOf("x-") === 0) { view = "exam"; lesson = h; }
      else if (h.indexOf("t-") === 0) { view = "trade"; lesson = h; }
      else view = "route";
    }
    VIEWS.forEach(function (v) { $("#view-" + v).hidden = v !== view; });
    $$(".tabs a").forEach(function (a) {
      if (a.getAttribute("data-view") === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (courses[view]) showLesson(view, lesson || state.last[view]);
    if (lesson || view !== "practice") window.scrollTo(0, 0);
    paintProgress();
  }
  window.addEventListener("hashchange", route);

  // ---------- checklists ----------
  $$("input[data-task]").forEach(function (cb) {
    var id = cb.getAttribute("data-task");
    cb.checked = !!state.tasks[id];
    cb.addEventListener("change", function () { if (cb.checked) state.tasks[id] = 1; else delete state.tasks[id]; save(); });
  });

  // ---------- copy buttons ----------
  $$("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var pre = $("pre", b.closest(".tpl"));
      var ok = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); };
      var fallback = function () {
        var r = document.createRange(); r.selectNodeContents(pre);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        b.textContent = "Selected. Press Ctrl+C";
      };
      try { navigator.clipboard.writeText(pre.textContent).then(ok, fallback); } catch (e) { fallback(); }
    });
  });

  // ---------- practice ----------
  var homeEl = $("#practice-home"), runEl = $("#practice-run");
  var timer = null;
  $("#q-count").textContent = Q.length;
  var sel = $("#drill-topic");
  sel.appendChild(el("option", { value: "all", text: "All topics (" + Q.length + ")" }));
  Object.keys(TOPICS).forEach(function (k) {
    var n = Q.filter(function (q) { return q.t === k; }).length;
    if (n) sel.appendChild(el("option", { value: k, text: TOPICS[k] + " (" + n + ")" }));
  });

  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // Pure scoring rule: full marks only if the selected set equals the correct set.
  function isCorrect(q, picked) {
    if (picked.length !== q.a.length) return false;
    return q.a.every(function (i) { return picked.indexOf(i) >= 0; });
  }
  window.RTFA_isCorrect = isCorrect;

  function renderQ(q, n, total, name) {
    var order = shuffle(q.o.map(function (_, i) { return i; }));
    var box = el("div", { class: "q" });
    box.appendChild(el("div", { class: "q-head" }, [el("span", { text: "Question " + n + (total ? " of " + total : "") }), el("span", { text: TOPICS[q.t] || "" })]));
    box.appendChild(el("p", { class: "q-text", text: q.q }));
    var opts = el("div", { class: "opts" });
    order.forEach(function (i, k) {
      var id = name + "-" + k;
      var input = el("input", { type: "checkbox", id: id, value: String(i) });
      opts.appendChild(el("label", { class: "opt", for: id }, [input, el("span", { text: q.o[i] })]));
    });
    box.appendChild(opts);
    box.picked = function () { return $$("input:checked", opts).map(function (x) { return +x.value; }); };
    box.reveal = function () {
      var p = box.picked(), ok = isCorrect(q, p);
      $$("label", opts).forEach(function (l) {
        var inp = $("input", l), i = +inp.value, right = q.a.indexOf(i) >= 0;
        inp.disabled = true;
        if (right && inp.checked) l.classList.add("right");
        else if (right) l.classList.add("missed");
        else if (inp.checked) l.classList.add("wrong");
      });
      box.appendChild(el("p", { class: "verdict " + (ok ? "ok" : "no"), text: ok ? "Correct" : (p.length ? "Not fully correct: 0 marks" : "Not answered: 0 marks") }));
      box.appendChild(el("p", { class: "explain", text: q.e }));
      box.appendChild(el("p", {}, [el("span", { class: "ref", text: q.r })]));
      return ok;
    };
    return box;
  }

  function showRun(on) { homeEl.hidden = on; runEl.hidden = !on; if (!on) { runEl.textContent = ""; if (timer) { clearInterval(timer); timer = null; } } }
  function exitBtn(label) { var b = el("button", { class: "btn ghost", type: "button", text: label || "Back to practice" }); b.addEventListener("click", function () { showRun(false); paintProgress(); window.scrollTo(0, 0); }); return b; }

  function startDrill(topic) {
    if (sel.querySelector('option[value="' + topic + '"]')) sel.value = topic;
    var pool = shuffle(Q.filter(function (q) { return topic === "all" || q.t === topic; }));
    var i = 0, right = 0;
    showRun(true);
    function step() {
      runEl.textContent = "";
      if (i >= pool.length) {
        runEl.appendChild(el("div", { class: "panel" }, [
          el("h3", { text: "Drill finished" }),
          el("p", { class: "score", text: right + " / " + pool.length }),
          el("p", { class: "small", text: (TOPICS[topic] || "All topics") + ". Re-read the lesson for anything you missed, then drill again." }),
          el("div", { class: "btnrow" }, [exitBtn()])
        ]));
        return;
      }
      var q = pool[i], box = renderQ(q, i + 1, pool.length, "d" + i);
      var check = el("button", { class: "btn", type: "button", text: "Check answer" });
      var row = el("div", { class: "btnrow" }, [check, exitBtn("End drill")]);
      check.addEventListener("click", function () {
        if (check.getAttribute("data-next")) { i++; step(); window.scrollTo(0, 0); return; }
        if (box.reveal()) right++;
        check.textContent = i + 1 < pool.length ? "Next question" : "See result";
        check.setAttribute("data-next", "1");
        box.appendChild(row);
      });
      box.appendChild(row);
      runEl.appendChild(el("p", { class: "small", text: "Select every correct option. Some questions have more than one." }));
      runEl.appendChild(box);
    }
    step();
  }

  function startMock() {
    // spread across topics: one per topic first, then fill at random
    var byTopic = {}, picked = [];
    shuffle(Q).forEach(function (q) { (byTopic[q.t] = byTopic[q.t] || []).push(q); });
    Object.keys(byTopic).forEach(function (t) { picked.push(byTopic[t].shift()); });
    var rest = shuffle([].concat.apply([], Object.keys(byTopic).map(function (t) { return byTopic[t]; })));
    picked = shuffle(picked.concat(rest).slice(0, 20));

    showRun(true);
    var end = Date.now() + 60 * 60 * 1000, finished = false;
    var clock = el("span", { class: "clock", text: "60:00" });
    var submit = el("button", { class: "btn", type: "button", text: "Submit exam" });
    var bar = el("div", { class: "timerbar" }, [el("span", { text: "Mock exam" }), clock, submit]);
    var list = el("div", { class: "qlist" });
    var boxes = picked.map(function (q, k) { var b = renderQ(q, k + 1, 20, "m" + k); list.appendChild(b); return b; });
    runEl.appendChild(el("p", { class: "small", text: "No lesson notes, no search engine. In the real exam only the official Study Materials are allowed. Select every correct option for each question." }));
    runEl.appendChild(bar); runEl.appendChild(list);

    function finish(auto) {
      if (finished) return; finished = true;
      clearInterval(timer); timer = null;
      var score = 0;
      boxes.forEach(function (b) { if (b.reveal()) score++; });
      state.mocks.push({ d: new Date().toISOString().slice(0, 10), s: score }); save();
      var pass = score >= 15;
      var res = el("div", { class: "panel" }, [
        el("h3", { text: auto ? "Time is up. Answers submitted automatically" : "Result" }),
        el("p", { class: "score", text: score + " / 20" }),
        el("p", {}, [el("span", { class: "pill " + (pass ? "pass" : "fail"), text: pass ? "Pass (" + score * 5 + "%)" : "Below the 75% pass mark (" + score * 5 + "%)" })]),
        el("p", { class: "small", text: "Every question is reviewed below with the rule it tests." }),
        el("div", { class: "btnrow" }, [exitBtn()])
      ]);
      bar.remove();
      runEl.insertBefore(res, list);
      window.scrollTo(0, 0);
    }
    submit.addEventListener("click", function () {
      var blank = boxes.filter(function (b) { return !b.picked().length; }).length;
      if (blank && !submit.getAttribute("data-sure")) {
        submit.textContent = blank + " unanswered. Submit anyway";
        submit.setAttribute("data-sure", "1"); return;
      }
      finish(false);
    });
    function tick() {
      var left = Math.max(0, end - Date.now()), m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
      clock.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
      if (left <= 0) finish(true);
    }
    timer = setInterval(tick, 500); tick();
  }

  $("#drill-start").addEventListener("click", function () { startDrill(sel.value); window.scrollTo(0, 0); });
  $("#mock-start").addEventListener("click", function () { startMock(); window.scrollTo(0, 0); });

  // draw straight away if the host is slow or unreachable
  Promise.race([initSync(), new Promise(function (res) { setTimeout(res, 3000); })]).then(function () { if (notHosted) showBlocked(); else route(); });
})();
