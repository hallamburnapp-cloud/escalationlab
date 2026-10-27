// Belfer Lab — ui.js
// Small DOM helpers, the turn-timer widget and a QR code renderer.
// Rendering rule: every string that may carry data goes through textContent or
// createTextNode. Nothing here takes data as HTML.
(function () {
  "use strict";

  // ---------- DOM helpers ----------

  // el("div", { class: "card", id: "x" }, [child, "text", ...])
  // Attributes are set with setAttribute; children that are strings become text nodes.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === "text") { node.textContent = String(value); return; }
        if (key === "dataset") { Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; }); return; }
        if (value === true) { node.setAttribute(key, ""); return; }
        node.setAttribute(key, String(value));
      });
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined) return node;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (typeof child === "string" || typeof child === "number") node.appendChild(document.createTextNode(String(child)));
      else node.appendChild(child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  // Free text split on newlines into <p> elements.
  function paras(text, className) {
    var frag = document.createDocumentFragment();
    String(text === null || text === undefined ? "" : text).split("\n").forEach(function (line) {
      if (line.trim() === "") return;
      frag.appendChild(el("p", className ? { class: className } : null, line));
    });
    return frag;
  }

  // A list of strings (or of nodes) as <ul>/<ol>.
  function list(items, ordered, className) {
    var node = el(ordered ? "ol" : "ul", { class: className || (ordered ? "numbers" : "bullets") });
    (items || []).forEach(function (item) {
      var li = el("li");
      if (typeof item === "string" || typeof item === "number") li.textContent = String(item);
      else if (item) li.appendChild(item);
      node.appendChild(li);
    });
    return node;
  }

  // A labelled key/value block for read-only records.
  function recordRow(key, value) {
    var empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    var valueNode = el("div", { class: "record-value" + (empty ? " is-empty" : "") });
    if (empty) valueNode.textContent = "Not recorded";
    else if (Array.isArray(value)) valueNode.textContent = value.join(", ");
    else if (typeof value === "object") valueNode.textContent = JSON.stringify(value);
    else valueNode.appendChild(paras(String(value)));
    return el("div", { class: "record-row" }, [el("div", { class: "record-key" }, key), valueNode]);
  }

  function wordCount(text) {
    var trimmed = String(text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  // Write to a live region (#live by default). Messages that arrive within 30 ms of each other
  // are joined into one write ("Stage: Turn 1. Indicators."), because a second write to the same
  // node inside a screen reader's debounce replaces the first; the node is cleared first so that a
  // repeated identical message is announced again.
  var announceQueues = {};
  function announce(message, region) {
    var id = region || "live";
    var node = document.getElementById(id);
    if (!node) return;
    var text = String(message === null || message === undefined ? "" : message).trim();
    if (!text) return;
    var q = announceQueues[id];
    if (!q) {
      q = announceQueues[id] = { messages: [] };
      node.textContent = "";
      q.handle = setTimeout(function () {
        delete announceQueues[id];
        node.textContent = q.messages.join(" ");
      }, 30);
    }
    if (q.messages.indexOf(text) < 0) q.messages.push(/[.!?]$/.test(text) ? text : text + ".");
  }

  // A button that asks for a short confirmation inline before calling onConfirm.
  // confirmButton("Advance", "Advance to Turn 1?", fn, { class: "btn-primary" })
  function confirmButton(label, question, onConfirm, opts) {
    opts = opts || {};
    var wrap = el("span", { class: "confirm" });
    var button = el("button", { type: "button", class: "btn " + (opts.class || "") }, label);
    if (opts.disabled) button.disabled = true;
    function reset() { clear(wrap); wrap.appendChild(button); }
    button.addEventListener("click", function () {
      clear(wrap);
      var yes = el("button", { type: "button", class: "btn btn-primary btn-small" }, opts.yesLabel || "Confirm");
      var no = el("button", { type: "button", class: "btn btn-quiet btn-small" }, "Cancel");
      yes.addEventListener("click", function () { reset(); onConfirm(); });
      no.addEventListener("click", reset);
      append(wrap, [el("span", { class: "confirm-text" }, question), yes, no]);
      yes.focus();
    });
    wrap.appendChild(button);
    wrap.setDisabled = function (flag) { button.disabled = !!flag; };
    return wrap;
  }

  // A labelled field wrapper.
  function field(labelText, control, opts) {
    opts = opts || {};
    var id = control.id || ("f" + Math.random().toString(36).slice(2, 9));
    control.id = id;
    var wrap = el("div", { class: "field" });
    wrap.appendChild(el("label", { for: id }, labelText));
    if (opts.help) {
      var helpId = id + "-help";
      wrap.appendChild(el("div", { class: "help", id: helpId }, opts.help));
      control.setAttribute("aria-describedby", helpId);
    }
    wrap.appendChild(control);
    if (opts.after) wrap.appendChild(opts.after);
    return wrap;
  }

  // Format seconds as m:ss.
  function mmss(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ---------- timer widget ----------
  // The server sends its own clock ("now") and the timer's end time. Remaining time is
  // the difference between those two server timestamps; between polls the widget counts
  // down from that figure using elapsed local milliseconds, never the local wall clock.
  function createTimer(node, liveNode) {
    var state = null;        // { running, endsAt, expiry, expired, now }
    var remainingAtSync = 0; // seconds remaining at the last sync
    var syncedAt = 0;        // performance.now() at the last sync
    var handle = null;
    var lastMinuteAnnounced = null;
    var listeners = [];

    function remaining() {
      if (!state || !state.running) return remainingAtSync;
      var elapsed = (performance.now() - syncedAt) / 1000;
      return remainingAtSync - elapsed;
    }

    function render() {
      if (!state || (!state.running && !state.expired)) {
        node.textContent = "";
        node.className = "topbar-item topbar-timer mono";
        node.hidden = true;
        return;
      }
      node.hidden = false;
      var left = remaining();
      var expired = state.expired || left <= 0;
      node.className = "topbar-item topbar-timer mono" + (expired ? " is-expired" : (left <= 120 ? " is-warning" : ""));
      node.textContent = expired ? "Time is up" : mmss(left);
      if (liveNode) {
        var minute = expired ? -1 : Math.ceil(left / 60);
        if (minute !== lastMinuteAnnounced && (expired || minute <= 5 || minute % 5 === 0)) {
          lastMinuteAnnounced = minute;
          liveNode.textContent = expired ? "Time is up." : (minute + (minute === 1 ? " minute" : " minutes") + " remaining.");
        }
      }
      listeners.forEach(function (fn) { fn(expired, left); });
    }

    function set(timer, serverNow) {
      state = timer || null;
      if (state && state.running && state.endsAt && serverNow) {
        var end = Date.parse(state.endsAt);
        var now = Date.parse(serverNow);
        remainingAtSync = isNaN(end) || isNaN(now) ? 0 : (end - now) / 1000;
      } else if (state && typeof state.remainingSeconds === "number") {
        remainingAtSync = state.remainingSeconds;
      } else {
        remainingAtSync = 0;
      }
      syncedAt = performance.now();
      if (!handle) handle = setInterval(render, 1000);
      render();
    }

    return {
      set: set,
      isExpired: function () { return !!state && (state.expired || (state.running && remaining() <= 0)); },
      remaining: remaining,
      onTick: function (fn) { listeners.push(fn); },
      clearListeners: function () { listeners = []; }
    };
  }

  // ---------- QR code (byte mode, versions 1–10, error correction M by default) ----------
  // A straightforward implementation of ISO/IEC 18004: data encoding, Reed–Solomon error
  // correction over GF(256), module placement, masking, format and version information.
  // No data is interpreted; the result is a boolean matrix rendered as inline SVG rects.

  var QR_MAX_VERSION = 10;
  var ECC_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28]
  };
  var ECC_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8]
  };
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function qrRawDataModules(version) {
    var result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      var numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function qrDataCodewords(version, ecl) {
    return Math.floor(qrRawDataModules(version) / 8) - ECC_PER_BLOCK[ecl][version] * ECC_BLOCKS[ecl][version];
  }

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return Array.prototype.slice.call(new TextEncoder().encode(text));
    var out = [];
    var encoded = encodeURIComponent(text);
    for (var i = 0; i < encoded.length; i++) {
      var c = encoded.charAt(i);
      if (c === "%") { out.push(parseInt(encoded.substr(i + 1, 2), 16)); i += 2; }
      else out.push(c.charCodeAt(0));
    }
    return out;
  }

  // Build the bit stream for byte mode, choosing the smallest version that fits.
  function qrEncodeData(bytes, ecl) {
    var version = null;
    for (var v = 1; v <= QR_MAX_VERSION; v++) {
      var countBits = v <= 9 ? 8 : 16;
      var capacityBits = qrDataCodewords(v, ecl) * 8;
      if (4 + countBits + bytes.length * 8 <= capacityBits) { version = v; break; }
    }
    if (version === null) return null;
    var bits = [];
    function push(value, length) { for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });
    var capacity = qrDataCodewords(version, ecl) * 8;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) push(pad, 8);
    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    return { version: version, codewords: codewords };
  }

  // Split into blocks, add error correction, interleave.
  function qrAddEcc(data, version, ecl) {
    var numBlocks = ECC_BLOCKS[ecl][version];
    var eccLen = ECC_PER_BLOCK[ecl][version];
    var rawCodewords = Math.floor(qrRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var divisor = rsDivisor(eccLen);
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var datLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(-1); // placeholder so every block has the same length
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var pos = 0; pos < blocks[0].length; pos++) {
      for (var b = 0; b < blocks.length; b++) {
        if (b < numShortBlocks && pos === shortBlockLen - eccLen) continue;
        result.push(blocks[b][pos]);
      }
    }
    return result;
  }

  function qrAlignmentPositions(version) {
    if (version === 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var size = version * 4 + 17;
    var step = version === 32 ? 26 : Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  // Returns a 2D array of booleans (true = dark), or null if the text is too long.
  function qrMatrix(text, ecl) {
    ecl = ECC_PER_BLOCK[ecl] ? ecl : "M";
    var encoded = qrEncodeData(utf8Bytes(String(text)), ecl);
    if (!encoded) return null;
    var version = encoded.version;
    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }
    function setFunction(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }
    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    }
    function drawAlignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    function drawFormatBits(mask) {
      var data = (ECL_BITS[ecl] << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      function bit(i) { return ((bits >>> i) & 1) === 1; }
      for (var a = 0; a <= 5; a++) setFunction(8, a, bit(a));
      setFunction(8, 7, bit(6));
      setFunction(8, 8, bit(7));
      setFunction(7, 8, bit(8));
      for (var b = 9; b < 15; b++) setFunction(14 - b, 8, bit(b));
      for (var c = 0; c < 8; c++) setFunction(size - 1 - c, 8, bit(c));
      for (var d = 8; d < 15; d++) setFunction(8, size - 15 + d, bit(d));
      setFunction(8, size - 8, true);
    }
    function drawVersion() {
      if (version < 7) return;
      var rem = version;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bits = (version << 12) | rem;
      for (var j = 0; j < 18; j++) {
        var dark = ((bits >>> j) & 1) === 1;
        var a = size - 11 + (j % 3);
        var b = Math.floor(j / 3);
        setFunction(a, b, dark);
        setFunction(b, a, dark);
      }
    }

    // Function patterns.
    for (var t = 0; t < size; t++) { setFunction(6, t, t % 2 === 0); setFunction(t, 6, t % 2 === 0); }
    drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);
    var align = qrAlignmentPositions(version);
    for (var ai = 0; ai < align.length; ai++) {
      for (var aj = 0; aj < align.length; aj++) {
        var corner = (ai === 0 && aj === 0) || (ai === 0 && aj === align.length - 1) || (ai === align.length - 1 && aj === 0);
        if (!corner) drawAlignment(align[ai], align[aj]);
      }
    }
    drawFormatBits(0);
    drawVersion();

    // Data placement in the zigzag order.
    var allCodewords = qrAddEcc(encoded.codewords, version, ecl);
    var dataBits = [];
    allCodewords.forEach(function (cw) { for (var i = 7; i >= 0; i--) dataBits.push((cw >>> i) & 1); });
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!isFunction[yy][x] && bitIndex < dataBits.length) {
            modules[yy][x] = dataBits[bitIndex] === 1;
            bitIndex++;
          }
        }
      }
    }

    // Masking: try all eight, keep the one with the lowest penalty.
    function maskBit(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
    }
    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
        }
      }
    }
    function penalty() {
      var score = 0;
      var dark = 0;
      var y, x, run, colour;
      for (y = 0; y < size; y++) {
        run = 0; colour = false;
        for (x = 0; x < size; x++) {
          if (modules[y][x] === colour) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else { colour = modules[y][x]; run = 1; }
          if (modules[y][x]) dark++;
        }
      }
      for (x = 0; x < size; x++) {
        run = 0; colour = false;
        for (y = 0; y < size; y++) {
          if (modules[y][x] === colour) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else { colour = modules[y][x]; run = 1; }
        }
      }
      for (y = 0; y < size - 1; y++) {
        for (x = 0; x < size - 1; x++) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }
      // Finder-like patterns (1:1:3:1:1 with light space on one side) along rows and columns.
      var patternA = [true, false, true, true, true, false, true, false, false, false, false];
      var patternB = patternA.slice().reverse();
      function matches(get, start, pattern) {
        for (var i = 0; i < pattern.length; i++) if (get(start + i) !== pattern[i]) return false;
        return true;
      }
      for (y = 0; y < size; y++) {
        for (x = 0; x <= size - 11; x++) {
          var rowGet = (function (yy) { return function (i) { return modules[yy][i]; }; })(y);
          if (matches(rowGet, x, patternA) || matches(rowGet, x, patternB)) score += 40;
          var colGet = (function (xx) { return function (i) { return modules[i][xx]; }; })(y);
          if (matches(colGet, x, patternA) || matches(colGet, x, patternB)) score += 40;
        }
      }
      var total = size * size;
      var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      score += k * 10;
      return score;
    }
    var best = 0;
    var bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormatBits(m);
      var s = penalty();
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m); // undo (XOR twice)
    }
    applyMask(best);
    drawFormatBits(best);
    return modules;
  }

  // Render as an inline SVG with a four-module quiet zone. Returns null if the text does not fit.
  function qrSvg(text, opts) {
    opts = opts || {};
    var matrix = qrMatrix(text, opts.ecl || "M");
    if (!matrix) return null;
    var size = matrix.length;
    var quiet = 4;
    var total = size + quiet * 2;
    var svgNs = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 " + total + " " + total);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label || ("QR code for " + text));
    svg.setAttribute("shape-rendering", "crispEdges");
    var bg = document.createElementNS(svgNs, "rect");
    bg.setAttribute("width", String(total));
    bg.setAttribute("height", String(total));
    bg.setAttribute("fill", "#ffffff");
    svg.appendChild(bg);
    // One path for all dark modules keeps the DOM small.
    var d = "";
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (matrix[y][x]) d += "M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z";
      }
    }
    var path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#000000");
    svg.appendChild(path);
    return svg;
  }

  // A QR block with the link printed under it; falls back to large text if the link is too long.
  function qrBlock(url, opts) {
    opts = opts || {};
    var wrap = el("div", { class: "qr" + (opts.large ? " is-large" : "") });
    var svg = qrSvg(url, { label: opts.label });
    if (svg) wrap.appendChild(svg);
    var link = el("a", { href: url, class: svg ? "qr-link" : "big-link" }, url);
    wrap.appendChild(link);
    return wrap;
  }

  window.UI = {
    el: el, append: append, clear: clear, paras: paras, list: list, recordRow: recordRow,
    wordCount: wordCount, announce: announce, confirmButton: confirmButton,
    field: field, mmss: mmss, createTimer: createTimer,
    qrMatrix: qrMatrix, qrSvg: qrSvg, qrBlock: qrBlock
  };
})();
