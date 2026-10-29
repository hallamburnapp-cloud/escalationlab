/* Escalation Lab: the front page's scope keeps sweeping.
 *
 * The opening is the kit's: one turn from 042° back round to 042°, starting at 0.3 s and lasting
 * 3.4 s, in step with the contacts that paint as the sweep passes them (CSS @keyframes paint). After
 * a short rest on FLASHPOINT the sweep keeps turning. Pointing at a lab (or tabbing to it) swings the
 * sweep onto that lab and holds it there; moving the pointer off the scope, or tabbing away, sets it
 * turning again. Under prefers-reduced-motion it stays still at 042°.
 *
 * The rotation is drawn with SVG's own transform="rotate(angle 330 330)", which names the centre,
 * rather than the CSS rotation in the kit's stylesheet: that relies on transform-box: view-box, which
 * Safari measures from the corner of this viewBox (-10, -10), so its sweep pivoted about 10 units off
 * centre. The kit's markup and CSS are left as they are; this script takes the rotation over.
 */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var scope = document.querySelector("svg.scope");
  var sweep = scope && scope.querySelector(".sweep");
  if (!scope || !sweep || !window.requestAnimationFrame) return;

  var motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: no-preference)") : { matches: true };
  var CX = 330, CY = 330;
  var OPEN_DELAY = 300, OPEN_MS = 3400, START = -318, REST = 42; // the kit's @keyframes sweep timing
  var CRUISE = 40;      // degrees per second once it is turning (one turn in 9 s)
  var REST_MS = 1200;   // pause on FLASHPOINT after the opening sweep
  var BEARING = { c1: 42, c2: 140 }; // FLASHPOINT:2027, TIN PROPHET

  // Move the sweep's artwork into a group this script rotates, and switch off the CSS rotation.
  var arm = document.createElementNS(SVGNS, "g");
  arm.setAttribute("class", "sweep-arm");
  while (sweep.firstChild) arm.appendChild(sweep.firstChild);
  sweep.appendChild(arm);

  // Keep the sweep in step with the contacts' paint animations (CSS, unchanged): they start together
  // with the kit's sweep, so the opening begins OPEN_DELAY after the paint animation's own start,
  // once the browser has actually started it. Until then the sweep waits at its starting bearing.
  var now = function () { return document.timeline && document.timeline.currentTime != null ? document.timeline.currentTime : performance.now(); };
  var openStart = Infinity;
  try {
    var paint = scope.querySelector(".c2").getAnimations().filter(function (a) { return a.animationName === "paint"; })[0];
    if (paint && paint.ready) paint.ready.then(function (a) { openStart = (a.startTime != null ? a.startTime : now()) + OPEN_DELAY; schedule(); }, function () { openStart = now(); schedule(); });
    else openStart = now() + OPEN_DELAY;
  } catch (e) { openStart = now() + OPEN_DELAY; }
  sweep.style.animation = "none";
  sweep.style.transform = "none";

  var angle = REST, speed = 0, target = null;
  var mode = "opening";            // opening -> rest -> live
  var visible = true, pointerInside = false;
  var last = 0, frame = 0, restUntil = 0;

  function draw() { arm.setAttribute("transform", "rotate(" + angle.toFixed(2) + " " + CX + " " + CY + ")"); }

  function tick() {
    frame = 0;
    var t = now();
    var dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    if (mode === "opening") {
      var p = openStart === Infinity ? 0 : (t - openStart) / OPEN_MS;
      if (p >= 1) { angle = REST; mode = "rest"; restUntil = t + REST_MS; }
      else angle = START + 360 * Math.max(0, p);
    } else if (mode === "rest") {
      angle = REST;
      if (t >= restUntil) mode = "live";
    } else if (target !== null) {
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

  function settled() { return mode === "live" && target !== null && Math.abs(((target - angle) % 360 + 540) % 360 - 180) < 0.05; }

  function schedule() {
    if (visible && motion.matches && !settled() && !frame) frame = requestAnimationFrame(tick);
    if (settled() || !visible || !motion.matches) last = 0;
  }

  function lock(name) {
    if (!motion.matches) return;
    mode = "live";
    target = BEARING[name];
    schedule();
  }

  function release() {
    target = null;
    if (mode === "live") schedule();
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

  // Don't spend frames on a scope nobody can see.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      schedule();
    }).observe(scope);
  }

  // Reduced motion: still at 042°, switched on or off mid-visit.
  if (motion.addEventListener) {
    motion.addEventListener("change", function () {
      if (motion.matches) { mode = "live"; schedule(); return; }
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      target = null; angle = REST; speed = 0; draw();
    });
  }

  draw();
  if (motion.matches) schedule();
})();
