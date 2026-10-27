/* Escalation Lab: the front page's scope keeps sweeping.
 *
 * The kit's opening sweep (CSS: @keyframes sweep, one turn resting on FLASHPOINT at 042°) plays
 * first. After a short rest the sweep keeps turning. Pointing at a lab (or tabbing to it) swings the
 * sweep onto that lab and holds it there; moving the pointer off the scope, or tabbing away, sets it
 * turning again. Under prefers-reduced-motion nothing here runs and the scope stays still at 042°.
 */
(function () {
  "use strict";

  var scope = document.querySelector("svg.scope");
  var sweep = scope && scope.querySelector(".sweep");
  if (!scope || !sweep || !window.requestAnimationFrame) return;

  var motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: no-preference)") : { matches: true };
  var CRUISE = 40;      // degrees per second once it is turning (one turn in 9 s)
  var REST_MS = 1200;   // pause on FLASHPOINT after the opening sweep
  var BEARING = { c1: 42, c2: 140 }; // FLASHPOINT:2027, TIN PROPHET

  var angle = 42, speed = 0, target = null;
  var running = false, started = false, visible = true, pointerInside = false;
  var last = 0, frame = 0, restTimer = 0;

  function currentAngle() {
    var m = getComputedStyle(sweep).transform;
    var v = /matrix\(([^)]+)\)/.exec(m || "");
    if (!v) return angle;
    var p = v[1].split(",").map(Number);
    return Math.atan2(p[1], p[0]) * 180 / Math.PI;
  }

  // Take over from the CSS animation, keeping the sweep where it is.
  function takeOver() {
    if (started) return;
    started = true;
    clearTimeout(restTimer);
    angle = currentAngle();
    sweep.style.animation = "none";
    draw();
  }

  function draw() { sweep.style.transform = "rotate(" + angle.toFixed(2) + "deg)"; }

  function tick(now) {
    frame = 0;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (target !== null) {
      var delta = ((target - angle) % 360 + 540) % 360 - 180; // shortest way round
      angle += delta * (1 - Math.exp(-dt * 9));
      speed = 0;
    } else {
      speed += (CRUISE - speed) * (1 - Math.exp(-dt * 1.5)); // ease back up to speed
      angle += speed * dt;
    }
    angle %= 360;
    draw();
    schedule();
  }

  function schedule() {
    var settled = target !== null && Math.abs(((target - angle) % 360 + 540) % 360 - 180) < 0.05;
    if (running && visible && motion.matches && !settled && !frame) frame = requestAnimationFrame(tick);
    if (settled || !visible || !motion.matches) last = 0;
  }

  function start() {
    if (!motion.matches) return;
    takeOver();
    running = true;
    schedule();
  }

  function lock(name) {
    if (!motion.matches) return;
    takeOver();
    running = true;
    target = BEARING[name];
    schedule();
  }

  function release() {
    target = null;
    if (started) { running = true; schedule(); }
  }

  ["c1", "c2"].forEach(function (name) {
    var link = scope.querySelector("." + name + " a");
    if (!link) return;
    link.addEventListener("pointerenter", function () { lock(name); });
    link.addEventListener("focus", function () { lock(name); });
    link.addEventListener("blur", function () { if (!pointerInside) release(); });
  });
  scope.addEventListener("pointerenter", function () { pointerInside = true; });
  scope.addEventListener("pointerleave", function () {
    pointerInside = false;
    if (!scope.contains(document.activeElement)) release();
  });

  // Hand over after the opening sweep has come to rest on FLASHPOINT.
  sweep.addEventListener("animationend", function (e) {
    if (e.animationName !== "sweep" || started) return;
    restTimer = setTimeout(function () { if (target === null) start(); }, REST_MS);
  });

  // Don't spend frames on a scope nobody can see.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      schedule();
    }).observe(scope);
  }

  // Reduced motion switched on mid-visit: stop where the kit rests.
  if (motion.addEventListener) {
    motion.addEventListener("change", function () {
      if (motion.matches) { if (started) { running = true; schedule(); } return; }
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      running = false; target = null; angle = 42; speed = 0;
      sweep.style.transform = ""; sweep.style.animation = "";
    });
  }
})();
