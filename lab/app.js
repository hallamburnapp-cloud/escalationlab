// Belfer Lab — app.js
// The lab client: hash router, API client, and the screens for the gate, the group
// terminal, the participant (phone) flow, the facilitator console and the observer view.
//
// This file is published unminified. It is organised by screen, top to bottom:
//   1. configuration, storage and the API client
//   2. router and polling
//   3. top bar and timer
//   4. payload shape: the one place that knows the server's field names
//   5. gate
//   6. group terminal (waiting, briefing, turn loop, statements, survey, debrief)
//   7. participant flow (#p)
//   8. facilitator console (#console)
//   9. observer view
//  10. boot
//
// Rendering rule: data from the server or from another role is only ever placed with
// textContent / createTextNode (see UI.el in ui.js). The client never learns the
// session's condition: it renders whatever labels and affordances the server sends.
(function () {
  "use strict";

  var UI = window.UI;
  var el = UI.el;

  // ---------------------------------------------------------------------------
  // 1. Configuration, storage and the API client
  // ---------------------------------------------------------------------------

  var CONFIG = window.LAB_CONFIG || {};
  var API_BASE = (CONFIG.apiBase || "").replace(/\/+$/, "");
  var POLL_MS = Number(CONFIG.pollMs) || 3000;
  var AUTOSAVE_MS = 400;

  // Everything that identifies the session lives in sessionStorage only (never localStorage).
  var store = {
    get: function (key) { try { return sessionStorage.getItem("lab." + key); } catch (e) { return null; } },
    set: function (key, value) { try { sessionStorage.setItem("lab." + key, value); } catch (e) { /* storage unavailable */ } },
    remove: function (key) { try { sessionStorage.removeItem("lab." + key); } catch (e) { /* storage unavailable */ } },
    getJson: function (key) { try { return JSON.parse(sessionStorage.getItem("lab." + key)); } catch (e) { return null; } },
    setJson: function (key, value) { store.set(key, JSON.stringify(value)); }
  };

  var auth = {
    token: function () { return store.get("token"); },
    role: function () { return store.get("role"); },
    participant: function () { return store.get("participant"); },
    signIn: function (gate) {
      store.set("token", gate.token);
      store.set("role", gate.role);
      if (gate.session) store.set("session", gate.session); else store.remove("session");
      if (gate.side) store.set("side", gate.side); else store.remove("side");
    },
    signOut: function () {
      ["token", "role", "session", "side", "participant"].forEach(store.remove);
    }
  };

  // The server's clock as seen in the last response: used for the timer, never Date.now().
  var serverClock = { iso: null };

  function apiError(status, body) {
    var err = new Error((body && (body.message || body.error)) || ("Request failed (" + status + ")"));
    err.status = status;
    err.code = body && body.error;
    err.retryAfter = body && body.retry_after;
    return err;
  }

  // api("GET", "/api/me") -> parsed JSON. 401 clears the token and returns to the gate.
  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    var token = auth.token();
    if (token && !opts.noAuth) headers["Authorization"] = "Bearer " + token;
    var participant = auth.participant();
    if (participant && opts.participant !== false) headers["X-Participant"] = participant;
    return fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    }).then(function (response) {
      var dateHeader = response.headers.get("Date");
      if (dateHeader) serverClock.iso = new Date(dateHeader).toISOString();
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (response.status === 401 && !opts.noAuth) {
          auth.signOut();
          setConnection(false);
          navigate(isParticipantRoute() ? "p" : "");
          throw apiError(401, data || { error: "invalid_code" });
        }
        if (!response.ok) throw apiError(response.status, data || { error: "http_" + response.status });
        if (data && typeof data === "object" && data.now) serverClock.iso = data.now;
        if (data && typeof data === "object" && data.pollMs) setPollInterval(data.pollMs);
        return data;
      });
    });
  }

  // Download an export with the bearer token: fetch, then a Blob URL on an anchor.
  function download(path, filename) {
    var token = auth.token();
    return fetch(API_BASE + path, { headers: { "Authorization": "Bearer " + token }, cache: "no-store" }).then(function (response) {
      if (response.status === 401) { auth.signOut(); navigate(""); throw apiError(401, {}); }
      if (!response.ok) return response.text().then(function (text) {
        var data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
        throw apiError(response.status, data || {});
      });
      var disposition = response.headers.get("Content-Disposition") || "";
      var match = /filename="?([^";]+)"?/.exec(disposition);
      var name = match ? match[1] : filename;
      return response.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = el("a", { href: url, download: name });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      });
    });
  }

  // Read a server-sent-event stream from a POST with fetch + ReadableStream.
  // onEvent receives each parsed JSON object from "data:" lines.
  function streamPost(path, body, onEvent) {
    var token = auth.token();
    return fetch(API_BASE + path, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(body),
      cache: "no-store"
    }).then(function (response) {
      if (response.status === 401) { auth.signOut(); navigate(""); throw apiError(401, {}); }
      if (!response.ok) return response.text().then(function (text) {
        var data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
        throw apiError(response.status, data || {});
      });
      if (!response.body || !response.body.getReader) {
        // No streaming support: read the whole body and parse it once.
        return response.text().then(function (text) { parseSseChunk(text + "\n\n", onEvent); });
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            if (buffer.trim()) parseSseChunk(buffer + "\n\n", onEvent);
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          var boundary = buffer.lastIndexOf("\n");
          if (boundary >= 0) {
            parseSseChunk(buffer.slice(0, boundary + 1), onEvent);
            buffer = buffer.slice(boundary + 1);
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function parseSseChunk(text, onEvent) {
    text.split("\n").forEach(function (line) {
      line = line.replace(/\r$/, "");
      if (line.indexOf("data:") !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload) return;
      try { onEvent(JSON.parse(payload)); } catch (e) { onEvent({ delta: payload }); }
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Router and polling
  // ---------------------------------------------------------------------------

  // The hash holds a path and optional key=value pairs: "#p&code=BLF-…", "#console/session/abc".
  function parseHash(hash) {
    var raw = (hash || "").replace(/^#/, "");
    var out = { path: "", params: {} };
    raw.split("&").forEach(function (piece) {
      if (!piece) return;
      var eq = piece.indexOf("=");
      if (eq < 0) { if (!out.path) out.path = piece; return; }
      var key = piece.slice(0, eq);
      var value = piece.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
      out.params[key] = value;
    });
    return out;
  }

  function isParticipantRoute() {
    var parsed = parseHash(location.hash);
    return parsed.path === "p" || parsed.path.indexOf("p/") === 0;
  }

  function navigate(path) {
    var target = "#" + (path || "");
    if (location.hash === target || (target === "#" && location.hash === "")) { route(); return; }
    location.hash = target;
  }

  var main = document.getElementById("main");
  var current = { key: null, ctx: null, poll: null };
  var pollHandle = null;
  var polling = false;

  // show(key, build): rebuilds the screen only when the key changes; otherwise reuses it.
  function show(key, build) {
    if (current.key === key && current.ctx) return current.ctx;
    current.key = key;
    current.ctx = null;
    main.setAttribute("aria-busy", "true");
    UI.clear(main);
    main.className = "app";
    timer.clearListeners();
    var ctx = build(main) || {};
    ctx._built = true;
    current.ctx = ctx;
    main.setAttribute("aria-busy", "false");
    window.scrollTo(0, 0);
    return ctx;
  }

  // After show(): a screen that already existed gets the fresh payload through its update().
  function updateScreen(ctx, me) {
    if (!ctx) return ctx;
    if (ctx._built) ctx._built = false;
    else if (ctx.update) ctx.update(me);
    return ctx;
  }

  function setPoll(fn) {
    current.poll = fn;
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = fn ? setInterval(pollNow, POLL_MS) : null;
    if (fn) pollNow();
  }

  // The server may ask for a different polling interval (TEST_FAST sends pollMs: 500).
  function setPollInterval(ms) {
    ms = Math.max(250, Number(ms) || 0);
    if (!ms || ms === POLL_MS) return;
    POLL_MS = ms;
    if (pollHandle) { clearInterval(pollHandle); pollHandle = setInterval(pollNow, POLL_MS); }
  }

  function pollNow() {
    if (!current.poll || polling) return;
    polling = true;
    Promise.resolve().then(current.poll).then(function () {
      setConnection(true);
    }, function (err) {
      if (err && err.status) setConnection(true); else setConnection(false);
    }).then(function () { polling = false; });
  }

  function setConnection(ok) {
    var node = document.getElementById("connection");
    if (node) node.hidden = ok;
  }

  // ---------------------------------------------------------------------------
  // 3. Top bar and timer
  // ---------------------------------------------------------------------------

  var top = {
    scenario: document.getElementById("topScenario"),
    side: document.getElementById("topSide"),
    turn: document.getElementById("topTurn"),
    stage: document.getElementById("topStage"),
    timer: document.getElementById("topTimer")
  };
  var timer = UI.createTimer(top.timer, document.getElementById("liveTimer"));
  var lastStageAnnounced = null;

  var STAGE_NAMES = {
    setup: "Waiting", briefing: "Briefing", turn1: "Turn 1", statements1: "Report-back 1",
    turn2: "Turn 2", statements2: "Report-back 2", survey: "Survey", debrief: "Debrief", closed: "Closed"
  };

  function stageName(stage) { return STAGE_NAMES[stage] || stage || ""; }

  function setTopBar(info) {
    top.scenario.textContent = info.scenario || "";
    top.side.textContent = info.side || "";
    top.turn.textContent = info.turn ? ("Turn " + info.turn) : "";
    top.stage.textContent = info.stage ? stageName(info.stage) : "";
    timer.set(info.timer || null, info.now || serverClock.iso);
    if (info.stage && info.stage !== lastStageAnnounced) {
      if (lastStageAnnounced !== null) UI.announce("Stage: " + stageName(info.stage));
      lastStageAnnounced = info.stage;
    }
  }

  function clearTopBar() { setTopBar({}); }

  // ---------------------------------------------------------------------------
  // 4. Payload shape
  // The accessors below are the only code that knows the names of fields in the
  // server's responses. Where the specification leaves a name open, the first name
  // tried is the one the client's stub uses; alternatives are accepted after it.
  // ---------------------------------------------------------------------------

  function turnOfStage(stage) {
    var m = /^(turn|statements)(\d)$/.exec(stage || "");
    return m ? Number(m[2]) : null;
  }

  function pick(obj, keys, fallback) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return fallback;
  }

  var shape = {
    session: function (me) { return me.session || {}; },
    stage: function (me) { return shape.session(me).stage || "setup"; },
    now: function (me) { return me.now || shape.session(me).now || (shape.session(me).timer && shape.session(me).timer.now) || serverClock.iso; },
    // The server marks expiry with expiredAt; the timer widget reads a boolean.
    timer: function (me) { var t = shape.session(me).timer; return t ? Object.assign({}, t, { expired: !!(t.expired || t.expiredAt) }) : null; },
    scenario: function (me) { return shape.session(me).scenario || {}; },
    content: function (me) { return me.content || {}; },
    sideName: function (me) {
      var c = shape.content(me);
      return pick(c.side || {}, ["name"]) || pick(me, ["sideName"]) || (c.sides && c.sides[me.side] && c.sides[me.side].name) || me.side || "";
    },
    sideNames: function (me) {
      var c = shape.content(me);
      var names = {};
      if (c.sides) Object.keys(c.sides).forEach(function (k) { names[k] = c.sides[k].name || k; });
      if (c.side && c.side.adversary) names[c.side.adversary] = c.side.adversaryName || c.side.adversary;
      if (me.side) names[me.side] = shape.sideName(me);
      return names;
    },
    adversary: function (me) { var c = shape.content(me); return (c.side && c.side.adversary) || null; },
    background: function (me) { return shape.content(me).background || {}; },
    brief: function (me) { var c = shape.content(me); return c.brief || (c.briefs && c.briefs[me.side]) || {}; },
    riskReduction: function (me) { return shape.content(me).riskReduction || []; },
    levers: function (me) { return shape.content(me).levers || null; },
    // The server keys released turns by number (content.turns[n]); the screens read the current one.
    turn: function (me) {
      var c = shape.content(me);
      if (c.turn) return c.turn;
      var n = turnOfStage(shape.stage(me));
      var t = n && c.turns ? c.turns[n] : null;
      return t ? Object.assign({ n: n }, t) : null;
    },
    // Own-side actions this turn as the server records them: hotline [{t,text}], riskReduction [{t,measures}], redTeam, verification.
    actions: function (me, turn) { return (me.actions && me.actions[turn]) || {}; },
    panelOpened: function (me, turn) { return !!(me.marks && me.marks[turn] && me.marks[turn].panelOpenedAt); },
    turnNumber: function (me) { var t = shape.turn(me); return (t && t.n) || turnOfStage(shape.stage(me)) || shape.session(me).turn || 1; },
    draft: function (me, turn) { return (me.draft && me.draft[turn]) || {}; },
    assessments: function (me, turn) { return (me.assessments && me.assessments[turn]) || (me.draft && me.draft[turn] && me.draft[turn].assessments) || {}; },
    submission: function (me, turn) { return (me.submissions && me.submissions[turn]) || null; },
    ai: function (me) { return me.ai || null; },
    assistantEnabled: function (me) {
      var a = shape.session(me).assistant;
      var ai = shape.ai(me);
      if (ai && typeof ai.chat === "boolean") return ai.chat;
      return !!(a && a.enabled);
    },
    // Panel roles in a fixed order; labels come from the server as labels[key] = { name, title }.
    // panel.source (scripted_staff | scripted_ai | live_ai | not_available) is data, never a label.
    panelRoles: function (panel) {
      if (!panel) return [];
      if (Array.isArray(panel.roles)) return panel.roles;
      return ["intel", "forecast", "adversary"].filter(function (key) { return panel[key]; }).map(function (key) {
        var role = panel[key];
        var label = panel.labels && panel.labels[key];
        return {
          key: key,
          source: pick(role, ["source", "label"]) || (typeof label === "string" ? label : (label && label.name)) || "",
          title: pick(role, ["title"]) || (label && typeof label === "object" && label.title) || (panel.titles && panel.titles[key]) || "",
          headline: role.headline || "",
          body: role.body || "",
          confidence: role.confidence,
          pathways: role.pathways || null,
          reasoning: role.reasoning || (panel.reasoning && panel.reasoning[key]) || null
        };
      });
    },
    // statementsReleased[turn] is what the other side released: { statement, observables, hotline }.
    statements: function (me, turn) {
      var c = shape.content(me);
      var s = (me.statements && me.statements[turn]) || (c.statements && c.statements[turn]) || null;
      var released = me.statementsReleased && me.statementsReleased[turn];
      var other = (s && s.other) || null;
      if (!other && released && typeof released === "object") {
        other = released.other || { side: shape.adversary(me), sideName: c.side && c.side.adversaryName, statement: released.statement || "", observables: released.observables || [], hotline: released.hotline || [] };
      }
      var own = (s && s.own) || (shape.submission(me, turn) || {}).statement || "";
      return { own: own, released: !!(released || (s && s.released)), other: other };
    },
    surveyUrl: function (me) { return (me.survey && me.survey.url) || ""; },
    debrief: function (me) {
      var d = me.debrief;
      if (!d) return null;
      return d.decisions || d.aiOutputs ? d : normaliseDebrief(me, d);
    },
    consent: function (me) { return !!(me.consent || me.consented); },
    consentText: function (me) { return pick(shape.session(me), ["consentText"]) || pick(me, ["consentText"]) || ""; },
    injects: function (turn) { return (turn && (turn.injects || [])) || []; }
  };

  // The server's debrief ({ own, sides: { side: { name, kind, brief, assessments, submissions, panels } }, branch })
  // plus content.debrief ({ reveal, questions, openings, common }) in the shape debriefView renders.
  function normaliseDebrief(me, d) {
    var cd = shape.content(me).debrief || {};
    var out = { reveal: d.reveal || cd.reveal || null, questions: d.questions || cd.questions || null, sideNames: {}, decisions: {}, assessments: {}, aiOutputs: {}, briefs: {} };
    var sides = d.sides || {};
    Object.keys(sides).forEach(function (side) {
      var v = sides[side] || {};
      out.sideNames[side] = v.name || side;
      out.decisions[side] = v.submissions || {};
      out.assessments[side] = v.assessments || {};
      if (v.panels) {
        out.aiOutputs[side] = {};
        Object.keys(v.panels).forEach(function (turn) { var p = v.panels[turn]; if (p && typeof p === "object" && p.source !== "not_available") out.aiOutputs[side][turn] = p; });
      }
      if (v.brief && side !== d.own) out.briefs[side] = v.brief;
    });
    var branch = d.branch || {};
    out.path = { cells: branch.confirmed || {} };
    if (cd.openings && d.own) {
      var played = branch.cells && branch.cells[d.own];
      var notTaken = {};
      Object.keys(cd.openings).forEach(function (key) {
        if (key === played) return;
        var parts = String(key).split("|");
        var other = shape.adversary(me);
        notTaken[(out.sideNames[d.own] || d.own) + ": " + parts[0] + " · " + (out.sideNames[other] || "the other side") + ": " + parts[1]] = cd.openings[key];
      });
      out.path.openingsNotTaken = notTaken;
    }
    if (d.plenary) out.plenary = d.plenary;
    return out;
  }

  // Fallback labels used only if the server does not send levers.json with the content.
  var DEFAULT_LEVERS = {
    levers: [
      { id: "readiness", label: "Readiness", description: "The alert state of your conventional and strategic forces." },
      { id: "dispersal", label: "Dispersal", description: "Movement of mobile forces out of garrison to dispersed locations." },
      { id: "conventional_posture", label: "Conventional posture", description: "The positioning and activity of your conventional air, naval and ground forces." },
      { id: "nuclear_signalling", label: "Nuclear signalling", description: "Public or private references to your strategic forces." },
      { id: "cyber_response", label: "Cyber response", description: "Cyber operations directed at the other side." },
      { id: "hotline_talks", label: "Hotline and talks", description: "Direct communication with the other side's leadership." },
      { id: "public_statement", label: "Public statement", description: "The tone of your public statement this turn.",
        options: [{ value: "reassure", label: "Reassure" }, { value: "warn", label: "Warn" }, { value: "none", label: "None" }] }
    ],
    decision: {
      assessment: { label: "Your assessment of the situation", maxWords: 60 },
      recommendation: { label: "Your recommended course of action", maxWords: 60 },
      assumption: { label: "One key assumption informing your recommendation", maxWords: 40 },
      risk: { label: "One major risk associated with your recommendation", maxWords: 40 },
      ai_disposition: { label: "Your advice, relative to the assessment you were given", options: [
        { value: "followed", label: "Followed it" }, { value: "modified", label: "Modified it" },
        { value: "rejected", label: "Rejected it" }, { value: "not_available", label: "No assessment was available" }] },
      tools_proposed: { label: "Which measures do you propose using?", multi: true, options: [
        { value: "verification", label: "Verification of the information" }, { value: "red_team", label: "Challenge process or red team" },
        { value: "hotline", label: "Crisis communications (direct channel)" }, { value: "third_party_mediation", label: "Third-party mediation" },
        { value: "none", label: "None" }] },
      nuclear_influence: { label: "Did nuclear risk shape your advice?", options: [
        { value: "no", label: "No" }, { value: "somewhat", label: "Somewhat" }, { value: "decisively", label: "Decisively" }] },
      recommendation_confidence: { label: "How confident are you in your recommendation?", min: 0, max: 100 },
      statement: { label: "Public statement, in character", maxWords: 80 },
      hotline: { label: "Hotline message to the other side", maxWords: 80 }
    },
    assessment: {
      initialTitle: "Initial assessment",
      updatedTitle: "Updated assessment",
      updatedIntro: "Having seen the assessment, please answer the same three questions again.",
      intent: { text: "What do you think the other side intends?", options: [
        { value: "defensive", label: "Defensive" }, { value: "coercive", label: "Coercive" },
        { value: "preparing_to_strike", label: "Preparing to strike" }, { value: "unsure", label: "Unsure" }] },
      probability: { text: "Probability that the other side takes military action against you within the next 72 hours", min: 0, max: 100 },
      confidence: { text: "How confident are you in that judgement?", min: 0, max: 100 }
    }
  };
  var THREE_WAY = [{ value: "raise", label: "Raise" }, { value: "hold", label: "Hold" }, { value: "lower", label: "Lower" }];

  function leverDefs(me) {
    var served = shape.levers(me) || {};
    return {
      levers: served.levers || DEFAULT_LEVERS.levers,
      decision: Object.assign({}, DEFAULT_LEVERS.decision, served.decision || {}),
      assessment: Object.assign({}, DEFAULT_LEVERS.assessment, served.assessment || {})
    };
  }

  function percent(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (isNaN(n)) return null;
    if (n > 0 && n <= 1) n = n * 100;
    return Math.round(n);
  }

  // ---------------------------------------------------------------------------
  // 5. Gate
  // ---------------------------------------------------------------------------

  function gateWith(code, afterPath) {
    return api("POST", "/api/gate", { code: code }, { noAuth: true }).then(function (gate) {
      auth.signIn(gate);
      lastStageAnnounced = null;
      navigate(afterPath || "");
      return gate;
    });
  }

  function gateErrorText(err) {
    if (err.status === 429) {
      var seconds = Number(err.retryAfter) || 60;
      return "Too many attempts; wait " + seconds + " seconds.";
    }
    if (err.status === 401 || err.status === 403 || err.status === 404) return "That code was not recognised.";
    if (!err.status) return "Could not reach the lab server. Check the connection and try again.";
    return "That code was not recognised.";
  }

  function renderGate(opts) {
    opts = opts || {};
    setPoll(null);
    clearTopBar();
    show("gate:" + (opts.participant ? "p" : "g"), function (root) {
      var error = el("div", { class: "notice is-error", role: "alert", id: "gateError" });
      var input = el("input", { type: "text", id: "gateCode", class: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "40", inputmode: "text", required: true });
      var button = el("button", { type: "submit", class: "btn btn-primary" }, "Enter");
      var form = el("form", { class: "card gate", autocomplete: "off" }, [
        el("p", { class: "kicker" }, "Belfer Lab"),
        el("h1", null, opts.participant ? "Join on your phone" : "Enter your access code"),
        el("p", { class: "lede" }, opts.participant
          ? "Enter the code shown on your table's terminal. You will then choose your table number."
          : "Codes are issued by the session facilitator. Nothing you type here is sent anywhere except the lab server."),
        UI.field("Access code", input),
        error,
        el("div", { class: "actions" }, [button])
      ]);
      if (opts.message) { error.textContent = opts.message; }
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var code = input.value.trim();
        if (!code) { input.focus(); return; }
        button.disabled = true;
        error.textContent = "";
        gateWith(code, opts.participant ? "p" : "").catch(function (err) {
          error.textContent = gateErrorText(err);
          button.disabled = false;
          input.focus();
        });
      });
      root.appendChild(form);
      setTimeout(function () { input.focus(); }, 0);
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Group terminal
  // ---------------------------------------------------------------------------

  var group = { me: null };

  function groupStepKey(me, turn) { return "step." + shape.session(me).id + "." + turn; }

  // Which step of the turn loop the terminal should show, from server state plus the
  // locally remembered position (so a reload lands on the same step).
  function groupStep(me, turn) {
    var saved = store.get(groupStepKey(me, turn));
    var sub = shape.submission(me, turn);
    if (sub && (sub.statement || sub.statementAt || sub.statementSubmitted)) return "done";
    if (sub) return "statement";
    var a = shape.assessments(me, turn);
    if (!a.pre) return saved === "pre" ? "pre" : "indicators";
    if (!a.post) return (saved === "post" || saved === "panel") ? saved : "panel";
    if (saved === "panel" || saved === "review" || saved === "decision") return saved;
    return "decision";
  }

  function setGroupStep(me, turn, step) {
    store.set(groupStepKey(me, turn), step);
    renderGroup(me);
  }

  function timerLocked(me) {
    var t = shape.timer(me);
    return !!(t && t.expiry === "lock" && (t.expired || timer.isExpired()));
  }

  function timerFlagged(me) {
    var t = shape.timer(me);
    return !!(t && t.expiry === "flag" && (t.expired || timer.isExpired()));
  }

  function timerBanner(me) {
    var node = el("div", { class: "notice", role: "status" });
    function refresh() {
      if (timerLocked(me)) { node.className = "notice is-error"; node.textContent = "Time is up. The form is locked and your saved answers have been submitted as they stand."; }
      else if (timerFlagged(me)) { node.className = "notice"; node.textContent = "Time is up: submit now."; }
      else { node.textContent = ""; }
    }
    refresh();
    timer.onTick(refresh);
    return node;
  }

  // Autosave: every change is merged into the draft and sent as a PUT, debounced 400 ms.
  // flushDraftNow() sends whatever is pending at once (before Review, Submit and the assessments).
  var pendingPatch = {};
  var pendingTurn = null;
  var saveStatus = null;
  var saveHandle = null;

  function flushDraftNow() {
    clearTimeout(saveHandle);
    saveHandle = null;
    var patch = pendingPatch;
    var turn = pendingTurn;
    pendingPatch = {};
    if (!turn || !Object.keys(patch).length) return Promise.resolve();
    return api("PUT", "/api/me/draft", { turn: turn, patch: patch }).then(function () {
      if (saveStatus) saveStatus.textContent = "Saved";
    }, function (err) {
      Object.keys(patch).forEach(function (k) { if (pendingPatch[k] === undefined) pendingPatch[k] = patch[k]; });
      if (saveStatus) saveStatus.textContent = err.status === 409 ? "Not saved: the turn is closed" : "Not saved; will retry";
    });
  }

  function scheduleSave() {
    clearTimeout(saveHandle);
    saveHandle = setTimeout(flushDraftNow, AUTOSAVE_MS);
  }

  function draftChange(me, turn, patch) {
    var draft = me.draft || (me.draft = {});
    draft[turn] = Object.assign({}, draft[turn] || {}, patch);
    pendingTurn = turn;
    Object.assign(pendingPatch, patch);
    if (saveStatus) saveStatus.textContent = "Saving";
    scheduleSave();
  }

  function saveIndicator() {
    saveStatus = el("span", { class: "faint", role: "status", "aria-live": "polite" });
    return saveStatus;
  }

  function groupTopBar(me) {
    setTopBar({
      scenario: shape.scenario(me).shortTitle || shape.scenario(me).title,
      side: shape.sideName(me),
      turn: turnOfStage(shape.stage(me)),
      stage: shape.stage(me),
      timer: shape.timer(me),
      now: shape.now(me)
    });
  }

  function pollGroup() {
    return api("GET", "/api/me").then(function (me) {
      group.me = me;
      renderGroup(me);
    });
  }

  function renderGroup(me) {
    groupTopBar(me);
    var stage = shape.stage(me);
    var sid = shape.session(me).id;
    if (stage === "setup") return renderGroupWaiting(me);
    if (stage === "briefing") return renderGroupBriefing(me);
    if (stage === "turn1" || stage === "turn2") {
      var turn = turnOfStage(stage);
      var step = groupStep(me, turn);
      var screens = {
        indicators: renderIndicators, pre: renderAssessment, panel: renderPanel, post: renderAssessment,
        decision: renderDecision, review: renderReview, statement: renderStatement, done: renderSubmitted
      };
      return updateScreen(screens[step](me, turn, step, "group:" + sid + ":" + stage + ":" + step), me);
    }
    if (stage === "statements1" || stage === "statements2") return updateScreen(renderStatements(me, turnOfStage(stage)), me);
    if (stage === "survey") return renderSurveyStage(me);
    if (stage === "debrief") return updateScreen(renderDebrief(me), me);
    if (stage === "closed") return renderClosed();
    return renderGroupWaiting(me);
  }

  function renderClosed() {
    setPoll(null);
    show("closed", function (root) {
      root.appendChild(el("div", { class: "waiting" }, [el("strong", null, "This session has closed."), el("span", null, "Thank you for taking part.")]));
    });
  }

  function renderGroupWaiting(me) {
    var ctx = show("group:waiting:" + shape.session(me).id, function (root) {
      var consentNote = el("p", { class: "faint" });
      var consentButton = UI.confirmButton("Record group consent", "Confirm that everyone at the table has read the participant information and agrees to take part?", function () {
        api("POST", "/api/me/event", { type: "consent_group", payload: {} }).then(function () {
          store.set("consent." + shape.session(me).id, "1");
          consentNote.textContent = "Group consent recorded.";
          consentButton.setDisabled(true);
        }, function (err) { consentNote.textContent = "Could not record consent: " + err.message; });
      });
      if (store.get("consent." + shape.session(me).id) || shape.consent(me)) { consentButton.setDisabled(true); consentNote.textContent = "Group consent recorded."; }
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, shape.scenario(me).title || "Belfer Lab"),
        el("h1", null, shape.sideName(me)),
        el("div", { class: "waiting" }, [el("strong", null, "Waiting for the facilitator."), el("span", null, "The briefing will appear here when the session starts.")]),
        el("div", { class: "card is-quiet" }, [
          el("h2", null, "Before you start"),
          el("p", { class: "muted" }, "Each person at the table joins on their own phone using this table's code and a table number (P1 to P12). The group terminal records one consent for the table."),
          el("div", { class: "actions" }, [consentButton]),
          consentNote
        ])
      ]));
    });
    return ctx;
  }

  function capabilitiesTable(me) {
    var bg = shape.background(me);
    var rows = bg.capabilities || [];
    if (!rows.length) return null;
    var names = shape.sideNames(me);
    var sideKeys = [];
    rows.forEach(function (row) { Object.keys(row).forEach(function (k) { if (k !== "category" && sideKeys.indexOf(k) < 0) sideKeys.push(k); }); });
    var head = el("tr", null, [el("th", { scope: "col" }, "Capability")].concat(sideKeys.map(function (k) { return el("th", { scope: "col" }, names[k] || k); })));
    var body = el("tbody", null, rows.map(function (row) {
      return el("tr", null, [el("th", { scope: "row" }, row.category || "")].concat(sideKeys.map(function (k) { return el("td", null, row[k] || ""); })));
    }));
    return el("div", { class: "table-wrap" }, el("table", null, [el("caption", { class: "sr-only" }, "Capabilities of each side"), el("thead", null, head), body]));
  }

  function briefBox(title, items) {
    if (!items || !items.length) return null;
    return el("div", { class: "card" }, [el("h3", null, title), UI.list(items)]);
  }

  function renderGroupBriefing(me) {
    var sid = shape.session(me).id;
    var ctx = show("group:briefing:" + sid, function (root) {
      var bg = shape.background(me);
      var brief = shape.brief(me);
      var readyKey = "ready." + sid;
      var readyNote = el("p", { class: "muted", role: "status" });
      var readyButton = el("button", { type: "button", class: "btn btn-primary" }, "Ready");
      function markReady() {
        readyButton.disabled = true;
        readyNote.textContent = "Ready. Waiting for the facilitator to start Turn 1.";
      }
      if (store.get(readyKey) || me.ready) markReady();
      readyButton.addEventListener("click", function () {
        readyButton.disabled = true;
        api("POST", "/api/me/event", { type: "brief_ready", payload: {} }).then(function () {
          store.set(readyKey, "1");
          markReady();
          UI.announce("Ready recorded.");
        }, function (err) { readyButton.disabled = false; readyNote.textContent = "Could not record ready: " + err.message; });
      });
      var screen = el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Briefing"),
        el("h1", null, shape.scenario(me).title || "Background"),
        el("p", { class: "lede" }, "You are " + shape.sideName(me) + "."),
        bg.role ? el("div", { class: "card is-quiet prose" }, [el("h2", null, "Your role"), UI.paras(bg.role), bg.guidance ? UI.paras(bg.guidance, "muted") : null]) : null,
        el("h2", { class: "section-head" }, "Background"),
        el("div", { class: "prose" }, UI.list(bg.shared || [], false, "plain")),
        capabilitiesTable(me) ? el("div", { class: "card" }, [el("h3", null, "Capabilities"), capabilitiesTable(me)]) : null,
        el("h2", { class: "section-head" }, "Your side"),
        el("div", { class: "grid-3" }, [briefBox("What you know", brief.know), briefBox("What you think you know", brief.estimate), briefBox("Prepared options", brief.options)]),
        el("div", { class: "card is-flag" }, [
          el("p", null, "When the table has read the briefing, press Ready. Each participant should also have completed the consent and the short opening questions on their phone."),
          el("div", { class: "actions" }, [readyButton]),
          readyNote
        ])
      ]);
      root.appendChild(screen);
    });
    return ctx;
  }

  function stepsBar(stepNow) {
    var steps = [["indicators", "Indicators"], ["pre", "Initial assessment"], ["panel", "Assessment"], ["post", "Updated assessment"], ["decision", "Decision"], ["review", "Review"], ["statement", "Statement"]];
    var index = steps.map(function (s) { return s[0]; }).indexOf(stepNow);
    return el("ol", { class: "steps plain", "aria-label": "Steps in this turn" }, steps.map(function (s, i) {
      return el("li", { class: i < index ? "is-done" : (i === index ? "is-current" : ""), "aria-current": i === index ? "step" : null }, (i + 1) + ". " + s[1]);
    }));
  }

  function injectsBlock(turn) {
    var injects = shape.injects(turn);
    if (!injects.length) return null;
    return el("div", { class: "screen" }, injects.map(function (inject) {
      return el("div", { class: "inject", role: "note" }, [el("span", { class: "inject-tag" }, "FACILITATOR INJECT"), UI.paras(typeof inject === "string" ? inject : inject.text)]);
    }));
  }

  // The frame shared by every turn screen: heading, step list, timer banner and injects.
  // update(me2) refreshes the injects from each poll.
  function turnFrame(me, turn, title, step) {
    var injects = el("div");
    var body = el("div", { class: "screen" });
    var node = el("div", { class: "screen" }, [
      el("p", { class: "kicker" }, (shape.scenario(me).shortTitle || "") + " · " + shape.sideName(me) + " · Turn " + turn),
      el("h1", null, title),
      stepsBar(step),
      timerBanner(me),
      injects,
      body
    ]);
    function update(me2) {
      UI.clear(injects);
      var block = injectsBlock(shape.turn(me2));
      if (block) injects.appendChild(block);
    }
    update(me);
    return { node: node, body: body, update: update };
  }

  // 6.1 Indicators
  function renderIndicators(me, turn, step, key) {
    return show(key, function (root) {
      var t = shape.turn(me) || {};
      var openedKey = "indicators." + shape.session(me).id + "." + turn;
      if (!store.get(openedKey)) {
        store.set(openedKey, "1");
        api("POST", "/api/me/event", { type: "indicators_opened", payload: { turn: turn } }).catch(function () { store.remove(openedKey); });
      }
      var next = el("button", { type: "button", class: "btn btn-primary" }, "Continue to the initial assessment");
      next.addEventListener("click", function () { setGroupStep(me, turn, "pre"); });
      var frame = turnFrame(me, turn, "Indicators", "indicators");
      UI.append(frame.body, [
        t.opening && t.opening.length ? el("div", { class: "card prose" }, [el("h2", null, "What has happened"), UI.list(t.opening, false, "plain")]) : null,
        el("div", { class: "card prose" }, [el("h2", null, t.opening ? "Indicators" : "Situation"), UI.list(t.indicators || [], false, "plain")]),
        t.common && t.common.length ? el("div", { class: "card prose" }, UI.list(t.common, false, "plain")) : null,
        t.dilemma ? el("div", { class: "card is-quiet" }, [el("h3", null, "The dilemma"), UI.paras(t.dilemma)]) : null,
        t.questions && t.questions.length ? el("div", { class: "card is-quiet" }, [el("h3", null, "For discussion"), UI.list(t.questions)]) : null,
        el("div", { class: "actions is-end" }, [next])
      ]);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  // 6.2 / 6.5 Initial and updated assessment (three fields; the API calls the phase "pre"/"post")
  function renderAssessment(me, turn, step, key) {
    var phase = step === "pre" ? "pre" : "post";
    return show(key, function (root) {
      var defs = leverDefs(me).assessment;
      var draft = shape.draft(me, turn);
      var prefix = phase + "_";
      var values = {
        intent: draft[prefix + "intent"] || null,
        probability: draft[prefix + "probability"] === undefined || draft[prefix + "probability"] === null ? null : Number(draft[prefix + "probability"]),
        confidence: draft[prefix + "confidence"] === undefined || draft[prefix + "confidence"] === null ? null : Number(draft[prefix + "confidence"])
      };
      var locked = timerLocked(me);
      var error = el("div", { class: "notice is-error", role: "alert" });
      var submit = el("button", { type: "button", class: "btn btn-primary" }, phase === "pre" ? "Open assessment" : "Continue to the decision");
      function checkComplete() { submit.disabled = locked || values.intent === null || values.probability === null || values.confidence === null; }

      var intentGroup = el("fieldset", { class: "choices" }, [el("legend", null, defs.intent.text)]);
      (defs.intent.options || []).forEach(function (opt) {
        var radio = el("input", { type: "radio", name: phase + "-intent", value: opt.value, id: phase + "-intent-" + opt.value });
        if (values.intent === opt.value) radio.checked = true;
        if (locked) radio.disabled = true;
        var label = el("label", { class: "choice" + (radio.checked ? " is-checked" : ""), for: radio.id }, [radio, el("span", null, opt.label)]);
        radio.addEventListener("change", function () {
          values.intent = opt.value;
          Array.prototype.forEach.call(intentGroup.querySelectorAll(".choice"), function (c) { c.classList.toggle("is-checked", c.querySelector("input").checked); });
          var patch = {}; patch[prefix + "intent"] = opt.value;
          draftChange(me, turn, patch);
          checkComplete();
        });
        intentGroup.appendChild(label);
      });

      function slider(fieldKey, def) {
        var input = el("input", { type: "range", min: String(def.min || 0), max: String(def.max || 100), step: "1", id: phase + "-" + fieldKey });
        var output = el("output", { for: input.id, class: values[fieldKey] === null ? "is-unset" : "" }, values[fieldKey] === null ? "Not set" : String(values[fieldKey]));
        input.value = values[fieldKey] === null ? "50" : String(values[fieldKey]);
        if (locked) input.disabled = true;
        input.setAttribute("aria-valuetext", values[fieldKey] === null ? "not set" : values[fieldKey] + " per cent");
        input.addEventListener("input", function () {
          values[fieldKey] = Number(input.value);
          output.textContent = String(values[fieldKey]);
          output.className = "";
          input.setAttribute("aria-valuetext", values[fieldKey] + " per cent");
          var patch = {}; patch[prefix + fieldKey] = values[fieldKey];
          draftChange(me, turn, patch);
          checkComplete();
        });
        return el("div", { class: "field" }, [el("label", { for: input.id }, def.text), el("div", { class: "range-row" }, [input, output]), el("div", { class: "help" }, "0 to 100. Move the slider to set a value.")]);
      }

      submit.addEventListener("click", function () {
        submit.disabled = true;
        error.textContent = "";
        flushDraftNow().then(function () {
          return api("POST", "/api/me/assess", { turn: turn, phase: phase, intent: values.intent, probability: values.probability, confidence: values.confidence });
        }).then(function () {
          var a = me.assessments || (me.assessments = {});
          a[turn] = Object.assign({}, a[turn] || {});
          a[turn][phase] = { intent: values.intent, probability: values.probability, confidence: values.confidence };
          store.set("panelArrived." + shape.session(me).id + "." + turn, String(Math.round(performance.now())));
          setGroupStep(me, turn, phase === "pre" ? "panel" : "decision");
          pollNow();
        }, function (err) {
          error.textContent = "Could not save the assessment: " + err.message;
          submit.disabled = false;
        });
      });
      checkComplete();

      var back = el("button", { type: "button", class: "btn btn-quiet" }, phase === "pre" ? "Back to the indicators" : "Back to the assessment panel");
      back.addEventListener("click", function () { setGroupStep(me, turn, phase === "pre" ? "indicators" : "panel"); });

      var frame = turnFrame(me, turn, phase === "pre" ? defs.initialTitle : defs.updatedTitle, step);
      UI.append(frame.body, [
        phase === "post" ? el("p", { class: "lede" }, defs.updatedIntro) : el("p", { class: "lede" }, "Record the group's view before the assessment is opened. All three answers are needed."),
        el("div", { class: "card" }, [intentGroup, slider("probability", defs.probability), slider("confidence", defs.confidence)]),
        error,
        el("div", { class: "actions" }, [back, submit, saveIndicator()])
      ]);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  // 6.3 / 6.4 Assessment panel and governance actions
  function renderPanel(me, turn, step, key) {
    return show(key, function (root) {
      var sid = shape.session(me).id;
      var openedKey = "panelOpened." + sid + "." + turn;
      var t = shape.turn(me) || {};
      var opened = !!(store.get(openedKey) || t.panelOpened || shape.panelOpened(me, turn));
      var arrivedAt = Number(store.get("panelArrived." + sid + "." + turn)) || performance.now();
      var content = el("div", { class: "screen" });
      var openButton = el("button", { type: "button", class: "btn btn-primary" }, "Open assessment");
      var openNote = el("p", { class: "muted", role: "status" });
      var gateCard = el("div", { class: "card is-flag" }, [
        el("p", null, "The assessment for this turn is ready to be opened. Opening it is recorded."),
        el("div", { class: "actions" }, [openButton]),
        openNote
      ]);
      var measuresCard = el("div");
      var assistantCard = el("div");
      var next = el("button", { type: "button", class: "btn btn-primary" }, "Continue to the updated assessment");
      next.addEventListener("click", function () { setGroupStep(me, turn, "post"); });
      var back = el("button", { type: "button", class: "btn btn-quiet" }, "Back");
      back.addEventListener("click", function () { setGroupStep(me, turn, shape.assessments(me, turn).post ? "decision" : "pre"); });
      next.disabled = !opened;

      openButton.addEventListener("click", function () {
        openButton.disabled = true;
        var waitMs = Math.max(0, Math.round(performance.now() - arrivedAt));
        api("POST", "/api/me/event", { type: "panel_opened", payload: { turn: turn, wait_ms: waitMs, client_elapsed_ms: waitMs } }).then(function () {
          store.set(openedKey, "1");
          opened = true;
          update(group.me || me);
          UI.announce("Assessment opened.");
        }, function (err) { openButton.disabled = false; openNote.textContent = "Could not open: " + err.message; });
      });

      var frame = turnFrame(me, turn, "Assessment", "panel");
      UI.append(frame.body, [gateCard, content, measuresCard, assistantCard, el("div", { class: "actions" }, [back, next])]);
      root.appendChild(frame.node);

      var lastPanelJson = null;
      var measuresBuilt = false;
      function update(me2) {
        frame.update(me2);
        var t2 = shape.turn(me2) || {};
        var ai = shape.ai(me2);
        var preparing = !!(ai && ai.status && ai.status !== "approved") || t2.panel === "pending";
        var panel = t2.panel && typeof t2.panel === "object" ? t2.panel : null;
        var notAvailable = !!(panel && (panel.status === "not_available" || panel.source === "not_available")) || t2.panelNotAvailable === true || (t2.analysts && !panel && !preparing && !ai);
        if (!opened) {
          gateCard.hidden = false;
          if (preparing) {
            openButton.disabled = true;
            openButton.textContent = "Assessment being prepared";
            openNote.textContent = "Please wait. The assessment will open when it is ready.";
          } else {
            openButton.disabled = false;
            openButton.textContent = "Open assessment";
            openNote.textContent = "";
          }
          return;
        }
        gateCard.hidden = true;
        next.disabled = false;
        var json = JSON.stringify([panel, t2.analysts, notAvailable]);
        if (json !== lastPanelJson) {
          lastPanelJson = json;
          UI.clear(content);
          if (panel && !notAvailable) content.appendChild(panelView(me2, turn, panel));
          if (notAvailable || (!panel && t2.analysts)) {
            content.appendChild(el("div", { class: "card" }, [el("h2", null, "Analysts' note"), UI.paras(t2.analysts || "No assessment is available to your side this turn.")]));
          } else if (t2.analysts) {
            content.appendChild(el("div", { class: "card is-quiet" }, [el("h3", null, "Analysts' note"), UI.paras(t2.analysts)]));
          }
          if (!panel && !t2.analysts && !preparing) content.appendChild(el("div", { class: "notice" }, "The assessment has not arrived yet. This page refreshes on its own."));
        }
        if (!measuresBuilt) {
          measuresBuilt = true;
          var measures = measuresView(me2, turn);
          measuresCard.appendChild(measures);
          measuresCard.refresh = measures.refresh;
          if (shape.assistantEnabled(me2)) assistantCard.appendChild(assistantDrawer(me2, turn));
        }
        if (measuresCard.refresh) measuresCard.refresh(me2);
      }
      update(me);
      return { update: update };
    });
  }

  function panelView(me, turn, panel) {
    var roles = shape.panelRoles(panel);
    var wrap = el("div", { class: "card" }, [el("h2", null, panel.heading || "Assessment panel")]);
    var sid = shape.session(me).id;
    roles.forEach(function (role) {
      var head = el("div", { class: "panel-role-head" }, [
        role.source ? el("div", { class: "panel-role-source" }, role.source) : null,
        el("div", { class: "panel-role-title" }, role.title || ""),
        percent(role.confidence) !== null ? el("div", { class: "panel-role-confidence" }, "Confidence " + percent(role.confidence) + "%") : null
      ]);
      var body = el("div", { class: "prose" }, [role.headline ? el("p", { class: "panel-headline" }, role.headline) : null, UI.paras(role.body)]);
      var block = el("section", { class: "panel-role", "aria-label": (role.source ? role.source + " " : "") + (role.title || "") }, [head, body]);
      if (role.pathways && role.pathways.length) {
        block.appendChild(el("div", { class: "pathways" }, role.pathways.map(function (p) {
          var figures = [];
          if (percent(p.probability) !== null) figures.push(percent(p.probability) + "%");
          if (p.window) figures.push(p.window);
          return el("div", { class: "pathway" }, [el("span", null, p.label || ""), el("span", { class: "pathway-figures" }, figures.join(" · "))]);
        })));
      }
      if (role.reasoning) {
        var details = el("details", null, [el("summary", null, "Show reasoning"), el("div", { class: "details-body" }, UI.paras(role.reasoning))]);
        details.addEventListener("toggle", function () {
          if (!details.open) return;
          var k = "reasoning." + sid + "." + turn + "." + role.key;
          if (store.get(k)) return;
          store.set(k, "1");
          api("POST", "/api/me/event", { type: "reasoning_opened", payload: { turn: turn, role: role.key } }).catch(function () { store.remove(k); });
        });
        block.appendChild(details);
      }
      wrap.appendChild(block);
    });
    return wrap;
  }

  // Governance actions: verification, red team, hotline, risk-reduction measures.
  function measuresView(me, turn) {
    var defs = leverDefs(me).decision;
    var wrap = el("div", { class: "card measures" }, [el("h2", null, "Measures"), el("p", { class: "muted" }, "Each measure is recorded when it is used.")]);
    var t = shape.turn(me) || {};
    var actions = t.actions || {};

    // Verification
    var verifyResult = el("div", { class: "measure-result" });
    var verifyNote = el("p", { class: "muted", role: "status" });
    var verifyButton = UI.confirmButton("Request verification", "Request verification of the information? The result takes a few minutes of turn time.", function () {
      verifyButton.setDisabled(true);
      api("POST", "/api/me/action", { turn: turn, action: "verification", payload: {} }).then(function (res) {
        verifyNote.textContent = "Verification requested. The result will appear here when it arrives.";
        if (res && res.result) showVerification(res.result);
        pollNow();
      }, function (err) {
        if (err.code === "not_available") { verifyNote.textContent = "No further verification is available to your side this turn."; return; }
        if (err.code === "already_requested") { verifyNote.textContent = "Verification has already been requested."; return; }
        verifyNote.textContent = "Could not request verification: " + err.message; verifyButton.setDisabled(false);
      });
    });
    function showVerification(text) {
      verifyButton.setDisabled(true);
      verifyNote.textContent = "";
      UI.clear(verifyResult);
      UI.append(verifyResult, [el("span", { class: "tag" }, "Verification result"), UI.paras(text)]);
    }
    wrap.appendChild(el("div", { class: "measure" }, [el("h3", null, "Request verification"), el("div", { class: "actions" }, [verifyButton]), verifyNote, verifyResult]));

    // Red team
    var redResult = el("div", { class: "measure-result" });
    var redNote = el("p", { class: "muted", role: "status" });
    var redButton = UI.confirmButton("Convene a red team", "Convene a red team to challenge the assessment?", function () {
      redButton.setDisabled(true);
      api("POST", "/api/me/action", { turn: turn, action: "red_team", payload: {} }).then(function (res) {
        showRedTeam((res && (res.result || res.redTeam)) || "");
        pollNow();
      }, function (err) { redNote.textContent = "Could not convene: " + err.message; redButton.setDisabled(false); });
    });
    function showRedTeam(text) {
      redButton.setDisabled(true);
      UI.clear(redResult);
      UI.append(redResult, [el("span", { class: "tag" }, "Red team"), UI.paras(text || "The red team's note will appear here.")]);
    }
    wrap.appendChild(el("div", { class: "measure" }, [el("h3", null, "Convene a red team"), el("div", { class: "actions" }, [redButton]), redNote, redResult]));

    // Hotline
    var hotlineInput = el("textarea", { id: "hotline-" + turn, rows: "3" });
    var hotlineCount = el("span", { class: "count" }, "0 / " + (defs.hotline.maxWords || 80) + " words");
    var hotlineSent = el("div", { class: "measure-result" });
    var hotlineNote = el("p", { class: "muted", role: "status" });
    hotlineInput.addEventListener("input", function () { updateCount(hotlineCount, hotlineInput.value, defs.hotline.maxWords || 80); });
    var hotlineButton = UI.confirmButton("Send hotline message", "Send this message to the other side? It is delivered at the next report-back.", function () {
      var text = hotlineInput.value.trim();
      if (!text) { hotlineNote.textContent = "Write the message first."; return; }
      if (UI.wordCount(text) > (defs.hotline.maxWords || 80)) { hotlineNote.textContent = "The message is over the word limit."; return; }
      hotlineButton.setDisabled(true);
      api("POST", "/api/me/action", { turn: turn, action: "hotline", payload: { text: text } }).then(function () {
        hotlineNote.textContent = "";
        UI.append(hotlineSent, el("div", null, [el("span", { class: "tag" }, "Sent"), UI.paras(text)]));
        hotlineInput.value = "";
        updateCount(hotlineCount, "", defs.hotline.maxWords || 80);
        hotlineButton.setDisabled(false);
      }, function (err) { hotlineNote.textContent = "Could not send: " + err.message; hotlineButton.setDisabled(false); });
    });
    wrap.appendChild(el("div", { class: "measure" }, [
      el("h3", null, "Hotline message"),
      UI.field(defs.hotline.label || "Hotline message to the other side", hotlineInput, { help: "Delivered verbatim to the other side at the next report-back.", after: hotlineCount }),
      el("div", { class: "actions" }, [hotlineButton]), hotlineNote, hotlineSent
    ]));

    // Risk-reduction measures
    var rr = shape.riskReduction(me);
    var rrNote = el("p", { class: "muted", role: "status" });
    var rrGroup = el("fieldset", { class: "choices" }, [el("legend", null, "Propose risk-reduction measures")]);
    var rrBoxes = [];
    rr.forEach(function (item) {
      var box = el("input", { type: "checkbox", id: "rr-" + turn + "-" + item.id, value: item.id });
      rrBoxes.push(box);
      var label = el("label", { class: "choice", for: box.id }, [box, el("span", null, item.label)]);
      box.addEventListener("change", function () { label.classList.toggle("is-checked", box.checked); });
      rrGroup.appendChild(label);
    });
    var rrButton = UI.confirmButton("Propose selected measures", "Record the selected measures as proposed?", function () {
      var selected = rrBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      if (!selected.length) { rrNote.textContent = "Select at least one measure."; return; }
      rrButton.setDisabled(true);
      api("POST", "/api/me/action", { turn: turn, action: "risk_reduction", payload: { measures: selected } }).then(function () {
        rrNote.textContent = "Proposed: " + selected.map(function (id) { var f = rr.filter(function (x) { return x.id === id; })[0]; return f ? f.label : id; }).join("; ");
        rrButton.setDisabled(false);
      }, function (err) { rrNote.textContent = "Could not record: " + err.message; rrButton.setDisabled(false); });
    });
    if (rr.length) wrap.appendChild(el("div", { class: "measure" }, [rrGroup, el("div", { class: "actions" }, [rrButton]), rrNote]));

    // Restore from the server's view of this turn (after a reload or on delivery).
    wrap.refresh = function (me2) {
      var t2 = shape.turn(me2) || {};
      var a = Object.assign({}, shape.actions(me2, turn), t2.actions || {});
      var v = a.verification || t2.verification || null;
      if (v) {
        if (v.result) showVerification(v.result);
        else if (v.requested || v.requestedAt) { verifyButton.setDisabled(true); if (!verifyNote.textContent) verifyNote.textContent = "Verification requested. The result will appear here when it arrives."; }
        else if (v.available === false) { verifyButton.setDisabled(true); verifyNote.textContent = "No further verification is available to your side this turn."; }
      }
      var red = t2.redTeam || (a.redTeam && (a.redTeam.text || a.redTeam.result)) || null;
      if (red && typeof red === "string" && !redResult.childNodes.length) showRedTeam(red);
      var sent = a.hotline || t2.hotline || [];
      if (Array.isArray(sent) && sent.length && !hotlineSent.childNodes.length) {
        sent.forEach(function (h) { UI.append(hotlineSent, el("div", null, [el("span", { class: "tag" }, "Sent"), UI.paras(typeof h === "string" ? h : h.text)])); });
      }
      var proposed = a.riskReduction || t2.riskReductionProposed || [];
      if (Array.isArray(proposed) && proposed.length) {
        var ids = [];
        proposed.forEach(function (p) { if (typeof p === "string") ids.push(p); else if (p && Array.isArray(p.measures)) ids = ids.concat(p.measures); else if (p && p.id) ids.push(p.id); });
        rrBoxes.forEach(function (b) { if (ids.indexOf(b.value) >= 0 && !b.checked) { b.checked = true; b.dispatchEvent(new Event("change")); } });
      }
    };
    wrap.refresh(me);
    var holder = el("div");
    holder.appendChild(wrap);
    holder.refresh = wrap.refresh;
    return holder;
  }

  function updateCount(node, text, max) {
    var n = UI.wordCount(text);
    node.textContent = n + " / " + max + " words";
    node.classList.toggle("is-over", n > max);
  }

  // "Ask the assistant": one thread per side per turn, replies streamed over fetch.
  function assistantDrawer(me, turn) {
    var body = el("div", { class: "drawer-body", role: "log", "aria-live": "polite", "aria-label": "Assistant conversation" });
    var input = el("textarea", { id: "assistant-input-" + turn, rows: "2" });
    var send = el("button", { type: "submit", class: "btn btn-primary" }, "Send");
    var form = el("form", { class: "drawer-form" }, [UI.field("Your question", input), send]);
    var toggle = el("button", { type: "button", class: "btn btn-small", "aria-expanded": "false" }, "Ask the assistant");
    var inner = el("div", { hidden: true }, [body, form]);
    var drawer = el("section", { class: "drawer", "aria-label": "Ask the assistant" }, [el("div", { class: "drawer-head" }, [el("h2", null, "Ask the assistant"), toggle]), inner]);
    var loaded = false;

    function addMessage(role, text) {
      var msg = el("div", { class: "msg " + (role === "user" ? "is-user" : (role === "error" ? "is-error" : "is-assistant")) }, [el("span", { class: "msg-role" }, role === "user" ? "You" : (role === "error" ? "Notice" : "Assistant"))]);
      var textNode = el("div");
      textNode.appendChild(UI.paras(text));
      msg.appendChild(textNode);
      body.appendChild(msg);
      body.scrollTop = body.scrollHeight;
      return { set: function (t) { UI.clear(textNode); textNode.appendChild(UI.paras(t)); body.scrollTop = body.scrollHeight; } };
    }

    function load() {
      if (loaded) return;
      loaded = true;
      api("GET", "/api/me/assistant?turn=" + turn).then(function (res) {
        UI.clear(body);
        ((res && res.messages) || []).forEach(function (m) { addMessage(m.role === "user" ? "user" : "assistant", m.text || m.content || ""); });
        if (!body.childNodes.length) body.appendChild(el("p", { class: "faint" }, "Ask about your side's materials and the assessment. The assistant answers only from what your side has."));
      }, function (err) { addMessage("error", err.code === "assistant_disabled" ? "The assistant is not available." : "Could not load the conversation: " + err.message); });
    }

    toggle.addEventListener("click", function () {
      var open = inner.hidden;
      inner.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "Close" : "Ask the assistant";
      if (open) { load(); input.focus(); }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) { input.focus(); return; }
      input.value = "";
      send.disabled = true;
      addMessage("user", text);
      var reply = addMessage("assistant", "");
      var accumulated = "";
      streamPost("/api/me/assistant", { turn: turn, text: text }, function (event) {
        if (event.delta) { accumulated += String(event.delta); reply.set(accumulated); }
        if (event.error) { reply.set(accumulated + (accumulated ? "\n" : "") + "The assistant could not answer: " + String(event.message || event.error)); }
      }).then(function () {
        if (!accumulated) reply.set("No reply was received.");
      }, function (err) {
        reply.set(err.code === "assistant_disabled" ? "The assistant is not available for this session." : "The assistant could not answer: " + err.message);
      }).then(function () { send.disabled = false; input.focus(); });
    });
    return drawer;
  }

  // 6.6 Decision entry
  var DECISION_TEXT_FIELDS = ["assessment", "recommendation", "assumption", "risk"];
  var LEVER_IDS = ["readiness", "dispersal", "conventional_posture", "nuclear_signalling", "cyber_response", "hotline_talks", "public_statement"];

  function decisionProblems(me, turn) {
    var defs = leverDefs(me);
    var d = shape.draft(me, turn);
    var problems = [];
    DECISION_TEXT_FIELDS.forEach(function (f) {
      var def = defs.decision[f] || {};
      var text = String(d[f] || "").trim();
      if (!text) problems.push(def.label || f);
      else if (def.maxWords && UI.wordCount(text) > def.maxWords) problems.push((def.label || f) + " (over " + def.maxWords + " words)");
    });
    defs.levers.forEach(function (lever) { if (!d[lever.id]) problems.push(lever.label || lever.id); });
    if (!d.ai_disposition) problems.push(defs.decision.ai_disposition.label);
    if (!Array.isArray(d.tools_proposed) || !d.tools_proposed.length) problems.push(defs.decision.tools_proposed.label);
    if (!d.nuclear_influence) problems.push(defs.decision.nuclear_influence.label);
    if (d.recommendation_confidence === undefined || d.recommendation_confidence === null || d.recommendation_confidence === "") problems.push(defs.decision.recommendation_confidence.label);
    return problems;
  }

  function renderDecision(me, turn, step, key) {
    return show(key, function (root) {
      var defs = leverDefs(me);
      var draft = shape.draft(me, turn);
      var locked = timerLocked(me);
      var form = el("form", { class: "screen", "aria-label": "Decision form" });
      form.addEventListener("submit", function (e) { e.preventDefault(); });
      if (locked) form.classList.add("is-locked");

      function textField(fieldKey) {
        var def = defs.decision[fieldKey] || {};
        var input = el("textarea", { id: "d-" + fieldKey, rows: "3" });
        input.value = draft[fieldKey] || "";
        if (locked) input.disabled = true;
        var count = el("span", { class: "count" });
        updateCount(count, input.value, def.maxWords || 60);
        input.addEventListener("input", function () {
          updateCount(count, input.value, def.maxWords || 60);
          var patch = {}; patch[fieldKey] = input.value;
          draftChange(me, turn, patch);
        });
        return UI.field(def.label || fieldKey, input, { help: "One line, up to " + (def.maxWords || 60) + " words.", after: count });
      }

      function leverControl(lever) {
        var options = lever.options || THREE_WAY;
        var seg = el("div", { class: "segmented", role: "radiogroup", "aria-labelledby": "lever-" + lever.id + "-label" });
        options.forEach(function (opt) {
          var radio = el("input", { type: "radio", name: "lever-" + lever.id, value: opt.value, id: "lever-" + lever.id + "-" + opt.value });
          if (draft[lever.id] === opt.value) radio.checked = true;
          if (locked) radio.disabled = true;
          var label = el("label", { for: radio.id, class: radio.checked ? "is-checked" : "" }, [radio, opt.label]);
          radio.addEventListener("change", function () {
            Array.prototype.forEach.call(seg.querySelectorAll("label"), function (l) { l.classList.toggle("is-checked", l.querySelector("input").checked); });
            var patch = {}; patch[lever.id] = opt.value;
            draftChange(me, turn, patch);
          });
          seg.appendChild(label);
        });
        return el("div", { class: "lever" }, [
          el("div", { class: "lever-head" }, [el("span", { id: "lever-" + lever.id + "-label", class: "label" }, lever.label || lever.id), lever.description ? el("span", { class: "lever-desc" }, lever.description) : null]),
          seg
        ]);
      }

      function radioField(fieldKey) {
        var def = defs.decision[fieldKey];
        var group = el("fieldset", { class: "choices" }, [el("legend", null, def.label)]);
        (def.options || []).forEach(function (opt) {
          var radio = el("input", { type: "radio", name: "d-" + fieldKey, value: opt.value, id: "d-" + fieldKey + "-" + opt.value });
          if (draft[fieldKey] === opt.value) radio.checked = true;
          if (locked) radio.disabled = true;
          var label = el("label", { class: "choice" + (radio.checked ? " is-checked" : ""), for: radio.id }, [radio, el("span", null, opt.label)]);
          radio.addEventListener("change", function () {
            Array.prototype.forEach.call(group.querySelectorAll(".choice"), function (c) { c.classList.toggle("is-checked", c.querySelector("input").checked); });
            var patch = {}; patch[fieldKey] = opt.value;
            draftChange(me, turn, patch);
          });
          group.appendChild(label);
        });
        return group;
      }

      function multiField(fieldKey) {
        var def = defs.decision[fieldKey];
        var group = el("fieldset", { class: "choices" }, [el("legend", null, def.label)]);
        var selected = Array.isArray(draft[fieldKey]) ? draft[fieldKey].slice() : [];
        (def.options || []).forEach(function (opt) {
          var box = el("input", { type: "checkbox", name: "d-" + fieldKey, value: opt.value, id: "d-" + fieldKey + "-" + opt.value });
          if (selected.indexOf(opt.value) >= 0) box.checked = true;
          if (locked) box.disabled = true;
          var label = el("label", { class: "choice" + (box.checked ? " is-checked" : ""), for: box.id }, [box, el("span", null, opt.label)]);
          box.addEventListener("change", function () {
            label.classList.toggle("is-checked", box.checked);
            selected = Array.prototype.map.call(group.querySelectorAll("input:checked"), function (b) { return b.value; });
            var patch = {}; patch[fieldKey] = selected;
            draftChange(me, turn, patch);
          });
          group.appendChild(label);
        });
        return group;
      }

      function confidenceField() {
        var def = defs.decision.recommendation_confidence;
        var input = el("input", { type: "range", min: String(def.min || 0), max: String(def.max || 100), step: "1", id: "d-recommendation_confidence" });
        var has = draft.recommendation_confidence !== undefined && draft.recommendation_confidence !== null && draft.recommendation_confidence !== "";
        input.value = has ? String(draft.recommendation_confidence) : "50";
        if (locked) input.disabled = true;
        var output = el("output", { for: input.id, class: has ? "" : "is-unset" }, has ? String(draft.recommendation_confidence) : "Not set");
        input.addEventListener("input", function () {
          output.textContent = input.value; output.className = "";
          draftChange(me, turn, { recommendation_confidence: Number(input.value) });
        });
        return el("div", { class: "field" }, [el("label", { for: input.id }, def.label), el("div", { class: "range-row" }, [input, output]), el("div", { class: "help" }, "0 to 100.")]);
      }

      var problems = el("div", { class: "notice", role: "alert" });
      var review = el("button", { type: "button", class: "btn btn-primary" }, "Review");
      review.addEventListener("click", function () {
        var missing = decisionProblems(me, turn);
        if (missing.length) {
          UI.clear(problems);
          UI.append(problems, [el("p", null, "Before review, complete: "), UI.list(missing)]);
          problems.scrollIntoView({ block: "nearest" });
          return;
        }
        problems.textContent = "";
        flushDraftNow();
        setGroupStep(me, turn, "review");
      });
      var back = el("button", { type: "button", class: "btn btn-quiet" }, "Back to the assessment panel");
      back.addEventListener("click", function () { setGroupStep(me, turn, "panel"); });

      var frame = turnFrame(me, turn, "Decision", "decision");
      UI.append(form, [
        el("p", { class: "lede" }, "Record the group's advice to national leadership. Everything is saved as you type."),
        el("div", { class: "card" }, [textField("assessment")]),
        el("div", { class: "card" }, [el("h2", null, "Levers")].concat(defs.levers.map(leverControl))),
        el("div", { class: "card" }, [textField("recommendation"), textField("assumption"), textField("risk")]),
        el("div", { class: "card" }, [radioField("ai_disposition"), multiField("tools_proposed"), radioField("nuclear_influence"), confidenceField()]),
        problems,
        el("div", { class: "actions" }, [back, review, saveIndicator()])
      ]);
      frame.body.appendChild(form);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  function recordView(me, record, opts) {
    opts = opts || {};
    var defs = leverDefs(me);
    var wrap = el("div", { class: "record" });
    function labelFor(fieldKey, value) {
      var def = defs.decision[fieldKey];
      if (!def || !def.options) return value;
      var found = def.options.filter(function (o) { return o.value === value; })[0];
      return found ? found.label : value;
    }
    if (opts.assessments) {
      ["pre", "post"].forEach(function (phase) {
        var a = opts.assessments[phase];
        if (!a) return;
        var intentLabel = (defs.assessment.intent.options.filter(function (o) { return o.value === a.intent; })[0] || {}).label || a.intent;
        wrap.appendChild(UI.recordRow(phase === "pre" ? defs.assessment.initialTitle : defs.assessment.updatedTitle,
          "Intent: " + (intentLabel || "—") + "; probability " + (a.probability === undefined || a.probability === null ? "—" : a.probability + "%") + "; confidence " + (a.confidence === undefined || a.confidence === null ? "—" : a.confidence + "%")));
      });
    }
    wrap.appendChild(UI.recordRow(defs.decision.assessment.label, record.assessment));
    defs.levers.forEach(function (lever) {
      var options = lever.options || THREE_WAY;
      var found = options.filter(function (o) { return o.value === record[lever.id]; })[0];
      wrap.appendChild(UI.recordRow(lever.label, found ? found.label : record[lever.id]));
    });
    ["recommendation", "assumption", "risk"].forEach(function (f) { wrap.appendChild(UI.recordRow(defs.decision[f].label, record[f])); });
    wrap.appendChild(UI.recordRow(defs.decision.ai_disposition.label, labelFor("ai_disposition", record.ai_disposition)));
    wrap.appendChild(UI.recordRow(defs.decision.tools_proposed.label, Array.isArray(record.tools_proposed) ? record.tools_proposed.map(function (v) { return labelFor("tools_proposed", v); }) : record.tools_proposed));
    wrap.appendChild(UI.recordRow(defs.decision.nuclear_influence.label, labelFor("nuclear_influence", record.nuclear_influence)));
    wrap.appendChild(UI.recordRow(defs.decision.recommendation_confidence.label, record.recommendation_confidence === undefined || record.recommendation_confidence === null ? null : record.recommendation_confidence + "%"));
    if (opts.statement !== undefined) wrap.appendChild(UI.recordRow(defs.decision.statement.label, opts.statement));
    return wrap;
  }

  function renderReview(me, turn, step, key) {
    return show(key, function (root) {
      var sid = shape.session(me).id;
      var reviewKey = "review." + sid + "." + turn;
      if (!store.get(reviewKey)) {
        store.set(reviewKey, "1");
        api("POST", "/api/me/event", { type: "review_opened", payload: { turn: turn } }).catch(function () { store.remove(reviewKey); });
      }
      var error = el("div", { class: "notice is-error", role: "alert" });
      var back = el("button", { type: "button", class: "btn btn-quiet" }, "Back to edit");
      back.addEventListener("click", function () { setGroupStep(me, turn, "decision"); });
      var submit = UI.confirmButton("Submit as the group's advice", "Submit this record? It cannot be changed afterwards.", function () {
        submit.setDisabled(true);
        flushDraftNow().then(function () { return api("POST", "/api/me/submit", { turn: turn }); }).then(function (res) {
          var subs = me.submissions || (me.submissions = {});
          subs[turn] = Object.assign({}, subs[turn] || {}, { record: (res && res.record) || shape.draft(me, turn) });
          UI.announce("Advice submitted.");
          setGroupStep(me, turn, "statement");
          pollNow();
        }, function (err) {
          error.textContent = "Could not submit: " + err.message;
          submit.setDisabled(false);
        });
      }, { class: "btn-primary", yesLabel: "Submit" });
      var frame = turnFrame(me, turn, "Review", "review");
      UI.append(frame.body, [
        el("p", { class: "lede" }, "Read the record through. Submitting freezes it as the group's advice for this turn."),
        el("div", { class: "card" }, recordView(me, shape.draft(me, turn), { assessments: shape.assessments(me, turn) })),
        error,
        el("div", { class: "actions" }, [back, submit])
      ]);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  // 6.7 Public statement
  function renderStatement(me, turn, step, key) {
    return show(key, function (root) {
      var defs = leverDefs(me).decision;
      var draft = shape.draft(me, turn);
      var locked = timerLocked(me);
      var max = defs.statement.maxWords || 80;
      var input = el("textarea", { id: "statement-" + turn, rows: "5" });
      input.value = draft.statement || "";
      if (locked) input.disabled = true;
      var count = el("span", { class: "count" });
      updateCount(count, input.value, max);
      input.addEventListener("input", function () { updateCount(count, input.value, max); draftChange(me, turn, { statement: input.value }); });
      var error = el("div", { class: "notice is-error", role: "alert" });
      var submit = UI.confirmButton("Submit statement", "Submit this public statement? It will be shown to the other side.", function () {
        var text = input.value.trim();
        if (!text) { error.textContent = "Write the statement first."; return; }
        if (UI.wordCount(text) > max) { error.textContent = "The statement is over " + max + " words."; return; }
        submit.setDisabled(true);
        flushDraftNow().then(function () { return api("POST", "/api/me/statement", { turn: turn, text: text }); }).then(function () {
          var subs = me.submissions || (me.submissions = {});
          subs[turn] = Object.assign({}, subs[turn] || {}, { statement: text });
          UI.announce("Statement submitted.");
          setGroupStep(me, turn, "done");
          pollNow();
        }, function (err) { error.textContent = "Could not submit: " + err.message; submit.setDisabled(false); });
      }, { class: "btn-primary", yesLabel: "Submit" });
      var frame = turnFrame(me, turn, "Public statement", "statement");
      UI.append(frame.body, [
        el("p", { class: "lede" }, "Your advice has been submitted. Now write the public statement your side issues this turn, in character."),
        el("div", { class: "card" }, [UI.field(defs.statement.label, input, { help: "Up to " + max + " words. Required.", after: count })]),
        error,
        el("div", { class: "actions" }, [submit, saveIndicator()])
      ]);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  // 6.8 Submitted: the frozen record, then waiting.
  function renderSubmitted(me, turn, step, key) {
    return show(key, function (root) {
      var sub = shape.submission(me, turn) || {};
      var record = sub.record || shape.draft(me, turn);
      var frame = turnFrame(me, turn, "Submitted", "done");
      UI.append(frame.body, [
        el("div", { class: "waiting" }, [el("strong", null, "Waiting for the other side / facilitator."), el("span", null, "Your record for this turn is below.")]),
        sub.timedOut || sub.timed_out ? el("div", { class: "notice" }, "Submitted after the time limit.") : null,
        el("div", { class: "card" }, [el("h2", null, "Your advice"), recordView(me, record, { assessments: shape.assessments(me, turn), statement: sub.statement || shape.draft(me, turn).statement })])
      ]);
      root.appendChild(frame.node);
      return { update: frame.update };
    });
  }

  // 6.9 Report-back: own statement, then the other side's statement and observables when released.
  function renderStatements(me, turn) {
    var sid = shape.session(me).id;
    var ctx = show("group:statements:" + sid + ":" + turn, function (root) {
      var otherBlock = el("div");
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, (shape.scenario(me).shortTitle || "") + " · " + shape.sideName(me) + " · Turn " + turn),
        el("h1", null, "Report-back"),
        el("div", { class: "card" }, [el("h2", null, "Your public statement"), el("div", { id: "ownStatement" })]),
        otherBlock
      ]));
      function update(me2) {
        var s = shape.statements(me2, turn);
        var own = root.querySelector("#ownStatement");
        UI.clear(own);
        own.appendChild(s.own ? UI.paras(s.own) : el("p", { class: "faint" }, "No statement was recorded."));
        UI.clear(otherBlock);
        if (!s.released || !s.other) {
          otherBlock.appendChild(el("div", { class: "waiting" }, [el("strong", null, "Waiting for the other side's statement."), el("span", null, "It appears here when the facilitator releases it.")]));
          return;
        }
        var other = s.other;
        var names = shape.sideNames(me2);
        var otherName = other.sideName || names[other.side] || "The other side";
        var card = el("div", { class: "card" }, [el("h2", null, otherName + ": public statement"), other.statement ? UI.paras(other.statement) : el("p", { class: "faint" }, "The other side made no public statement.")]);
        otherBlock.appendChild(card);
        var observables = other.observables || [];
        otherBlock.appendChild(el("div", { class: "card" }, [el("h2", null, "What you can observe"), observables.length ? UI.list(observables.map(function (o) { return typeof o === "string" ? o : o.text; })) : el("p", { class: "faint" }, "No change in the other side's posture has been observed.")]));
        var hotline = other.hotline || other.hotlineMessages;
        if (hotline && (typeof hotline === "string" || hotline.length)) {
          var items = typeof hotline === "string" ? [hotline] : hotline.map(function (h) { return typeof h === "string" ? h : h.text; });
          otherBlock.appendChild(el("div", { class: "card is-flag" }, [el("h2", null, "Hotline message received"), UI.list(items, false, "plain")]));
        }
      }
      update(me);
      return { update: update };
    });
    return ctx;
  }

  // 6.10 Survey stage: the terminal shows the participant link and QR; it is otherwise locked.
  function renderSurveyStage(me) {
    var sid = shape.session(me).id;
    return show("group:survey:" + sid, function (root) {
      var url = shape.surveyUrl(me) || participantLink(store.get("token"));
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, (shape.scenario(me).shortTitle || "") + " · " + shape.sideName(me)),
        el("h1", null, "Survey"),
        el("p", { class: "lede" }, "Each participant now completes the survey on their own phone. Scan the code or open the link, then enter your table number (P1 to P12)."),
        el("div", { class: "card" }, [UI.qrBlock(url, { large: true, label: "QR code for the participant survey link" })]),
        el("div", { class: "notice" }, "This terminal is locked until the debrief is released.")
      ]));
    });
  }

  function participantLink(code) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, "");
    return base + "#p&code=" + encodeURIComponent(code || "");
  }

  // 6.11 Debrief
  function renderDebrief(me) {
    var sid = shape.session(me).id;
    return show("group:debrief:" + sid, function (root) {
      var holder = el("div", { class: "debrief" });
      var printButton = el("button", { type: "button", class: "btn btn-quiet" }, "Print");
      printButton.addEventListener("click", function () { window.print(); });
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, (shape.scenario(me).title || "") + " · " + shape.sideName(me)),
        el("h1", null, "Debrief"),
        el("div", { class: "actions no-print" }, [printButton]),
        holder
      ]));
      var last = null;
      function update(me2) {
        var d = shape.debrief(me2);
        var json = JSON.stringify(d);
        if (json === last) return;
        last = json;
        UI.clear(holder);
        if (!d) { holder.appendChild(el("div", { class: "waiting" }, [el("strong", null, "The debrief is being prepared.")])); return; }
        holder.appendChild(debriefView(me2, d));
      }
      update(me);
      return { update: update };
    });
  }

  // Shared by the group debrief and the facilitator's debrief view.
  function debriefView(me, d) {
    var wrap = el("div", { class: "debrief" });
    var names = Object.assign({}, shape.sideNames(me), d.sideNames || {});
    function nameOf(side) { return names[side] || side; }
    function section(title, node) { if (!node) return; wrap.appendChild(el("h2", { class: "section-head" }, title)); wrap.appendChild(node); }
    var truth = d.groundTruth || d.ground_truth;
    if (truth) section("Ground truth", el("div", { class: "card prose" }, UI.list(Array.isArray(truth) ? truth : [truth], false, "plain")));
    if (d.reveal) section("What happened", el("div", { class: "card prose" }, UI.list(Array.isArray(d.reveal) ? d.reveal : [d.reveal], false, "plain")));
    var path = d.path || d.branch;
    if (path) {
      var cells = path.cells || path.confirmed || path;
      var cellNode = el("div", { class: "card" }, [el("h3", null, "The path this session took")]);
      var dl = el("dl", { class: "pairs" });
      Object.keys(cells).forEach(function (side) { if (typeof cells[side] === "string") UI.append(dl, [el("dt", null, nameOf(side)), el("dd", null, cells[side])]); });
      if (dl.childNodes.length) cellNode.appendChild(dl);
      if (path.rule || path.rules) cellNode.appendChild(renderAny(path.rule || path.rules));
      section("Branch", cellNode);
      var notTaken = path.openingsNotTaken || d.openingsNotTaken;
      if (notTaken) {
        var nt = el("div", { class: "screen" });
        Object.keys(notTaken).forEach(function (k) {
          var v = notTaken[k];
          nt.appendChild(el("div", { class: "card is-quiet prose" }, [el("h3", null, k), renderAny(v)]));
        });
        section("The openings not taken", nt);
      }
    }
    var decisions = d.decisions || d.submissions;
    if (decisions) {
      var dec = el("div", { class: "side-cols" });
      Object.keys(decisions).forEach(function (side) {
        var col = el("div", { class: "card" }, [el("h3", null, nameOf(side))]);
        var turns = decisions[side] || {};
        Object.keys(turns).sort().forEach(function (turn) {
          var rec = turns[turn] || {};
          var assessments = (d.assessments && d.assessments[side] && d.assessments[side][turn]) || rec.assessments || null;
          col.appendChild(el("h3", null, "Turn " + turn));
          col.appendChild(recordView(me, rec.record || rec, { assessments: assessments, statement: rec.statement }));
        });
        dec.appendChild(col);
      });
      section("Both sides' decisions", dec);
    }
    var outputs = d.aiOutputs || d.panels || d.ai;
    if (outputs) {
      var out = el("div", { class: "screen" });
      Object.keys(outputs).forEach(function (side) {
        var turns = outputs[side] || {};
        Object.keys(turns).sort().forEach(function (turn) {
          var p = turns[turn];
          if (!p || typeof p !== "object") return;
          var block = el("div", { class: "screen" }, [el("h3", null, nameOf(side) + " · Turn " + turn)]);
          block.appendChild(panelView(me, Number(turn), p));
          out.appendChild(block);
        });
      });
      section("The assessments across turns", out);
    }
    if (d.briefs && Object.keys(d.briefs).length) {
      var briefs = el("div", { class: "side-cols" });
      Object.keys(d.briefs).forEach(function (side) {
        var b = d.briefs[side] || {};
        briefs.appendChild(el("div", { class: "card" }, [el("h3", null, nameOf(side)), briefBox("What they knew", b.know), briefBox("What they thought they knew", b.estimate), briefBox("Their prepared options", b.options)]));
      });
      section("The other side's brief", briefs);
    }
    if (d.questions) section("Questions for discussion", el("div", { class: "card" }, UI.list(d.questions)));
    if (d.plenary) section("Plenary (facilitator)", el("div", { class: "card" }, renderAny(d.plenary)));
    var known = ["groundTruth", "ground_truth", "reveal", "path", "branch", "openingsNotTaken", "decisions", "submissions", "assessments", "aiOutputs", "panels", "ai", "questions", "sideNames", "briefs", "plenary", "own"];
    Object.keys(d).forEach(function (k) {
      if (known.indexOf(k) >= 0) return;
      section(k.replace(/_/g, " "), el("div", { class: "card" }, renderAny(d[k])));
    });
    return wrap;
  }

  // Generic renderer for content the client has no special layout for (facilitator preview, extra debrief fields).
  function renderAny(value) {
    if (value === null || value === undefined) return el("span", { class: "faint" }, "—");
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") { var p = el("div"); p.appendChild(UI.paras(String(value))); return p; }
    if (Array.isArray(value)) {
      if (value.every(function (v) { return typeof v !== "object" || v === null; })) return UI.list(value.map(function (v) { return String(v); }));
      return UI.list(value.map(renderAny));
    }
    var dl = el("dl", { class: "pairs" });
    Object.keys(value).forEach(function (k) { UI.append(dl, [el("dt", null, k), el("dd", null, renderAny(value[k]))]); });
    return dl;
  }

  // ---------------------------------------------------------------------------
  // 7. Participant flow (phone): #p
  // ---------------------------------------------------------------------------

  var participant = { forms: null, me: null };

  function participantKey(suffix) { return "p." + (store.get("session") || "s") + "." + (auth.participant() || "") + "." + suffix; }

  function renderParticipant(parsed) {
    if (!auth.token() || auth.role() !== "group") {
      if (parsed.params.code) {
        gateWith(parsed.params.code, "p").catch(function (err) { renderGate({ participant: true, message: gateErrorText(err) }); });
        return;
      }
      return renderGate({ participant: true });
    }
    if (!auth.participant()) return renderTableNumber();
    setPoll(pollParticipant);
  }

  function renderTableNumber() {
    setPoll(null);
    clearTopBar();
    show("p:table", function (root) {
      var select = el("select", { id: "tableNumber", required: true }, [el("option", { value: "" }, "Choose")]);
      for (var i = 1; i <= 12; i++) select.appendChild(el("option", { value: "P" + i }, "P" + i));
      var error = el("div", { class: "notice is-error", role: "alert" });
      var button = el("button", { type: "submit", class: "btn btn-primary" }, "Continue");
      var form = el("form", { class: "card gate" }, [
        el("p", { class: "kicker" }, "Belfer Lab"),
        el("h1", null, "Your table number"),
        el("p", { class: "lede" }, "Choose the number on the card in front of you (P1 to P12). Keep the same number all day. No name or email is asked for anywhere."),
        UI.field("Table number", select),
        error,
        el("div", { class: "actions" }, [button])
      ]);
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!select.value) { error.textContent = "Choose your table number."; return; }
        store.set("participant", select.value);
        route();
      });
      root.appendChild(form);
    });
  }

  function pollParticipant() {
    return api("GET", "/api/me").then(function (me) {
      participant.me = me;
      setTopBar({ scenario: shape.scenario(me).shortTitle, side: shape.sideName(me), stage: shape.stage(me), timer: null });
      renderParticipantStage(me);
    });
  }

  function renderParticipantStage(me) {
    var stage = shape.stage(me);
    var pid = auth.participant();
    if (stage === "closed") return renderClosed();
    if (store.get(participantKey("survey"))) return renderThankYou(me);
    // Consent comes first whatever the stage; nothing is collected before it.
    if (!store.get(participantKey("consent"))) return renderConsent(me);
    if (stage === "survey") return renderSurvey(me);
    if (stage === "debrief") return renderThankYou(me);
    if ((stage === "setup" || stage === "briefing") && !store.get(participantKey("baseline"))) return renderBaseline(me);
    return show("p:wait:" + pid, function (root) {
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Participant " + pid),
        el("h1", null, "Thank you"),
        el("div", { class: "waiting" }, [el("strong", null, "Please keep this page open."), el("span", null, "The survey will appear here at the end of the session.")])
      ]));
    });
  }

  function loadForms() {
    if (participant.forms) return Promise.resolve(participant.forms);
    return api("GET", "/api/participant/forms").then(function (forms) { participant.forms = forms || {}; return participant.forms; });
  }

  function renderConsent(me) {
    var pid = auth.participant();
    return show("p:consent:" + pid, function (root) {
      var text = shape.consentText(me);
      var holder = el("div", { class: "card prose" });
      var box = el("input", { type: "checkbox", id: "consentBox" });
      var error = el("div", { class: "notice is-error", role: "alert" });
      var button = el("button", { type: "button", class: "btn btn-primary" }, "I consent");
      function fill(t) {
        UI.clear(holder);
        holder.appendChild(el("h2", null, "Consent"));
        if (t) holder.appendChild(UI.paras(t));
        else holder.appendChild(el("div", { class: "notice is-error", role: "alert" }, "The consent text for this session has not been supplied. Please ask the facilitator before continuing."));
        box.disabled = !t;
        button.disabled = !t;
      }
      fill(text);
      if (!text) loadForms().then(function (forms) { if (forms.consentText || forms.consent) fill(forms.consentText || forms.consent); }).catch(function () { /* placeholder stays */ });
      button.addEventListener("click", function () {
        if (!box.checked) { error.textContent = "Tick the box to confirm you consent."; return; }
        button.disabled = true;
        api("POST", "/api/participant/consent", { participant: pid, consented: true }).then(function () {
          store.set(participantKey("consent"), "1");
          UI.announce("Consent recorded.");
          renderParticipantStage(participant.me || me);
        }, function (err) { error.textContent = "Could not record consent: " + err.message; button.disabled = false; });
      });
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Participant " + pid),
        el("h1", null, "Before you take part"),
        holder,
        el("div", { class: "card" }, [el("label", { class: "choice", for: "consentBox" }, [box, el("span", null, "I have read the information above and I agree to take part.")]), error, el("div", { class: "actions" }, [button])])
      ]));
    });
  }

  // One survey item as a form control. scale: likert5 | percent | choice | text.
  function surveyItem(item, scales, answers, sawAI) {
    var scale = item.scale || "likert5";
    var wrap = el("div", { class: "field card is-quiet" });
    var required = item.required !== false;
    if (scale === "likert5" || scale === "choice") {
      var group = el("fieldset", { class: "choices" }, [el("legend", null, item.text + (required ? "" : " (optional)"))]);
      var options = [];
      if (scale === "choice" && item.options) options = item.options.map(function (o) { return typeof o === "string" ? { value: o, label: o } : o; });
      else {
        var sc = (scales && scales.likert5) || { min: 1, max: 5, minLabel: "Strongly disagree", maxLabel: "Strongly agree" };
        for (var v = sc.min || 1; v <= (sc.max || 5); v++) options.push({ value: String(v), label: v === (sc.min || 1) ? v + " — " + (sc.minLabel || "") : (v === (sc.max || 5) ? v + " — " + (sc.maxLabel || "") : String(v)) });
      }
      if (item.na && !(item.appliesTo === "sawAI" && sawAI)) options.push({ value: "NA", label: "Not applicable" });
      options.forEach(function (opt) {
        var radio = el("input", { type: "radio", name: "q-" + item.id, value: opt.value, id: "q-" + item.id + "-" + opt.value });
        var label = el("label", { class: "choice", for: radio.id }, [radio, el("span", null, opt.label)]);
        radio.addEventListener("change", function () {
          Array.prototype.forEach.call(group.querySelectorAll(".choice"), function (c) { c.classList.toggle("is-checked", c.querySelector("input").checked); });
          answers[item.id] = opt.value === "NA" ? "NA" : (scale === "likert5" ? Number(opt.value) : opt.value);
        });
        group.appendChild(label);
      });
      wrap.appendChild(group);
    } else if (scale === "percent") {
      var input = el("input", { type: "number", min: "0", max: "100", step: "1", inputmode: "numeric", id: "q-" + item.id });
      input.addEventListener("input", function () { answers[item.id] = input.value === "" ? undefined : Number(input.value); });
      wrap.appendChild(el("label", { for: input.id }, item.text + (required ? "" : " (optional)")));
      wrap.appendChild(el("div", { class: "help" }, "Enter a number from 0 to 100."));
      wrap.appendChild(input);
    } else {
      var area = el("textarea", { id: "q-" + item.id, rows: "4" });
      var count = el("span", { class: "count" }, "0 words");
      area.addEventListener("input", function () { answers[item.id] = area.value; count.textContent = UI.wordCount(area.value) + " words"; });
      wrap.appendChild(el("label", { for: area.id }, item.text + (required ? "" : " (optional)")));
      if (item.words) wrap.appendChild(el("div", { class: "help" }, "About " + item.words + " words."));
      wrap.appendChild(area);
      wrap.appendChild(count);
    }
    return wrap;
  }

  function missingAnswers(items, answers) {
    return items.filter(function (item) {
      if (item.required === false) return false;
      var v = answers[item.id];
      return v === undefined || v === null || v === "" || (typeof v === "string" && !v.trim());
    }).map(function (item) { return item.text; });
  }

  function renderBaseline(me) {
    var pid = auth.participant();
    return show("p:baseline:" + pid, function (root) {
      var holder = el("div", { class: "screen" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Participant " + pid), el("h1", null, "A few questions before we begin"), holder]));
      loadForms().then(function (forms) {
        var items = forms.baseline || [];
        var answers = {};
        var error = el("div", { class: "notice is-error", role: "alert" });
        var button = el("button", { type: "submit", class: "btn btn-primary" }, "Submit");
        var form = el("form", { class: "screen" }, items.map(function (item) { return surveyItem(item, forms.scales, answers); }).concat([error, el("div", { class: "actions" }, [button])]));
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var missing = missingAnswers(items, answers);
          if (missing.length) { UI.clear(error); UI.append(error, [el("p", null, "Please answer: "), UI.list(missing)]); return; }
          button.disabled = true;
          api("POST", "/api/participant/baseline", { participant: pid, answers: answers }).then(function () {
            store.set(participantKey("baseline"), "1");
            UI.announce("Answers recorded.");
            renderParticipantStage(participant.me || me);
          }, function (err) {
            if (err.status === 409) { store.set(participantKey("baseline"), "1"); renderParticipantStage(participant.me || me); return; }
            error.textContent = "Could not save: " + err.message; button.disabled = false;
          });
        });
        if (!items.length) { store.set(participantKey("baseline"), "1"); renderParticipantStage(participant.me || me); return; }
        holder.appendChild(form);
      }, function (err) { holder.appendChild(el("div", { class: "notice is-error" }, "Could not load the questions: " + err.message)); });
    });
  }

  function renderSurvey(me) {
    var pid = auth.participant();
    return show("p:survey:" + pid, function (root) {
      var holder = el("div", { class: "screen" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Participant " + pid), el("h1", null, "Survey"), holder]));
      loadForms().then(function (forms) {
        var items = forms.survey || forms.post || [];
        var written = forms.written || [];
        var answers = {};
        var writtenAnswers = {};
        var error = el("div", { class: "notice is-error", role: "alert" });
        var button = el("button", { type: "submit", class: "btn btn-primary" }, "Submit survey");
        var sections = [];
        var lastSection = null;
        var instruction = (forms.scales && forms.scales.likert5 && forms.scales.likert5.instruction) || "Rate from 1 (Strongly Disagree) to 5 (Strongly Agree)";
        sections.push(el("p", { class: "lede" }, instruction + ". Choose Not applicable where a question does not apply to you."));
        items.forEach(function (item) {
          if (item.section && item.section !== lastSection) { lastSection = item.section; sections.push(el("h2", { class: "section-head" }, item.section)); }
          sections.push(surveyItem(item, forms.scales, answers, !!forms.sawAI));
        });
        if (written.length) {
          sections.push(el("h2", { class: "section-head" }, "Written responses"));
          sections.push(el("p", { class: "muted" }, "Write freely. The word counts are a guide, not a limit."));
          written.forEach(function (item) { sections.push(surveyItem(Object.assign({ scale: "text" }, item), forms.scales, writtenAnswers)); });
        }
        var form = el("form", { class: "screen" }, sections.concat([error, el("div", { class: "actions" }, [button])]));
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var missing = missingAnswers(items, answers).concat(missingAnswers(written, writtenAnswers));
          if (missing.length) { UI.clear(error); UI.append(error, [el("p", null, "Please answer: "), UI.list(missing)]); error.scrollIntoView({ block: "nearest" }); return; }
          button.disabled = true;
          api("POST", "/api/participant/survey", { participant: pid, answers: answers, written: writtenAnswers }).then(function () {
            store.set(participantKey("survey"), "1");
            UI.announce("Survey submitted.");
            renderThankYou(participant.me || me);
          }, function (err) { error.textContent = "Could not submit: " + err.message; button.disabled = false; });
        });
        holder.appendChild(form);
      }, function (err) { holder.appendChild(el("div", { class: "notice is-error" }, "Could not load the survey: " + err.message)); });
    });
  }

  function renderThankYou(me) {
    var pid = auth.participant();
    return show("p:thanks:" + pid, function (root) {
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Participant " + pid),
        el("h1", null, "Thank you"),
        el("div", { class: "waiting" }, [el("strong", null, store.get(participantKey("survey")) ? "Your survey has been received." : "The session is at the debrief."), el("span", null, "You can close this page.")])
      ]));
    });
  }

  // ---------------------------------------------------------------------------
  // 8. Facilitator console: #console, #console/new, #console/session/<id>,
  //    #console/preview/<scenarioId>, #console/dry-run
  // ---------------------------------------------------------------------------

  var console_ = { scenarios: null, session: null, ai: null };

  function consoleNav() {
    var signOut = el("a", { href: "#", id: "signOut" }, "Sign out");
    signOut.addEventListener("click", function (e) { e.preventDefault(); auth.signOut(); navigate(""); });
    return el("nav", { class: "console-nav", "aria-label": "Console" }, [
      el("a", { href: "#console" }, "Sessions"),
      el("a", { href: "#console/new" }, "New session"),
      el("a", { href: "#console/preview" }, "Preview content"),
      el("a", { href: "#console/dry-run" }, "Dry run"),
      signOut
    ]);
  }

  function loadScenarios() {
    if (console_.scenarios) return Promise.resolve(console_.scenarios);
    return api("GET", "/api/scenarios").then(function (list) { console_.scenarios = Array.isArray(list) ? list : (list.scenarios || []); return console_.scenarios; });
  }

  function renderConsole(parsed) {
    var path = parsed.path.split("/");
    clearTopBar();
    if (path[1] === "new") return renderConsoleNew();
    if (path[1] === "session" && path[2]) return renderConsoleSession(path[2]);
    if (path[1] === "preview") return renderConsolePreview(path[2]);
    if (path[1] === "dry-run") return renderConsoleDryRun();
    return renderConsoleList();
  }

  function renderConsoleList() {
    var ctx = show("console:list", function (root) {
      var table = el("div", { class: "card" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Facilitator console"), el("h1", null, "Sessions"), consoleNav(), table]));
      return { table: table };
    });
    setPoll(function () {
      return api("GET", "/api/sessions").then(function (list) {
        var sessions = Array.isArray(list) ? list : (list.sessions || []);
        UI.clear(ctx.table);
        if (!sessions.length) { ctx.table.appendChild(el("p", { class: "muted" }, "No sessions yet. Create one from New session.")); return; }
        var rows = sessions.map(function (s) {
          var link = el("a", { href: "#console/session/" + encodeURIComponent(s.id) }, s.label || s.id);
          var scenario = (s.scenario && (s.scenario.shortTitle || s.scenario.title)) || s.scenarioId || "";
          return el("tr", null, [el("td", null, link), el("td", null, scenario), el("td", null, [s.condition ? el("span", { class: "badge" }, "Condition " + s.condition) : null, " ", s.mode || ""]), el("td", null, stageName(s.stage)), el("td", { class: "mono small" }, (s.createdAt || "").replace("T", " ").slice(0, 16))]);
        });
        ctx.table.appendChild(el("div", { class: "table-wrap" }, el("table", null, [el("thead", null, el("tr", null, [el("th", { scope: "col" }, "Label"), el("th", { scope: "col" }, "Scenario"), el("th", { scope: "col" }, "Condition · mode"), el("th", { scope: "col" }, "Stage"), el("th", { scope: "col" }, "Created")])), el("tbody", null, rows)])));
      });
    });
  }

  function renderConsoleNew() {
    setPoll(null);
    show("console:new", function (root) {
      var holder = el("div", { class: "screen" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Facilitator console"), el("h1", null, "New session"), consoleNav(), holder]));
      loadScenarios().then(function (scenarios) {
        var scenarioSelect = el("select", { id: "newScenario" }, scenarios.map(function (s) { return el("option", { value: s.id }, (s.shortTitle || s.id) + " — " + (s.title || "")); }));
        var condition = radioRow("newCondition", "Condition", [{ value: "A", label: "A — scripted, staff labels" }, { value: "B", label: "B — scripted, AI labels" }, { value: "C", label: "C — live AI" }], "B");
        var mode = radioRow("newMode", "Mode", [{ value: "duel", label: "Duel — both sides are groups" }, { value: "lab", label: "Lab — one side is simulated" }], "duel");
        var sideHolder = el("div", { class: "field" });
        var groupSide = el("select", { id: "newGroupSide" });
        function fillSides() {
          var s = scenarios.filter(function (x) { return x.id === scenarioSelect.value; })[0] || {};
          var sides = Array.isArray(s.sides) ? s.sides : Object.keys(s.sides || {}).map(function (k) { return Object.assign({ id: k }, s.sides[k]); });
          UI.clear(groupSide);
          sides.forEach(function (side) { groupSide.appendChild(el("option", { value: side.id || side }, (side.name || side.id || side) + (side.hasAI === false ? " (no assessment system)" : ""))); });
        }
        fillSides();
        scenarioSelect.addEventListener("change", fillSides);
        UI.append(sideHolder, [el("label", { for: "newGroupSide" }, "In lab mode, which side is played by the group?"), groupSide]);
        function syncSide() { sideHolder.hidden = mode.value() !== "lab"; }
        mode.onChange(syncSide); syncSide();
        var minutes = el("input", { type: "number", id: "newMinutes", min: "1", max: "180", value: "15" });
        var expiry = radioRow("newExpiry", "At the end of the turn timer", [{ value: "none", label: "None — log the overrun only" }, { value: "flag", label: "Flag — show 'Time is up' and mark late submissions" }, { value: "lock", label: "Lock — submit whatever is saved" }], "flag");
        var autoRelease = el("input", { type: "checkbox", id: "newAutoRelease" });
        var chat = el("input", { type: "checkbox", id: "newChat", checked: true });
        var seed = el("input", { type: "text", id: "newSeed", value: "" });
        var label = el("input", { type: "text", id: "newLabel", maxlength: "120" });
        var groupSize = el("input", { type: "number", id: "newGroupSize", min: "1", max: "12", value: "6" });
        var error = el("div", { class: "notice is-error", role: "alert" });
        var submit = el("button", { type: "submit", class: "btn btn-primary" }, "Create session");
        var form = el("form", { class: "screen" }, [
          el("div", { class: "card" }, [UI.field("Scenario", scenarioSelect), condition.node, mode.node, sideHolder]),
          el("div", { class: "card" }, [UI.field("Turn length (minutes)", minutes), expiry.node]),
          el("div", { class: "card" }, [
            el("h2", null, "Live AI settings (condition C)"),
            el("label", { class: "choice", for: "newAutoRelease" }, [autoRelease, el("span", null, "Auto-release generated assessments without review")]),
            el("label", { class: "choice", for: "newChat" }, [chat, el("span", null, "Allow 'Ask the assistant'")])
          ]),
          el("div", { class: "card" }, [UI.field("Label (for your records)", label), UI.field("Seed (recorded; affects nothing yet)", seed), UI.field("Group size (people per table)", groupSize)]),
          error,
          el("div", { class: "actions" }, [submit])
        ]);
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          submit.disabled = true;
          error.textContent = "";
          var s = scenarios.filter(function (x) { return x.id === scenarioSelect.value; })[0] || {};
          var allSides = Array.isArray(s.sides) ? s.sides.map(function (x) { return x.id || x; }) : Object.keys(s.sides || {});
          var sides = mode.value() === "lab" ? [groupSide.value] : allSides;
          var aiSettings = { autoRelease: autoRelease.checked, chat: chat.checked };
          api("POST", "/api/sessions", {
            scenarioId: scenarioSelect.value, condition: condition.value(), mode: mode.value(), sides: sides,
            timer: { turnMinutes: Number(minutes.value) || 15, expiry: expiry.value() },
            ai: aiSettings, assistant: aiSettings,
            seed: seed.value.trim(), label: label.value.trim(), groupSize: Number(groupSize.value) || 6
          }).then(function (session) {
            navigate("console/session/" + encodeURIComponent(session.id));
          }, function (err) {
            error.textContent = err.code === "ai_unavailable" ? "The live AI provider is not available on the server (no key or package), so a condition C or lab-mode session cannot be created. " + (err.message || "") : "Could not create the session: " + err.message;
            submit.disabled = false;
          });
        });
        holder.appendChild(form);
      }, function (err) { holder.appendChild(el("div", { class: "notice is-error" }, "Could not load scenarios: " + err.message)); });
    });
  }

  function radioRow(name, legend, options, initial) {
    var group = el("fieldset", { class: "choices" }, [el("legend", null, legend)]);
    var listeners = [];
    options.forEach(function (opt) {
      var radio = el("input", { type: "radio", name: name, value: opt.value, id: name + "-" + opt.value });
      if (opt.value === initial) radio.checked = true;
      var label = el("label", { class: "choice" + (radio.checked ? " is-checked" : ""), for: radio.id }, [radio, el("span", null, opt.label)]);
      radio.addEventListener("change", function () {
        Array.prototype.forEach.call(group.querySelectorAll(".choice"), function (c) { c.classList.toggle("is-checked", c.querySelector("input").checked); });
        listeners.forEach(function (fn) { fn(radio.value); });
      });
      group.appendChild(label);
    });
    return { node: group, value: function () { var c = group.querySelector("input:checked"); return c ? c.value : initial; }, onChange: function (fn) { listeners.push(fn); } };
  }

  // Facilitator session payload accessors (GET /api/sessions/:id is the stored session plus
  // scenario, sideInfo, links, counts, timer, now and, at the debrief, debrief).
  var fshape = {
    codes: function (s) {
      var codes = s.codes || {};
      var groups = codes.group || codes.groups || codes.sides || {};
      // Observer codes are one per group side ({ side: code }); an older session may carry a single string.
      var observer = codes.observer && typeof codes.observer === "object" ? codes.observer : (codes.observer || s.observerCode ? { all: codes.observer || s.observerCode } : {});
      var out = { sides: {}, observer: observer };
      Object.keys(groups).forEach(function (k) { out.sides[k] = typeof groups[k] === "string" ? groups[k] : (groups[k].code || ""); });
      Object.keys(codes).forEach(function (k) { if (k !== "observer" && k !== "groups" && k !== "sides" && typeof codes[k] === "string" && /^BLF-S/i.test(codes[k])) out.sides[k] = codes[k]; });
      return out;
    },
    // Every side of the scenario with kind, name, hasAI and axis; s.sides alone is the list of group side ids.
    sides: function (s) {
      if (s.sideInfo) return s.sideInfo;
      var sides = s.sides || {};
      if (Array.isArray(sides)) { var o = {}; sides.forEach(function (x) { o[x.id || x] = typeof x === "object" ? x : { kind: "group" }; }); return o; }
      return sides;
    },
    sideName: function (s, side) { var sides = fshape.sides(s); return (sides[side] && sides[side].name) || (s.scenario && s.scenario.sides && s.scenario.sides[side] && s.scenario.sides[side].name) || side; },
    scenarioLabel: function (s) { return (s.scenario && (s.scenario.title || s.scenario.shortTitle)) || s.scenarioId || ""; },
    turn: function (s) { return turnOfStage(s.stage) || s.turn || null; },
    draft: function (s, side, turn) { return (s.drafts && s.drafts[side] && s.drafts[side][turn]) || {}; },
    assessments: function (s, side, turn) { return (s.assessments && s.assessments[side] && s.assessments[side][turn]) || {}; },
    submission: function (s, side, turn) { return (s.submissions && s.submissions[side] && s.submissions[side][turn]) || null; },
    ready: function (s, side) { return !!(s.ready && s.ready[side]); },
    // The server counts per side ({ side: { consented, baseline, survey } }); the console shows totals and the split.
    counts: function (s) {
      var src = s.counts || {};
      var totals = { consented: 0, baseline: 0, survey: 0, bySide: {} };
      var perSide = false;
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (!v || typeof v !== "object") return;
        perSide = true;
        totals.bySide[k] = v;
        ["consented", "baseline", "survey"].forEach(function (f) { totals[f] += Number(v[f]) || 0; });
      });
      return perSide ? totals : Object.assign(totals, src);
    },
    // Injects are stored per side ({ side: [{ t, turn, text }] }); the console lists them in time order.
    injects: function (s) {
      var inj = s.injects || [];
      if (Array.isArray(inj)) return inj;
      var out = [];
      Object.keys(inj).forEach(function (side) { (inj[side] || []).forEach(function (i) { out.push({ t: i.t, turn: i.turn, sides: [side], text: i.text }); }); });
      out.sort(function (a, b) { return String(a.t).localeCompare(String(b.t)); });
      return out;
    },
    branch: function (s) { return s.branch || {}; },
    assistant: function (s, side, turn) { return (s.assistant && s.assistant[side] && s.assistant[side][turn]) || (s.assistantThreads && s.assistantThreads[side] && s.assistantThreads[side][turn]) || []; },
    provider: function (s) { return (s.ai && s.ai.provider) || s.provider || ""; },
    links: function (s) { var l = s.links || {}; return { groups: l.group || l.groups || {}, participants: l.participants || l.survey || {}, observer: l.observer || "" }; }
  };

  var STAGES = ["setup", "briefing", "turn1", "statements1", "turn2", "statements2", "survey", "debrief", "closed"];

  function labLink(code, participantFlag) {
    var base = location.origin + location.pathname.replace(/[^/]*$/, "");
    return base + (participantFlag ? "#p&code=" : "#code=") + encodeURIComponent(code);
  }

  function renderConsoleSession(id) {
    var ctx = show("console:session:" + id, function (root) {
      root.classList.add("is-wide");
      var parts = {
        head: el("div", { class: "screen" }), status: el("div", { class: "notice is-error", role: "alert" }),
        codes: el("div", { class: "card codes" }), stage: el("div", { class: "card" }), timer: el("div", { class: "card" }),
        drafts: el("div", { class: "side-cols" }), inject: el("div", { class: "card" }), branch: el("div", { class: "card" }),
        ai: el("div", { class: "screen" }), adversary: el("div", { class: "screen" }), transcripts: el("div", { class: "side-cols" }),
        survey: el("div", { class: "card" }), exports: el("div", { class: "card" }), close: el("div", { class: "card" }), debrief: el("div")
      };
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Facilitator console"), parts.head, consoleNav(), parts.status,
        el("h2", { class: "section-head" }, "Codes and links"), parts.codes,
        el("h2", { class: "section-head" }, "Stage"), parts.stage,
        el("h2", { class: "section-head" }, "Timer"), parts.timer,
        el("h2", { class: "section-head" }, "Live drafts"), parts.drafts,
        el("h2", { class: "section-head" }, "Inject"), parts.inject,
        el("h2", { class: "section-head" }, "Branch"), parts.branch,
        el("h2", { class: "section-head" }, "AI review"), parts.ai,
        el("h2", { class: "section-head" }, "Adversary move"), parts.adversary,
        el("h2", { class: "section-head" }, "Assistant transcripts"), parts.transcripts,
        el("h2", { class: "section-head" }, "Survey"), parts.survey,
        el("h2", { class: "section-head" }, "Exports"), parts.exports,
        el("h2", { class: "section-head" }, "Close"), parts.close,
        parts.debrief
      ]));
      return { parts: parts, built: {}, lastJson: {}, statuses: {} };
    });
    setPoll(function () {
      return api("GET", "/api/sessions/" + encodeURIComponent(id)).then(function (session) {
        console_.session = session;
        var wantsAi = session.condition === "C" || session.mode === "lab";
        var aiPromise = wantsAi ? api("GET", "/api/sessions/" + encodeURIComponent(id) + "/ai").catch(function () { return null; }) : Promise.resolve(null);
        return aiPromise.then(function (ai) { console_.ai = ai; updateConsoleSession(ctx, session, ai); });
      });
    });
  }

  // A status line that survives its part being re-rendered after the next poll.
  function partStatus(ctx, key) {
    if (!ctx.statuses[key]) ctx.statuses[key] = el("p", { class: "muted", role: "status" });
    return ctx.statuses[key];
  }

  // Each part re-renders only when the data it shows has changed, so inputs keep focus. A part
  // with an open confirmation prompt waits for the next poll, so a background refresh never
  // wipes a question the facilitator is in the middle of answering.
  function renderIfChanged(ctx, name, data, build) {
    var json = JSON.stringify(data);
    if (ctx.lastJson[name] === json) return;
    if (ctx.parts[name].querySelector(".confirm-text")) return;
    ctx.lastJson[name] = json;
    UI.clear(ctx.parts[name]);
    build(ctx.parts[name]);
  }

  function updateConsoleSession(ctx, s, ai) {
    var id = s.id;
    var turn = fshape.turn(s);
    setTopBar({ scenario: fshape.scenarioLabel(s), side: "Facilitator", turn: turn, stage: s.stage, timer: s.timer, now: s.now || serverClock.iso });
    var sides = fshape.sides(s);
    var sideKeys = Object.keys(sides).length ? Object.keys(sides) : Object.keys(fshape.codes(s).sides);

    renderIfChanged(ctx, "head", [s.label, s.condition, s.mode, s.stage, fshape.provider(s), s.status], function (node) {
      UI.append(node, [
        el("h1", null, s.label || s.id),
        el("div", { class: "actions" }, [
          el("span", { class: "badge is-teal" }, fshape.scenarioLabel(s)),
          el("span", { class: "badge is-amber" }, "Condition " + (s.condition || "?")),
          el("span", { class: "badge" }, (s.mode || "duel") + " mode"),
          el("span", { class: "badge" }, "Stage: " + stageName(s.stage)),
          fshape.provider(s) === "mock" ? el("span", { class: "badge is-red" }, "MOCK PROVIDER") : null,
          s.status === "closed" ? el("span", { class: "badge is-red" }, "Closed") : null
        ]),
        el("p", { class: "faint mono" }, "Session " + s.id + (s.seed ? " · seed " + s.seed : ""))
      ]);
    });

    renderIfChanged(ctx, "codes", [fshape.codes(s), fshape.links(s), s.survey], function (node) {
      var codes = fshape.codes(s);
      var links = fshape.links(s);
      sideKeys.forEach(function (side) {
        var code = codes.sides[side];
        if (!code) { node.appendChild(el("div", { class: "code-block" }, [el("h3", null, fshape.sideName(s, side)), el("p", { class: "muted" }, "Played by the simulated adversary.")])); return; }
        var link = (links.groups && links.groups[side]) || (links[side]) || labLink(code, false);
        var plink = (links.participants && links.participants[side]) || (s.survey && s.survey[side] && s.survey[side].url) || labLink(code, true);
        node.appendChild(el("div", { class: "grid-2" }, [
          el("div", { class: "code-block" }, [el("h3", null, fshape.sideName(s, side) + " — group terminal"), el("div", { class: "code-value" }, code), UI.qrBlock(link, { label: "QR code for the " + fshape.sideName(s, side) + " terminal" })]),
          el("div", { class: "code-block" }, [el("h3", null, fshape.sideName(s, side) + " — participants' phones"), el("p", { class: "faint" }, "Same code; each person adds their table number."), UI.qrBlock(plink, { label: "QR code for " + fshape.sideName(s, side) + " participants" })])
        ]));
      });
      Object.keys(codes.observer || {}).forEach(function (oside) {
        var ocode = codes.observer[oside];
        var olink = (links.observer && typeof links.observer === "object" ? links.observer[oside] : links.observer) || labLink(ocode, false);
        var oname = oside === "all" ? "all sides" : fshape.sideName(s, oside);
        node.appendChild(el("div", { class: "code-block" }, [el("h3", null, "Observer — " + oname), el("p", { class: "faint" }, "For the observer sitting with this group; quick tags are recorded against this side."), el("div", { class: "code-value" }, ocode), UI.qrBlock(olink, { label: "QR code for the " + oname + " observer view" })]));
      });
    });

    renderIfChanged(ctx, "stage", [s.stage, s.status, s.ready, fshape.counts(s), s.aiReview, s.adversaryReview, fshape.branch(s).confirmed], function (node) {
      var index = STAGES.indexOf(s.stage);
      var next = index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : null;
      var prev = index > 0 ? STAGES[index - 1] : null;
      var status = partStatus(ctx, "stage");
      function go(to, force) {
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/advance", force ? { to: to, force: true } : { to: to }).then(function () { status.textContent = "Stage is now " + stageName(to) + "."; pollNow(); }, function (err) {
          status.textContent = "Could not change stage: " + err.message;
          // A pending review (condition C output, or a simulated adversary move) blocks the advance; the override is logged.
          if (!force && /not been approved/.test(err.message || "")) {
            status.appendChild(el("span", null, " "));
            status.appendChild(UI.confirmButton("Advance anyway (recorded as an override)", "Advance without that approval? The override is recorded on the session.", function () { go(to, true); }, { class: "btn-quiet" }));
          }
        });
      }
      var advance = next && next !== "closed" ? UI.confirmButton("Advance to " + stageName(next), "Advance the session to " + stageName(next) + "?", function () { go(next); }, { class: "btn-primary" }) : null;
      var back = prev ? UI.confirmButton("Back to " + stageName(prev), "Go back one stage to " + stageName(prev) + "?", function () { go(prev); }, { class: "btn-quiet" }) : null;
      var ready = sideKeys.map(function (side) { return el("li", null, fshape.sideName(s, side) + ": " + (sides[side] && sides[side].kind === "simulated" ? "simulated" : (fshape.ready(s, side) ? "ready" : "not ready"))); });
      var counts = fshape.counts(s);
      UI.append(node, [
        s.consentStatus && !s.consentStatus.present ? el("div", { class: "notice is-error" }, "No consent text is configured on the server (lab-server/content/consent.json, or CONSENT_TEXT in its environment). Participants cannot record consent until it is supplied.") : el("span"),
        el("p", null, ["Current stage: ", el("strong", null, stageName(s.stage))]),
        el("ul", { class: "bullets" }, ready),
        el("p", { class: "muted" }, "Baseline answers received: " + (counts.baseline !== undefined ? counts.baseline : "—") + " · consent: " + (counts.consented !== undefined ? counts.consented : (counts.consent !== undefined ? counts.consent : "—"))),
        (s.stage === "statements1" && !(fshape.branch(s).confirmed)) ? el("p", { class: "notice" }, "Confirm the branch below before advancing to Turn 2.") : null,
        el("div", { class: "actions" }, [back, advance]),
        status
      ]);
    });

    renderIfChanged(ctx, "timer", [s.timer, s.stage], function (node) {
      var t = s.timer || {};
      var minutes = el("input", { type: "number", id: "timerMinutes", min: "1", max: "180", value: String(t.turnMinutes || 15) });
      var extend = el("input", { type: "number", id: "timerExtend", min: "1", max: "60", value: "5" });
      var status = partStatus(ctx, "timer");
      function act(action, mins) {
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/timer", { action: action, minutes: mins }).then(function () { status.textContent = "Timer " + action + (action === "extend" ? "ed" : (action === "stop" ? "ped" : "ed")) + "."; pollNow(); }, function (err) { status.textContent = "Timer: " + err.message; });
      }
      var start = el("button", { type: "button", class: "btn btn-primary" }, "Start"); start.addEventListener("click", function () { act("start", Number(minutes.value) || 15); });
      var stop = el("button", { type: "button", class: "btn btn-quiet" }, "Stop"); stop.addEventListener("click", function () { act("stop"); });
      var ext = el("button", { type: "button", class: "btn" }, "Extend"); ext.addEventListener("click", function () { act("extend", Number(extend.value) || 5); });
      UI.append(node, [
        el("p", null, "State: " + (t.running ? "running" : (t.expired ? "expired" : "stopped")) + " · expiry rule: " + (t.expiry || "flag") + (t.endsAt ? " · ends " + t.endsAt.replace("T", " ").slice(0, 19) + " UTC" : "")),
        el("div", { class: "grid-2" }, [UI.field("Turn length (minutes)", minutes), UI.field("Extend by (minutes)", extend)]),
        el("div", { class: "actions" }, [start, stop, ext]),
        status
      ]);
    });

    renderIfChanged(ctx, "drafts", [s.drafts, s.assessments, s.submissions, turn, s.statements], function (node) {
      sideKeys.forEach(function (side) {
        var card = el("div", { class: "card" }, [el("h3", null, fshape.sideName(s, side) + (sides[side] && sides[side].kind === "simulated" ? " (simulated)" : ""))]);
        var turns = turn ? [turn] : [1, 2];
        turns.forEach(function (tn) {
          var sub = fshape.submission(s, side, tn);
          var draft = sub ? (sub.record || sub) : fshape.draft(s, side, tn);
          card.appendChild(el("h3", null, "Turn " + tn + (sub ? " — submitted" : " — draft")));
          card.appendChild(recordView({ content: {} }, draft, { assessments: fshape.assessments(s, side, tn), statement: (sub && sub.statement) || draft.statement }));
        });
        node.appendChild(card);
      });
    });

    var injects = fshape.injects(s);
    renderIfChanged(ctx, "inject", [sideKeys, injects.length], function (node) {
      var text = el("textarea", { id: "injectText", rows: "3" });
      var boxes = sideKeys.map(function (side) { var b = el("input", { type: "checkbox", id: "inject-" + side, value: side, checked: true }); return { box: b, label: el("label", { class: "choice", for: b.id }, [b, el("span", null, fshape.sideName(s, side))]) }; });
      var status = partStatus(ctx, "inject");
      var send = UI.confirmButton("Send inject", "Send this inject to the selected sides?", function () {
        var targets = boxes.filter(function (b) { return b.box.checked; }).map(function (b) { return b.box.value; });
        if (!text.value.trim() || !targets.length) { status.textContent = "Write the inject and choose at least one side."; return; }
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/inject", { sides: targets, text: text.value.trim() }).then(function () { status.textContent = "Inject sent."; text.value = ""; pollNow(); }, function (err) { status.textContent = "Could not send: " + err.message; });
      }, { class: "btn-primary" });
      UI.append(node, [UI.field("Inject text (shown to the group as FACILITATOR INJECT)", text), el("fieldset", { class: "choices" }, [el("legend", null, "Send to")].concat(boxes.map(function (b) { return b.label; }))), el("div", { class: "actions" }, [send]), status]);
      if (injects.length) node.appendChild(el("div", null, [el("h3", null, "Sent"), UI.list(injects.map(function (i) { return (i.sides ? i.sides.map(function (k) { return fshape.sideName(s, k); }).join(", ") + ": " : "") + (i.text || ""); }))]));
    });

    renderIfChanged(ctx, "branch", [fshape.branch(s), s.stage, turn], function (node) {
      var b = fshape.branch(s);
      var suggested = b.suggested || b.suggestion || null;
      var confirmed = b.confirmed || null;
      if (!suggested && !confirmed) { node.appendChild(el("p", { class: "muted" }, "The branch suggestion appears once both sides have submitted Turn 1.")); return; }
      var selects = {};
      var status = partStatus(ctx, "branch");
      var rows = Object.keys(suggested || confirmed).map(function (side) {
        var sug = (suggested && suggested[side]) || {};
        var cell = typeof sug === "string" ? sug : (sug.cell || "");
        var rule = typeof sug === "object" ? [sug.rule, sug.detail].filter(Boolean).join(" \u2014 ") : "";
        var axis = (sides[side] && sides[side].axis) || (b.axes && b.axes[side]) || (sug.axis) || [cell];
        var select = el("select", { id: "branch-" + side }, axis.map(function (c) { return el("option", { value: c, selected: c === ((confirmed && confirmed[side]) || cell) }, c); }));
        selects[side] = select;
        return el("div", { class: "card is-quiet" }, [
          el("h3", null, fshape.sideName(s, side)),
          el("p", null, ["Suggested: ", el("strong", null, cell || "—")]),
          rule ? el("p", { class: "muted small" }, rule) : null,
          UI.field("Cell to confirm", select),
          sug.opening ? el("p", { class: "faint" }, "Opening: " + String(sug.opening).slice(0, 160)) : null
        ]);
      });
      var confirm = UI.confirmButton(confirmed ? "Re-confirm branch" : "Confirm branch", "Confirm these cells for Turn 2?", function () {
        var body = {}; Object.keys(selects).forEach(function (side) { body[side] = selects[side].value; });
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/branch", body).then(function () { status.textContent = "Branch confirmed."; pollNow(); }, function (err) { status.textContent = "Could not confirm: " + err.message; });
      }, { class: "btn-primary" });
      UI.append(node, [confirmed ? el("p", null, ["Confirmed: ", el("strong", null, Object.keys(confirmed).map(function (k) { return fshape.sideName(s, k) + " " + confirmed[k]; }).join(" · "))]) : null, el("div", { class: "grid-2" }, rows), el("div", { class: "actions" }, [confirm]), status]);
    });

    renderIfChanged(ctx, "ai", [ai && ai.review, s.condition], function (node) {
      if (s.condition !== "C") { node.appendChild(el("p", { class: "muted" }, "Live generation is used in condition C only.")); return; }
      var review = (ai && ai.review) || {};
      var any = false;
      Object.keys(review).forEach(function (side) {
        Object.keys(review[side] || {}).forEach(function (tn) {
          any = true;
          node.appendChild(aiReviewCard(ctx, id, s, side, tn, review[side][tn]));
        });
      });
      if (!any) node.appendChild(el("p", { class: "muted" }, "Generated assessments appear here when a turn is released."));
    });

    renderIfChanged(ctx, "adversary", [ai && ai.adversary, s.mode], function (node) {
      if (s.mode !== "lab") { node.appendChild(el("p", { class: "muted" }, "The simulated adversary is used in lab mode only.")); return; }
      var adv = (ai && ai.adversary) || {};
      var keys = Object.keys(adv);
      if (!keys.length) { node.appendChild(el("p", { class: "muted" }, "The adversary's proposed move appears here after the group submits.")); return; }
      keys.forEach(function (tn) { node.appendChild(adversaryCard(ctx, id, s, tn, adv[tn])); });
    });

    renderIfChanged(ctx, "transcripts", [s.assistant, s.assistantThreads, turn], function (node) {
      var any = false;
      sideKeys.forEach(function (side) {
        [1, 2].forEach(function (tn) {
          var messages = fshape.assistant(s, side, tn);
          if (!messages.length) return;
          any = true;
          node.appendChild(el("div", { class: "card" }, [el("h3", null, fshape.sideName(s, side) + " · Turn " + tn), el("div", { class: "transcript" }, messages.map(function (m) {
            return el("div", { class: "msg " + (m.role === "user" ? "is-user" : "is-assistant") }, [el("span", { class: "msg-role" }, m.role === "user" ? "Group" : "Assistant"), UI.paras(m.text || m.content || "")]);
          }))]));
        });
      });
      if (!any) node.appendChild(el("p", { class: "muted" }, "No assistant conversations yet."));
    });

    renderIfChanged(ctx, "survey", [fshape.counts(s)], function (node) {
      var c = fshape.counts(s);
      var dl = el("dl", { class: "pairs" });
      ["consented", "baseline", "survey"].forEach(function (k) { UI.append(dl, [el("dt", null, k), el("dd", null, c[k] !== undefined ? String(c[k]) : "—")]); });
      if (c.bySide) Object.keys(c.bySide).forEach(function (side) { UI.append(dl, [el("dt", null, fshape.sideName(s, side)), el("dd", null, JSON.stringify(c.bySide[side]))]); });
      node.appendChild(dl);
    });

    renderIfChanged(ctx, "exports", [id], function (node) {
      var status = el("p", { class: "muted", role: "status" });
      var kinds = [["json", "Session JSON", "json"], ["events", "Events CSV", "csv"], ["turns", "Turn summary CSV", "csv"], ["survey", "Survey CSV", "csv"], ["ai", "AI outputs CSV", "csv"], ["report", "Post-scenario report (Markdown)", "md"], ["codebook", "Codebook JSON", "json"]];
      node.appendChild(el("div", { class: "actions" }, kinds.map(function (k) {
        var b = el("button", { type: "button", class: "btn btn-small" }, k[1]);
        b.addEventListener("click", function () {
          status.textContent = "Preparing " + k[1] + ".";
          download("/api/sessions/" + encodeURIComponent(id) + "/export/" + k[0], id + "-" + k[0] + "." + k[2]).then(function () { status.textContent = k[1] + " downloaded."; }, function (err) { status.textContent = "Export failed: " + err.message; });
        });
        return b;
      })));
      node.appendChild(status);
    });

    renderIfChanged(ctx, "close", [s.status], function (node) {
      var status = partStatus(ctx, "close");
      var close = UI.confirmButton("Close session", "Close this session? All group and observer codes stop working. Exports remain available.", function () {
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/close", {}).then(function () { status.textContent = "Session closed."; pollNow(); }, function (err) { status.textContent = "Could not close: " + err.message; });
      }, { class: "btn-danger", disabled: s.status === "closed" });
      UI.append(node, [el("div", { class: "actions" }, [close]), status]);
    });

    renderIfChanged(ctx, "debrief", [s.stage, s.debrief], function (node) {
      if (!s.debrief) return;
      var fake = { content: { sides: sides }, debrief: s.debrief };
      UI.append(node, [el("h2", { class: "section-head" }, "Debrief"), debriefView(fake, shape.debrief(fake))]);
    });
  }

  // AI review card: approve, edit inline, regenerate with a reason; shows the prompt materials.
  function aiReviewCard(ctx, id, s, side, tn, item) {
    item = item || {};
    var status = item.status || "pending";
    var outputs = item.outputs || {};
    var card = el("div", { class: "card" + (status === "pending" ? " is-flag" : "") });
    var note = partStatus(ctx, "ai:" + side + ":" + tn);
    UI.append(card, [el("div", { class: "card-title" }, [el("h3", null, fshape.sideName(s, side) + " · Turn " + tn), el("span", { class: "badge " + (status === "approved" ? "is-green" : (status === "pending" ? "is-amber" : "")) }, status)])]);
    if (status === "generating" || (status === "pending" && !Object.keys(outputs).length)) { card.appendChild(el("p", null, "Generating. This panel refreshes on its own.")); return card; }
    if (status === "failed" || item.error) card.appendChild(el("div", { class: "notice is-error" }, "Generation failed: " + ((item.error && item.error.message) || item.error || "unknown error") + ". Regenerate, or the group will wait."));
    var edits = {};
    var fields = [];
    ["intel", "forecast", "adversary"].forEach(function (role) {
      var out = outputs[role] || {};
      var headline = el("textarea", { id: "ai-" + side + "-" + tn + "-" + role + "-headline", rows: "2" }); headline.value = out.headline || "";
      var body = el("textarea", { id: "ai-" + side + "-" + tn + "-" + role + "-body", rows: "5" }); body.value = out.body || "";
      var reasoning = el("textarea", { id: "ai-" + side + "-" + tn + "-" + role + "-reasoning", rows: "3" }); reasoning.value = (outputs.reasoning && outputs.reasoning[role]) || out.reasoning || "";
      fields.push({ role: role, headline: headline, body: body, reasoning: reasoning, original: out });
      var extra = [];
      if (out.confidence !== undefined) extra.push("confidence " + percent(out.confidence) + "%");
      if (out.pathways) extra.push(out.pathways.map(function (p) { return p.label + " " + percent(p.probability) + "% (" + (p.window || "") + ")"; }).join("; "));
      card.appendChild(el("div", { class: "inline-edit screen" }, [
        el("h3", null, role === "intel" ? "Intelligence assessment" : (role === "forecast" ? "Escalation forecast" : "Adversary simulation")),
        extra.length ? el("p", { class: "faint" }, extra.join(" · ")) : null,
        UI.field("Headline", headline), UI.field("Body", body), UI.field("Reasoning", reasoning)
      ]));
    });
    if (status !== "approved") {
      var approve = UI.confirmButton("Approve", "Approve these outputs for the group? Any edits are logged.", function () {
        var edited = JSON.parse(JSON.stringify(outputs));
        var changed = false;
        fields.forEach(function (f) {
          edited[f.role] = Object.assign({}, edited[f.role] || {}, { headline: f.headline.value, body: f.body.value });
          edited.reasoning = edited.reasoning || {};
          edited.reasoning[f.role] = f.reasoning.value;
          if (f.headline.value !== (f.original.headline || "") || f.body.value !== (f.original.body || "") || f.reasoning.value !== ((outputs.reasoning && outputs.reasoning[f.role]) || f.original.reasoning || "")) changed = true;
        });
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/ai/" + side + "/" + tn + "/approve", changed ? { outputs: edited } : {}).then(function () { note.textContent = changed ? "Approved with edits." : "Approved."; pollNow(); }, function (err) { note.textContent = "Could not approve: " + err.message; });
      }, { class: "btn-primary" });
      var reason = el("input", { type: "text", id: "ai-reason-" + side + "-" + tn, placeholder: "" });
      var regenerate = UI.confirmButton("Regenerate", "Regenerate with the reason given? The reason is logged.", function () {
        if (!reason.value.trim()) { note.textContent = "Give a reason for regenerating."; return; }
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/ai/" + side + "/" + tn + "/regenerate", { reason: reason.value.trim() }).then(function () { note.textContent = "Regenerating."; pollNow(); }, function (err) { note.textContent = "Could not regenerate: " + err.message; });
      });
      card.appendChild(el("div", { class: "grid-2" }, [UI.field("Reason for regenerating", reason), el("div", { class: "actions" }, [approve, regenerate])]));
    } else {
      fields.forEach(function (f) { f.headline.disabled = true; f.body.disabled = true; f.reasoning.disabled = true; });
      if (item.edited) card.appendChild(el("p", { class: "diff-note" }, "Approved with facilitator edits (diff logged)."));
    }
    card.appendChild(note);
    if (item.materials) card.appendChild(el("details", null, [el("summary", null, "Prompt materials used"), el("div", { class: "details-body" }, renderAny(item.materials))]));
    if (item.usage) card.appendChild(el("p", { class: "faint mono" }, "Usage: " + JSON.stringify(item.usage) + (item.model ? " · " + item.model : "") + (item.provider ? " · " + item.provider : "")));
    return card;
  }

  // Adversary move card (lab mode): approve, edit, regenerate.
  function adversaryCard(ctx, id, s, tn, item) {
    item = item || {};
    var status = item.status || "pending";
    var move = item.move || {};
    var card = el("div", { class: "card" + (status === "pending" ? " is-flag" : "") });
    var note = partStatus(ctx, "adversary:" + tn);
    UI.append(card, [el("div", { class: "card-title" }, [el("h3", null, "Turn " + tn), el("span", { class: "badge " + (status === "approved" ? "is-green" : "is-amber") }, status)])]);
    if (status === "generating" || (status === "pending" && !Object.keys(move).length)) { card.appendChild(el("p", null, "Generating the adversary's move.")); return card; }
    var controls = {};
    var leverGrid = el("div", { class: "grid-2" });
    LEVER_IDS.forEach(function (lid) {
      var options = lid === "public_statement" ? [{ value: "reassure", label: "Reassure" }, { value: "warn", label: "Warn" }, { value: "none", label: "None" }] : THREE_WAY;
      var select = el("select", { id: "adv-" + tn + "-" + lid }, options.map(function (o) { return el("option", { value: o.value, selected: move[lid] === o.value }, o.label); }));
      controls[lid] = select;
      leverGrid.appendChild(UI.field(lid.replace(/_/g, " "), select));
    });
    var textFields = {};
    ["recommendation", "assumption", "risk", "statement", "hotline"].forEach(function (f) {
      var area = el("textarea", { id: "adv-" + tn + "-" + f, rows: "3" }); area.value = move[f] || "";
      textFields[f] = area;
      card.appendChild(UI.field(f, area));
    });
    card.appendChild(leverGrid);
    if (item.rationale) card.appendChild(el("div", { class: "card is-quiet" }, [el("h3", null, "Rationale (facilitator only)"), UI.paras(item.rationale)]));
    if (status !== "approved") {
      var approve = UI.confirmButton("Approve move", "Approve this move? It feeds the branch rule and the observables like a group submission.", function () {
        var edited = Object.assign({}, move);
        var changed = false;
        Object.keys(controls).forEach(function (k) { if (controls[k].value !== (move[k] || "")) changed = true; edited[k] = controls[k].value; });
        Object.keys(textFields).forEach(function (k) { if (textFields[k].value !== (move[k] || "")) changed = true; edited[k] = textFields[k].value; });
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/adversary/" + tn + "/approve", changed ? { move: edited } : {}).then(function () { note.textContent = "Move approved."; pollNow(); }, function (err) { note.textContent = "Could not approve: " + err.message; });
      }, { class: "btn-primary" });
      var reason = el("input", { type: "text", id: "adv-reason-" + tn });
      var regenerate = UI.confirmButton("Regenerate", "Regenerate the move with the reason given?", function () {
        if (!reason.value.trim()) { note.textContent = "Give a reason for regenerating."; return; }
        api("POST", "/api/sessions/" + encodeURIComponent(id) + "/adversary/" + tn + "/regenerate", { reason: reason.value.trim() }).then(function () { note.textContent = "Regenerating."; pollNow(); }, function (err) { note.textContent = "Could not regenerate: " + err.message; });
      });
      card.appendChild(el("div", { class: "grid-2" }, [UI.field("Reason for regenerating", reason), el("div", { class: "actions" }, [approve, regenerate])]));
    } else {
      Object.keys(controls).forEach(function (k) { controls[k].disabled = true; });
      Object.keys(textFields).forEach(function (k) { textFields[k].disabled = true; });
    }
    card.appendChild(note);
    return card;
  }

  function renderConsolePreview(scenarioId) {
    setPoll(null);
    show("console:preview:" + (scenarioId || ""), function (root) {
      var holder = el("div", { class: "screen" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Facilitator console"), el("h1", null, "Preview content"), consoleNav(), holder]));
      if (!scenarioId) {
        loadScenarios().then(function (scenarios) {
          holder.appendChild(el("div", { class: "card" }, [el("h2", null, "Choose a scenario"), UI.list(scenarios.map(function (s) { return el("a", { href: "#console/preview/" + encodeURIComponent(s.id) }, (s.shortTitle || s.id) + " — " + (s.title || "")); }))]));
        }, function (err) { holder.appendChild(el("div", { class: "notice is-error" }, err.message)); });
        return;
      }
      // Variant toggle: the ai variants (conditions B and C) or the control variants (condition A),
      // so a printed paper pack matches what the screen would have shown.
      var variant = radioRow("previewVariant", "Text variants", [{ value: "B", label: "AI variants (conditions B and C)" }, { value: "A", label: "Control variants (condition A)" }], "B");
      var printButton = el("button", { type: "button", class: "btn btn-quiet" }, "Print");
      printButton.addEventListener("click", function () { window.print(); });
      var body = el("div", { class: "screen" });
      holder.appendChild(el("div", { class: "card no-print" }, [variant.node, el("div", { class: "actions" }, [printButton])]));
      holder.appendChild(body);
      function load(condition) {
        UI.clear(body);
        body.appendChild(el("p", { class: "muted" }, "Loading."));
        api("GET", "/api/scenarios/" + encodeURIComponent(scenarioId) + "/full?condition=" + encodeURIComponent(condition)).then(function (full) {
          UI.clear(body);
          body.appendChild(el("p", { class: "notice" }, "Facilitator view: all sides, all cells and the ground truth. Nothing here is shown to a group. Showing the " + (full.variant === "control" ? "control variants (condition A)" : "AI variants (conditions B and C)") + "."));
          Object.keys(full).forEach(function (k) {
            if (k === "condition" || k === "variant") return;
            body.appendChild(el("details", { open: k === "sides" || k === "facilitator" }, [el("summary", null, k), el("div", { class: "details-body" }, renderAny(full[k]))]));
          });
        }, function (err) { UI.clear(body); body.appendChild(el("div", { class: "notice is-error" }, "Could not load: " + err.message)); });
      }
      variant.onChange(load);
      load(variant.value());
    });
  }

  function renderConsoleDryRun() {
    setPoll(null);
    show("console:dry-run", function (root) {
      var holder = el("div", { class: "screen" });
      root.appendChild(el("div", { class: "screen" }, [el("p", { class: "kicker" }, "Facilitator console"), el("h1", null, "Dry run"), consoleNav(), el("p", { class: "lede" }, "Generates a sample Turn 1 output for one side in condition C without creating a session. Logged as a dry run."), holder]));
      loadScenarios().then(function (scenarios) {
        var scenarioSelect = el("select", { id: "dryScenario" }, scenarios.map(function (s) { return el("option", { value: s.id }, (s.shortTitle || s.id) + " — " + (s.title || "")); }));
        var sideSelect = el("select", { id: "drySide" });
        function fillSides() {
          var s = scenarios.filter(function (x) { return x.id === scenarioSelect.value; })[0] || {};
          var sides = Array.isArray(s.sides) ? s.sides : Object.keys(s.sides || {}).map(function (k) { return Object.assign({ id: k }, s.sides[k]); });
          UI.clear(sideSelect);
          sides.forEach(function (side) { if (side.hasAI !== false) sideSelect.appendChild(el("option", { value: side.id || side }, side.name || side.id || side)); });
        }
        fillSides();
        scenarioSelect.addEventListener("change", fillSides);
        var run = el("button", { type: "button", class: "btn btn-primary" }, "Run");
        var out = el("div", { class: "screen" });
        run.addEventListener("click", function () {
          run.disabled = true;
          UI.clear(out);
          out.appendChild(el("p", { class: "muted" }, "Generating."));
          api("POST", "/api/scenarios/" + encodeURIComponent(scenarioSelect.value) + "/dry-run", { side: sideSelect.value, condition: "C" }).then(function (res) {
            UI.clear(out);
            var outputs = (res && res.outputs) || {};
            out.appendChild(panelView({ session: { id: "dry" } }, 1, Object.assign({ heading: "Sample Turn 1 output" }, outputs)));
            if (outputs.reasoning) out.appendChild(el("div", { class: "card" }, [el("h3", null, "Reasoning"), renderAny(outputs.reasoning)]));
            if (res && res.usage) out.appendChild(el("p", { class: "faint mono" }, "Usage: " + JSON.stringify(res.usage) + (res.provider ? " · " + res.provider : "")));
          }, function (err) { UI.clear(out); out.appendChild(el("div", { class: "notice is-error" }, "Dry run failed: " + err.message)); }).then(function () { run.disabled = false; });
        });
        holder.appendChild(el("div", { class: "card" }, [UI.field("Scenario", scenarioSelect), UI.field("Side", sideSelect), el("div", { class: "actions" }, [run])]));
        holder.appendChild(out);
      }, function (err) { holder.appendChild(el("div", { class: "notice is-error" }, err.message)); });
    });
  }

  // ---------------------------------------------------------------------------
  // 9. Observer view: both sides' drafts, stage, timer, notes with quick tags
  // ---------------------------------------------------------------------------

  var QUICK_TAGS = ["AI cited", "nuclear raised", "dissent", "verification asked", "hotline", "assumption stated"];

  function renderObserver() {
    var ctx = show("observer", function (root) {
      root.classList.add("is-wide");
      var cols = el("div", { class: "side-cols" });
      var notes = el("textarea", { id: "observerNotes", rows: "6" });
      var status = el("p", { class: "muted", role: "status" });
      var tagRow = el("div", { class: "actions", role: "group", "aria-label": "Quick tags" }, QUICK_TAGS.map(function (tag) {
        var b = el("button", { type: "button", class: "btn btn-tag" }, tag);
        b.addEventListener("click", function () {
          var stamp = new Date().toISOString().slice(11, 19);
          var insert = "[" + stamp + " " + tag + "] ";
          var start = notes.selectionStart || notes.value.length;
          notes.value = notes.value.slice(0, start) + insert + notes.value.slice(start);
          notes.focus();
          notes.selectionStart = notes.selectionEnd = start + insert.length;
          api("POST", "/api/me/event", { type: "observer_note", payload: { tags: [tag], text: "" } }).then(function () { status.textContent = "Tag recorded: " + tag; }, function (err) { status.textContent = "Tag not recorded: " + err.message; });
        });
        return b;
      }));
      var save = el("button", { type: "button", class: "btn btn-primary" }, "Save note");
      save.addEventListener("click", function () {
        var text = notes.value.trim();
        if (!text) { status.textContent = "Write a note first."; return; }
        save.disabled = true;
        api("POST", "/api/me/event", { type: "observer_note", payload: { text: text } }).then(function () { status.textContent = "Note saved."; notes.value = ""; }, function (err) { status.textContent = "Not saved: " + err.message; }).then(function () { save.disabled = false; });
      });
      root.appendChild(el("div", { class: "screen" }, [
        el("p", { class: "kicker" }, "Observer"),
        el("h1", null, "Live view"),
        cols,
        el("div", { class: "card" }, [el("h2", null, "Notes"), el("p", { class: "muted" }, "Notes are saved to the session and never shown to the groups. Quick tags are time-stamped by the server."), tagRow, UI.field("Note", notes), el("div", { class: "actions" }, [save]), status])
      ]));
      return { cols: cols, last: null };
    });
    setPoll(function () {
      return api("GET", "/api/me").then(function (me) {
        var s = shape.session(me);
        var sides = me.sides || {};
        var observing = me.side && sides[me.side] ? "Observer · " + (sides[me.side].name || me.side) : "Observer";
        setTopBar({ scenario: shape.scenario(me).shortTitle || shape.scenario(me).title, side: observing, turn: turnOfStage(s.stage), stage: s.stage, timer: s.timer, now: shape.now(me) });
        var json = JSON.stringify([sides, s.stage]);
        if (json === ctx.last) return;
        ctx.last = json;
        UI.clear(ctx.cols);
        var turn = turnOfStage(s.stage);
        Object.keys(sides).forEach(function (side) {
          var v = sides[side] || {};
          var card = el("div", { class: "card" }, [el("h2", null, v.name || side), el("p", { class: "faint" }, (v.kind === "simulated" ? "Simulated side" : (v.ready ? "Ready" : "")))]);
          var turns = turn ? [turn] : Object.keys(v.drafts || v.draft || {}).map(Number);
          if (!turns.length) card.appendChild(el("p", { class: "muted" }, "No draft yet."));
          turns.forEach(function (tn) {
            var draft = (v.drafts && v.drafts[tn]) || (v.draft && v.draft[tn]) || {};
            var sub = (v.submissions && v.submissions[tn]) || null;
            var a = (v.assessments && v.assessments[tn]) || {};
            card.appendChild(el("h3", null, "Turn " + tn + (sub ? " — submitted" : " — draft")));
            card.appendChild(recordView({ content: {} }, sub ? (sub.record || sub) : draft, { assessments: a, statement: (sub && sub.statement) || draft.statement }));
          });
          ctx.cols.appendChild(card);
        });
        if (s.stage === "debrief" && me.debrief) ctx.cols.appendChild(el("div", { class: "card" }, [el("h2", null, "Debrief"), debriefView(me, me.debrief)]));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 10. Boot and routing
  // ---------------------------------------------------------------------------

  function route() {
    var parsed = parseHash(location.hash);
    // A code in the fragment: gate with it, then remove it from the address bar before rendering.
    if (parsed.params.code) {
      var code = parsed.params.code;
      var after = parsed.path === "p" ? "p" : (parsed.path || "");
      var cleanHash = after ? "#" + after : "";
      history.replaceState(null, "", location.pathname + location.search + cleanHash);
      if (after === "p") {
        auth.signOut();
        gateWith(code, "p").catch(function (err) { renderGate({ participant: true, message: gateErrorText(err) }); });
        return;
      }
      auth.signOut();
      gateWith(code, "").catch(function (err) { renderGate({ message: gateErrorText(err) }); });
      return;
    }
    if (parsed.path === "p") return renderParticipant(parsed);
    var role = auth.role();
    if (!auth.token() || !role) return renderGate();
    if (role === "facilitator") {
      if (parsed.path.indexOf("console") !== 0) { history.replaceState(null, "", location.pathname + location.search + "#console"); parsed = parseHash("#console"); }
      return renderConsole(parsed);
    }
    if (role === "observer") return renderObserver();
    if (role === "group") {
      if (auth.participant() && parsed.path !== "p") store.remove("participant");
      setPoll(pollGroup);
      return;
    }
    renderGate();
  }

  window.addEventListener("hashchange", route);
  route();
})();
