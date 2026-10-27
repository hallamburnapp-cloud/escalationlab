/* Escalation Lab: access code for the sealed research lab (TIN PROPHET).
 *
 * The front page's form (#lab-access) calls window.enterLab(code, statusEl). The code is checked
 * by the lab server's gate (POST /api/gate, the same validation the lab page uses: constant-time
 * comparison against the facilitator codes and each open session's codes, with failed attempts
 * rate-limited per address). On success the server returns a random session token, never the
 * code; only that token is kept, in sessionStorage under the keys the lab page reads, and the
 * browser goes to /lab/.
 *
 * The code is sent once, in the body of a POST. It is never put in a URL, the history, any
 * storage, a log or analytics, and nothing about the partner is shown before the server accepts it.
 */
(function () {
  "use strict";

  var NOT_RECOGNISED = "That code isn't recognised. Check it with your facilitator.";
  var STORE_KEYS = ["token", "role", "session", "side", "participant", "closed"];

  // Consecutive failures in this page view (memory only). After the third, each further try waits
  // longer: 2, 4, 8 … up to 30 seconds. The server enforces its own per-address limit as well.
  var failures = 0;
  var waitUntil = 0;

  function apiBase() {
    var cfg = window.LAB_CONFIG || {};
    return String(cfg.apiBase || "").replace(/\/+$/, "");
  }

  function setStatus(statusEl, text) {
    if (statusEl) statusEl.textContent = text;
  }

  function formParts() {
    var form = document.getElementById("lab-access");
    return {
      input: form ? form.elements.code : null,
      button: form ? form.querySelector("button[type=submit]") : null
    };
  }

  function busy(on) {
    var p = formParts();
    if (p.button) p.button.disabled = !!on;
    if (p.input) p.input.setAttribute("aria-busy", on ? "true" : "false");
  }

  function signIn(gate) {
    try {
      STORE_KEYS.forEach(function (k) { sessionStorage.removeItem("lab." + k); });
      sessionStorage.setItem("lab.token", gate.token);
      sessionStorage.setItem("lab.role", gate.role);
      if (gate.session) sessionStorage.setItem("lab.session", gate.session);
      if (gate.side) sessionStorage.setItem("lab.side", gate.side);
      return true;
    } catch (e) {
      return false;
    }
  }

  function failed(statusEl) {
    failures += 1;
    if (failures >= 3) waitUntil = Date.now() + Math.min(30, Math.pow(2, failures - 2)) * 1000;
    setStatus(statusEl, NOT_RECOGNISED);
  }

  window.enterLab = function (code, statusEl) {
    var now = Date.now();
    if (now < waitUntil) {
      setStatus(statusEl, "Too many attempts. Wait " + Math.ceil((waitUntil - now) / 1000) + " seconds and try again.");
      return;
    }
    if (typeof fetch !== "function") { setStatus(statusEl, "This browser can't open the lab. Try an up-to-date browser."); return; }
    busy(true);
    setStatus(statusEl, "Checking the code…");
    fetch(apiBase() + "/api/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* not JSON: the server is not answering */ }
        return { status: res.status, data: data, retryAfter: Number(res.headers.get("Retry-After")) || 0 };
      });
    }).then(function (r) {
      busy(false);
      if (r.status === 200 && r.data && r.data.token) {
        failures = 0;
        var p = formParts();
        if (p.input) p.input.value = "";
        if (!signIn(r.data)) { setStatus(statusEl, "This browser is blocking the storage the lab needs. Allow site data for escalationlab.org and try again."); return; }
        setStatus(statusEl, "Code accepted. Opening the lab…");
        location.assign("/lab/");
        return;
      }
      if (r.status === 401) { failed(statusEl); return; }
      if (r.status === 429) {
        var wait = r.retryAfter || (r.data && r.data.retry_after) || 60;
        waitUntil = Date.now() + wait * 1000;
        setStatus(statusEl, "Too many attempts. Wait " + wait + " seconds and try again.");
        return;
      }
      setStatus(statusEl, "The lab can't be reached at the moment. Try again shortly, or tell your facilitator.");
    }).catch(function () {
      busy(false);
      setStatus(statusEl, "The lab can't be reached at the moment. Try again shortly, or tell your facilitator.");
    });
  };

  // A page restored from the back/forward cache must not show a typed code.
  window.addEventListener("pagehide", function () {
    var p = formParts();
    if (p.input) p.input.value = "";
  });
})();
