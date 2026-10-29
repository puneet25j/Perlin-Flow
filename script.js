// Perlin Flow: the flow-field simulation, text block and controls for index.html.
// Same noise and presets as cover.py, so pattern numbers match between the two.
(() => {
  "use strict";

  // ------------------------------------------------------------ constants
  let W = 1584, H = 396, S = 2;                // cover size, rendered at 2x (Options → Size)
  let PW = W * S, PH = H * S, N = PW * PH;     // output pixels
  const BG = [0x28, 0x2c, 0x34];
  const CYAN = [0x9c, 0xde, 0xf2], CORAL = [0xe0, 0x6c, 0x75], TEAL = [0x5f, 0xb6, 0xcc];
  const SKEW = 0.25;                            // synthetic italic (~14°), like a browser's

  // Presets: keep in sync with STYLES in cover.py.
  // frames = simulation steps before the picture counts as "painted".
  const STYLES = {
    // silky cyan strokes following the curl of the noise, with a gentle current
    streams: { mode: "streams", particles: 1300, alpha: 0.95, fade: 0.006, frames: 900, scrim: 0.92,
               current: 0.8, currentDeg: -20, zoom: 0.0026, detail: 0.3, lifespan: [120, 220],
               stroke: 0.8, gamma: 0.8 },
    // coloured dots whose trails gather into feathered lines
    bold:    { mode: "dots", particles: 1300, alpha: 0.38, fade: 0.025, frames: 1200, scrim: 0,
               freq: 0.004, turns: 5, lifespan: [150, 600], radius: 1.1 },
  };

  // Options panel: same names, meanings and defaults as the cover.py command-line
  // options. Style-specific defaults come from STYLES; the rest from GLOBAL_DEFAULTS.
  // apply: live = takes effect on the next step, restart = repaints, text = redraws
  // the text, frames = changes the paint length, size = rebuilds the canvas.
  const GLOBAL_DEFAULTS = { seed: 7, right: 72, bottom: 44, width: 1584, height: 396, scale: 2 };
  const OPTIONS = [
    { key: "seed",      group: "bg",   label: "Seed",          type: "number", min: 0, max: 99999, step: 1, apply: "restart" },
    { key: "particles", group: "bg",   label: "Particles",     min: 100, max: 4000, step: 50, apply: "restart" },
    { key: "alpha",     group: "bg",   label: "Brightness",    min: 0.05, max: 1, step: 0.01, apply: "live" },
    { key: "fade",      group: "bg",   label: "Trail fade",    min: 0.001, max: 0.1, step: 0.001, apply: "live" },
    { key: "frames",    group: "bg",   label: "Paint steps",   min: 100, max: 3000, step: 50, apply: "frames" },
    { key: "radius",    group: "bg",   label: "Dot size",      min: 0.5, max: 3, step: 0.1, apply: "live", only: "bold" },
    { key: "current",   group: "bg",   label: "Current",       min: 0, max: 2, step: 0.05, apply: "live", only: "streams" },
    { key: "zoom",      group: "bg",   label: "Zoom",          min: 0.001, max: 0.01, step: 0.0001, apply: "live", only: "streams" },
    { key: "scrim",     group: "text", label: "Text halo",     min: 0, max: 1, step: 0.01, apply: "text" },
    { key: "right",     group: "text", label: "Right margin",  min: 0, max: 600, step: 1, apply: "text" },
    { key: "bottom",    group: "text", label: "Bottom margin", min: 0, max: 300, step: 1, apply: "text" },
    { key: "width",     group: "size", label: "Width",         type: "number", min: 200, max: 4000, step: 1, apply: "size" },
    { key: "height",    group: "size", label: "Height",        type: "number", min: 100, max: 2000, step: 1, apply: "size" },
    { key: "scale",     group: "size", label: "Scale",         type: "select", choices: [1, 2, 3], apply: "size" },
  ];
  const MAX_PIXELS = 12e6;                      // keeps memory use reasonable in the browser

  // ------------------------------------------------------------ noise
  // Same algorithm, seed and constants as cover.py, so both produce the
  // exact same noise field (and the same pattern numbers).

  // Tiny deterministic 32-bit PRNG returning floats in [0, 1).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 2-D gradient (Perlin) noise. A shuffled permutation table picks one of eight
  // gradient directions for every grid corner; the four corners of a cell are
  // blended with a quintic fade curve. Output is roughly in [-1, 1].
  const PERM = (() => {
    const rand = mulberry32(20261028);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {                // Fisher-Yates shuffle
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    return Int32Array.from(p.concat(p));           // doubled so lookups never wrap
  })();
  const D = 0.7071067811865476;
  const GX = [1, -1, 0, 0, D, -D, D, -D];
  const GY = [0, 0, 1, -1, D, D, -D, -D];
  const NOISE_SCALE = 1.4142135623730951;

  function perlin(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const xi = x0 & 255, yi = y0 & 255;
    const fx = x - x0, fy = y - y0;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = PERM[xi] + yi, b = PERM[xi + 1] + yi;
    const g00 = PERM[a] & 7, g01 = PERM[a + 1] & 7, g10 = PERM[b] & 7, g11 = PERM[b + 1] & 7;
    const n00 = GX[g00] * fx + GY[g00] * fy;
    const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
    const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
    const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * NOISE_SCALE;
  }

  // The noise grid is rotated by 0.5 rad against the image so its cells never
  // line up with the cover's edges.
  const ROT_C = 0.8775825618903728, ROT_S = 0.479425538604203;
  function field(x, y, freq, ox, oy) {
    return perlin((x * ROT_C - y * ROT_S) * freq + ox, (x * ROT_S + y * ROT_C) * freq + oy);
  }

  // ------------------------------------------------------------ elements & buffers
  const $ = id => document.getElementById(id);
  const canvas = $("cover"), ctx = canvas.getContext("2d");
  let frameImg = ctx.createImageData(PW, PH);
  let frame32 = new Uint32Array(frameImg.data.buffer);        // little-endian RGBA
  const textLayer = document.createElement("canvas");
  textLayer.width = PW; textLayer.height = PH;
  const tctx = textLayer.getContext("2d");
  const maskLayer = document.createElement("canvas");
  maskLayer.width = PW; maskLayer.height = PH;
  const mctx = maskLayer.getContext("2d");

  let style = "streams", pattern = 0, playing = true, showText = true, stopWhenPainted = false;
  let sim = null, needsCompose = true, autoPaused = false;
  const opts = {};                                            // current option values
  let recording = false, recordPct = 0;                       // GIF capture in progress
  const GIF_DEFAULTS = { seconds: 3, fps: 20, width: 1200 };
  const gifOpts = { ...GIF_DEFAULTS };

  // Trails fade by a constant factor each step. Instead of touching every pixel
  // every step, buffers hold value / gain and gain shrinks; new paint is written
  // pre-divided by gain, and gain is folded back in now and then.
  let ink = null, acc = null, touched = null, lut = null;     // streams: cyan amount 0..1
  let dif = null;                                             // dots: colour minus background
  let gain = 1;

  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------ simulation
  function newSim() {
    // the style preset, with any option values that apply to this style on top
    const p = { ...STYLES[style] };
    for (const key of Object.keys(p)) if (key in opts) p[key] = opts[key];
    const rng = mulberry32(Math.imul(pattern + 1, 2654435761) ^ Math.imul(opts.seed + 1, 0x85ebca6b) ^ 0x5bd1e995);
    const [lifeMin, lifeMax] = p.lifespan;
    const spawnLife = () => lifeMin + rng() * (lifeMax - lifeMin);
    const n = p.particles;
    const px = new Float64Array(n), py = new Float64Array(n);
    const age = new Float64Array(n), life = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      px[i] = rng() * W; py[i] = rng() * H;
      life[i] = spawnLife(); age[i] = rng() * life[i];       // start mid-life
    }
    if (p.mode === "streams") {
      if (!ink) { ink = new Float32Array(N); acc = new Float32Array(N); } else { ink.fill(0); acc.fill(0); }
      const R = Math.ceil(p.stroke + 0.5);
      touched = new Int32Array(n * 8 * (2 * R + 1) * (2 * R + 1));
      buildLut(p.gamma);
    } else {
      if (!dif) dif = new Float32Array(N * 3); else dif.fill(0);
    }
    gain = 1;
    const tint = [CYAN, CORAL, TEAL].map(c => c.map((v, k) => v - BG[k]));
    sim = { p, rng, n, px, py, age, life, spawnLife, tint, t: 0,
            ox: pattern * 61.7, oy: pattern * 113.9 };
    autoPaused = false;
  }

  function renormalize(buf) {
    if (gain > 1e-6) return;
    for (let i = 0; i < buf.length; i++) buf[i] *= gain;
    gain = 1;
  }

  // Antialiased disc splat helper: calls hit(index, coverage) for each pixel.
  function splat(cx, cy, r, hit) {
    const R = Math.ceil(r + 0.5), rr = r + 0.5;
    const bx = Math.floor(cx), by = Math.floor(cy);
    for (let dy = -R; dy <= R; dy++) {
      const iy = by + dy;
      if (iy < 0 || iy >= PH) continue;
      const ddy = iy + 0.5 - cy, row = iy * PW;
      for (let dx = -R; dx <= R; dx++) {
        const ix = bx + dx;
        if (ix < 0 || ix >= PW) continue;
        const ddx = ix + 0.5 - cx;
        let cov = rr - Math.sqrt(ddx * ddx + ddy * ddy);
        if (cov <= 0) continue;
        hit(row + ix, cov > 1 ? 1 : cov);
      }
    }
  }

  // Streams: particles follow the curl of a noise stream function and draw
  // short, tapered strokes from their previous to their new position.
  function stepStreams(s) {
    const p = s.p;
    gain *= 1 - p.fade;
    const inv = 1 / gain;
    const th = p.currentDeg * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
    const zoom = p.zoom, det = p.detail, cur = p.current * zoom, ox = s.ox, oy = s.oy, t = s.t;
    const psi = (x, y) =>                                         // stream function
      field(x + t * 0.2, y, zoom, ox, oy)
      + det * field(x, y, zoom * 2.03, ox + 17.3, oy + 41.9)
      + cur * (ct * y - st * x);
    const e = 0.75, SAMPLES = 8;
    const { px, py, age, life, rng, n } = s;
    let nt = 0, ba = 0;
    const addAcc = (idx, cov) => { if (acc[idx] === 0) touched[nt++] = idx; acc[idx] += ba * cov; };

    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i];
      const gx = (psi(x + e, y) - psi(x - e, y)) / (2 * e);
      const gy = (psi(x, y + e) - psi(x, y - e)) / (2 * e);
      const ang = Math.atan2(-gx, gy);                          // direction of (dpsi/dy, -dpsi/dx)
      const spd = 1.75 + 0.75 * field(x, y, zoom * 0.7, ox + 31.7, oy + 47.3);
      const nx = x + Math.cos(ang) * spd, ny = y + Math.sin(ang) * spd;
      const a = age[i] + 1;
      if (a >= life[i] || nx < 0 || nx > W || ny < 0 || ny > H) {   // respawn
        px[i] = rng() * W; py[i] = rng() * H; life[i] = s.spawnLife(); age[i] = 0;
        continue;
      }
      px[i] = nx; py[i] = ny; age[i] = a;
      // sine envelope over the particle's life tapers both ends of each stroke
      ba = Math.sin(Math.PI * Math.min(a / life[i], 1)) * p.alpha / SAMPLES * 2.2;
      for (let k = 0; k < SAMPLES; k++) {
        const f = (k + 0.5) / SAMPLES;
        splat((x + (nx - x) * f) * S, (y + (ny - y) * f) * S, p.stroke, addAcc);
      }
    }
    for (let j = 0; j < nt; j++) {
      const idx = touched[j];
      let a = acc[idx];
      if (a > 1) a = 1;
      ink[idx] = ink[idx] * (1 - a) + a * inv;
      acc[idx] = 0;
    }
    renormalize(ink);
    s.t++;
  }

  // Dots: particles step along the noise heading and leave fading dots, whose
  // trails gather into feathered lines where the field converges.
  function stepDots(s) {
    const p = s.p;
    gain *= 1 - p.fade;
    const inv = 1 / gain;
    const { px, py, age, life, rng, n, tint } = s, ox = s.ox, oy = s.oy, t = s.t;
    const r = p.radius * S;
    let c0 = 0, c1 = 0, c2 = 0, strength = 0;
    const blend = (idx, cov) => {
      const a = strength * cov, ia = 1 - a, j = idx * 3;
      dif[j] = dif[j] * ia + c0 * a; dif[j + 1] = dif[j + 1] * ia + c1 * a; dif[j + 2] = dif[j + 2] * ia + c2 * a;
    };
    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i];
      const ang = field(x + t * 0.2, y, p.freq, ox, oy) * Math.PI * p.turns;
      const spd = 1.75 + 0.75 * field(x, y, p.freq * 0.7, ox + 31.7, oy + 47.3);
      x += Math.cos(ang) * spd; y += Math.sin(ang) * spd;
      let a = age[i] + 1;
      if (a >= life[i] || x < 0 || x > W || y < 0 || y > H) {   // respawn
        x = rng() * W; y = rng() * H; life[i] = s.spawnLife(); a = 0;
      }
      px[i] = x; py[i] = y; age[i] = a;
      const c = tint[i % 3];
      c0 = c[0] * inv; c1 = c[1] * inv; c2 = c[2] * inv;
      strength = (1 - a / life[i]) * p.alpha;                   // dims as it ages
      splat(x * S, y * S, r, blend);
    }
    renormalize(dif);
    s.t++;
  }

  const step = () => (sim.p.mode === "streams" ? stepStreams : stepDots)(sim);

  function buildLut(gamma) {
    lut = new Uint32Array(4096);
    for (let q = 0; q < 4096; q++) {
      const v = Math.pow(q / 4095, gamma);
      const r = Math.round(BG[0] + (CYAN[0] - BG[0]) * v);
      const g = Math.round(BG[1] + (CYAN[1] - BG[1]) * v);
      const b = Math.round(BG[2] + (CYAN[2] - BG[2]) * v);
      lut[q] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
  }

  function writePixels() {
    if (sim.p.mode === "streams") {
      const k = gain * 4095;
      for (let i = 0; i < N; i++) {
        let q = (ink[i] * k + 0.5) | 0;
        if (q > 4095) q = 4095;
        frame32[i] = lut[q];
      }
    } else {
      const g0 = BG[0] + 0.5, g1 = BG[1] + 0.5, g2 = BG[2] + 0.5, k = gain;
      for (let i = 0, j = 0; i < N; i++, j += 3) {
        let r = (g0 + dif[j] * k) | 0, g = (g1 + dif[j + 1] * k) | 0, b = (g2 + dif[j + 2] * k) | 0;
        if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
        frame32[i] = 0xff000000 | (b << 16) | (g << 8) | r;
      }
    }
  }

  // ------------------------------------------------------------ text block
  function textSpecs() {
    return [
      { text: $("greeting").value, size: 20, weight: 500, ls: 0.3,   color: CORAL, alpha: 0.9, italic: true,  gap: 8 },
      { text: $("name").value,     size: 44, weight: 700, ls: -0.44, color: CYAN,  alpha: 1,   italic: false, gap: 12 },
      { text: $("title").value,    size: 20, weight: 500, ls: 0.3,   color: CORAL, alpha: 1,   italic: false, gap: 0 },
    ].filter(s => s.text.trim() !== "");
  }

  function layoutLines() {
    const lines = [], rightX = PW - opts.right * S;
    let yBottom = PH - opts.bottom * S;                          // lines stack upward from the bottom margin
    textSpecs().reverse().forEach((s, i) => {
      const font = `${s.weight} ${s.size * S}px "Fira Code"`;
      tctx.font = font;
      const chars = Array.from(s.text);
      const adv = chars.map(ch => tctx.measureText(ch).width);
      const sp = s.ls * S;
      const width = adv.reduce((a, b) => a + b, 0) + sp * (chars.length - 1);
      const m = tctx.measureText(s.text);
      if (i) yBottom -= s.gap * S;
      const base = yBottom - m.actualBoundingBoxDescent;         // visual bottom sits on yBottom
      const top = base - m.actualBoundingBoxAscent;
      let x = rightX - width;
      if (s.italic) x -= SKEW * (base - top) * 0.5;              // keep the slanted line visually aligned
      lines.push({ ...s, font, chars, adv, sp, x, base });
      yBottom = top;
    });
    return lines;
  }

  function drawLines(c, lines, { fill = null, stroke = 0, shift = 0 } = {}) {
    for (const L of lines) {
      c.save();
      if (L.italic) c.setTransform(1, 0, -SKEW, 1, SKEW * L.base, 0);
      c.font = L.font; c.textBaseline = "alphabetic"; c.textAlign = "left";
      c.fillStyle = fill || `rgba(${L.color.join(",")},${L.alpha})`;
      if (stroke) { c.lineWidth = stroke; c.lineJoin = "round"; c.strokeStyle = fill || "#fff"; }
      let x = L.x + shift;
      L.chars.forEach((ch, k) => {
        if (stroke) c.strokeText(ch, x, L.base);
        c.fillText(ch, x, L.base);
        x += L.adv[k] + L.sp;
      });
      c.restore();
    }
  }

  function renderText() {
    tctx.clearRect(0, 0, PW, PH);
    needsCompose = true;
    const lines = layoutLines();
    if (!lines.length) return;
    const OFF = PW + 600;                                        // draw off-canvas so only the shadow lands

    const scrim = opts.scrim;
    if (scrim > 0) {                                             // soft halo in the background colour
      mctx.clearRect(0, 0, PW, PH);
      drawLines(mctx, lines, { fill: "#fff", stroke: 22 * S });
      tctx.save();
      tctx.shadowColor = `rgba(${BG.join(",")},${scrim})`;
      tctx.shadowBlur = 2 * 18 * S;
      tctx.shadowOffsetX = OFF;
      tctx.drawImage(maskLayer, -OFF, 0);
      tctx.drawImage(maskLayer, -OFF, 0);
      tctx.restore();
    }

    tctx.save();                                                 // drop shadow: 0 2px 20px rgba(0,0,0,.45)
    tctx.shadowColor = "rgba(0,0,0,0.45)";
    tctx.shadowBlur = 20 * S;
    tctx.shadowOffsetX = OFF;
    tctx.shadowOffsetY = 2 * S;
    drawLines(tctx, lines, { fill: "#000", shift: -OFF });
    tctx.restore();

    drawLines(tctx, lines);
  }

  // ------------------------------------------------------------ render loop
  function compose() {
    ctx.putImageData(frameImg, 0, 0);
    if (showText) ctx.drawImage(textLayer, 0, 0);
    needsCompose = false;
  }

  const statusEl = $("status"), statusText = statusEl.querySelector("span");
  function updateStatus() {
    const p = sim.p, painting = sim.t < p.frames;
    let state, label;
    if (recording) { state = "recording"; label = `Recording GIF ${recordPct}%`; }
    else if (painting) { state = "painting"; label = `${playing ? "Painting" : "Paused"} ${Math.floor(sim.t / p.frames * 100)}%`; }
    else if (playing) { state = "live"; label = "Live"; }
    else { state = "paused"; label = "Paused"; }
    if (statusEl.dataset.state !== state) statusEl.dataset.state = state;
    if (statusText.textContent !== label) statusText.textContent = label;
  }

  function loop() {
    requestAnimationFrame(loop);
    if (recording) { updateStatus(); return; }                   // the GIF recorder drives the frames
    if (playing) {
      const p = sim.p, start = performance.now();
      if (sim.t < p.frames) {                                    // paint quickly: several steps per frame
        do { step(); } while (sim.t < p.frames && performance.now() - start < 36);
        // stop exactly when painted (the frame cover.py saves), if asked to
        if (sim.t >= p.frames && (stopWhenPainted || reduceMotion) && !autoPaused) { autoPaused = true; setPlaying(false); }
      } else {
        step();
      }
      writePixels();
      compose();
    } else if (needsCompose) {
      compose();
    }
    updateStatus();
  }

  // ------------------------------------------------------------ controls
  function setPlaying(v) {
    playing = v;
    $("play").textContent = v ? "Pause" : "Play";
  }
  function restart() {
    newSim();
    writePixels();
    compose();
  }
  function setPattern(v) {
    v = Math.max(0, Math.min(99999, Math.floor(Number(v) || 0)));
    pattern = v;
    $("pattern").value = v;
    restart();
    updateCommand();
  }

  // ------------------------------------------------------------ options panel
  const controls = {};
  // This style's preset value, else the global default, else the other style's
  // preset (so options hidden for this style still hold a sensible value).
  const defaultFor = key => {
    if (key in STYLES[style]) return STYLES[style][key];
    if (key in GLOBAL_DEFAULTS) return GLOBAL_DEFAULTS[key];
    return Object.values(STYLES).find(p => key in p)[key];
  };
  const applies = o => !o.only || o.only === style;
  const decimals = o => (String(o.step).split(".")[1] || "").length;
  const numText = (o, v) => String(Number(Number(v).toFixed(decimals(o))));   // 0.0060 -> "0.006"

  function resetOptions(keys) {
    for (const o of OPTIONS) if (!keys || keys.includes(o.key)) opts[o.key] = defaultFor(o.key);
  }

  function buildControls() {
    for (const o of OPTIONS) {
      const wrap = document.createElement("label");
      wrap.className = "opt";
      const head = document.createElement("span");
      head.className = "opt-head";
      const name = document.createElement("span");
      name.textContent = o.label;
      head.appendChild(name);
      let input, out = null;
      if (o.type === "select") {
        input = document.createElement("select");
        for (const c of o.choices) input.add(new Option(`${c}×`, c));
      } else {
        input = document.createElement("input");
        input.type = o.type === "number" ? "number" : "range";
        input.min = o.min; input.max = o.max; input.step = o.step;
        if (input.type === "range") { out = document.createElement("output"); head.appendChild(out); }
      }
      const flag = document.createElement("span");
      flag.className = "opt-flag";
      flag.textContent = `--${o.key}`;                           // the matching cover.py option
      wrap.append(head, input, flag);
      $(`grp-${o.group}`).appendChild(wrap);
      controls[o.key] = { wrap, input, out };
      input.addEventListener("input", () => onOption(o, false));
      input.addEventListener("change", () => onOption(o, true));
    }
    // Not a cover.py option: pause at the exact frame cover.py would save.
    const stop = document.createElement("label");
    stop.className = "opt check-opt";
    stop.innerHTML = '<input type="checkbox" id="stopPainted"> Stop when painted';
    $("grp-bg").appendChild(stop);
    $("stopPainted").addEventListener("change", e => {
      stopWhenPainted = e.target.checked;
      if (stopWhenPainted && sim.t >= sim.p.frames) { restart(); setPlaying(true); }  // repaint, then stop
    });

    // GIF settings (page only: cover.py has no GIF output)
    const GIF_CONTROLS = [
      { key: "seconds", label: "Length", min: 1, max: 6, step: 0.5, unit: "s" },
      { key: "fps", label: "Frame rate", choices: [15, 20, 30], unit: "fps" },
      { key: "width", label: "Width", choices: [800, 1200, 1584], unit: "px" },
    ];
    for (const g of GIF_CONTROLS) {
      const wrap = document.createElement("label");
      wrap.className = "opt";
      const head = document.createElement("span");
      head.className = "opt-head";
      head.appendChild(Object.assign(document.createElement("span"), { textContent: g.label }));
      let input, out = null;
      if (g.choices) {
        input = document.createElement("select");
        for (const c of g.choices) input.add(new Option(`${c} ${g.unit}`, c));
      } else {
        input = Object.assign(document.createElement("input"), { type: "range", min: g.min, max: g.max, step: g.step });
        out = document.createElement("output");
        head.appendChild(out);
      }
      const note = Object.assign(document.createElement("span"), { className: "opt-flag", textContent: "page only" });
      wrap.append(head, input, note);
      $("grp-gif").appendChild(wrap);
      controls[`gif-${g.key}`] = { wrap, input, out, unit: g.unit };
      input.addEventListener("input", () => {
        gifOpts[g.key] = Number(input.value);
        if (out) out.textContent = `${gifOpts[g.key]} ${g.unit}`;
      });
    }
  }

  function syncGifControls() {
    for (const key of Object.keys(GIF_DEFAULTS)) {
      const c = controls[`gif-${key}`];
      c.input.value = gifOpts[key];
      if (c.out) c.out.textContent = `${gifOpts[key]} ${c.unit}`;
    }
  }

  function syncControls() {
    for (const o of OPTIONS) {
      const c = controls[o.key];
      c.wrap.hidden = !applies(o);
      c.input.value = opts[o.key];
      if (c.out) c.out.textContent = numText(o, opts[o.key]);
    }
  }

  function onOption(o, committed) {
    const c = controls[o.key];
    if (o.type === "number" && !committed) return;               // numbers apply on Enter / leaving the box
    let v = Number(c.input.value);
    if (!Number.isFinite(v)) v = opts[o.key];
    v = Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
    if (o.type === "number") { v = Math.round(v); c.input.value = v; }
    opts[o.key] = v;
    if (c.out) c.out.textContent = numText(o, v);
    if (o.apply === "live") sim.p[o.key] = v;                    // used from the next step on
    else if (o.apply === "frames") { sim.p.frames = v; autoPaused = false; }
    else if (o.apply === "text") renderText();
    else if (o.apply === "restart" && committed) restart();
    else if (o.apply === "size" && committed) applySize();
    updateCommand();
  }

  function updateSpec() {
    $("spec").textContent = `Cover · ${W} × ${H} · downloads at ${PW} × ${PH}`;
  }

  // Rebuild the canvas and buffers for a new width, height or scale.
  function applySize() {
    let s = opts.scale;
    while (s > 1 && opts.width * s * opts.height * s > MAX_PIXELS) s--;
    $("optNote").dataset.scaleNote = s !== opts.scale ? `Scale lowered to ${s}× to fit in browser memory.` : "";
    opts.scale = s;
    W = opts.width; H = opts.height; S = s;
    PW = W * S; PH = H * S; N = PW * PH;
    canvas.width = PW; canvas.height = PH;
    canvas.style.aspectRatio = `${W} / ${H}`;
    frameImg = ctx.createImageData(PW, PH);
    frame32 = new Uint32Array(frameImg.data.buffer);
    textLayer.width = maskLayer.width = PW;
    textLayer.height = maskLayer.height = PH;
    ink = acc = dif = null;                                      // reallocated by newSim at the new size
    syncControls();
    updateSpec();
    renderText();
    restart();
    updateNote();
  }

  // The cover.py command for the current settings (only values that differ from
  // cover.py's defaults). Text is single-quoted so shells leave it untouched.
  const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  function buildCommand() {
    const parts = ["python cover.py"];
    if (style !== "bold") parts.push(`--style ${style}`);       // bold is cover.py's default
    if (pattern) parts.push(`--pattern ${pattern}`);
    for (const o of OPTIONS) {
      if (!applies(o)) continue;
      if (numText(o, opts[o.key]) !== numText(o, defaultFor(o.key))) parts.push(`--${o.key} ${numText(o, opts[o.key])}`);
    }
    if (showText) {
      for (const key of ["greeting", "name", "title"]) {
        const v = $(key).value;
        if (v.trim()) parts.push(`--${key} ${shellQuote(v)}`);
      }
    }
    return parts.join(" ");
  }
  const updateCommand = () => { $("cmd").textContent = buildCommand(); };

  function updateNote() {
    const extra = $("optNote").dataset.scaleNote;
    $("optNote").textContent = "Run the command in the repo folder to render these settings with cover.py. "
      + "It uses the same flow field; individual strokes differ slightly." + (extra ? ` ${extra}` : "");
  }

  $("copyCmd").addEventListener("click", async () => {
    const text = buildCommand(), btn = $("copyCmd");
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { /* fall back below */ }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
    }
    if (!ok) window.getSelection().selectAllChildren($("cmd"));  // let the user copy it by hand
    btn.textContent = ok ? "Copied!" : "Press Ctrl/⌘+C";
    setTimeout(() => { btn.textContent = "Copy command"; }, 1600);
  });

  $("resetOpts").addEventListener("click", () => {
    const sizeChanged = ["width", "height", "scale"].some(k => opts[k] !== GLOBAL_DEFAULTS[k]);
    resetOptions();
    Object.assign(gifOpts, GIF_DEFAULTS);
    syncGifControls();
    $("stopPainted").checked = stopWhenPainted = false;
    $("optNote").dataset.scaleNote = "";
    syncControls();
    if (sizeChanged) applySize(); else { renderText(); restart(); }
    updateNote();
    updateCommand();
  });

  $("styles").addEventListener("click", e => {
    const b = e.target.closest("button[data-style]");
    if (!b || b.dataset.style === style) return;
    style = b.dataset.style;
    for (const btn of $("styles").querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn === b));
    // like cover.py, each style starts from its own defaults for the style-specific options
    resetOptions(["particles", "alpha", "fade", "frames", "radius", "current", "zoom", "scrim"]);
    syncControls();
    renderText();                                                // halo depends on the style
    restart();
    updateCommand();
  });
  $("prev").addEventListener("click", () => setPattern(pattern - 1));
  $("next").addEventListener("click", () => setPattern(pattern + 1));
  $("pattern").addEventListener("change", e => setPattern(e.target.value));
  $("shuffle").addEventListener("click", () => {
    let v;
    do { v = 1 + Math.floor(Math.random() * 999); } while (v === pattern);
    setPattern(v);
  });
  $("play").addEventListener("click", () => setPlaying(!playing));
  $("repaint").addEventListener("click", () => { restart(); if (!playing) setPlaying(true); });
  for (const id of ["greeting", "name", "title"]) $(id).addEventListener("input", () => { renderText(); updateCommand(); });
  $("showText").addEventListener("change", e => { showText = e.target.checked; needsCompose = true; updateCommand(); });

  // ------------------------------------------------------------ downloads
  const fileStem = () => $("name").value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  $("download").addEventListener("click", () => {
    compose();
    canvas.toBlob(blob => { if (blob) saveBlob(blob, `${fileStem()}-cover.png`); }, "image/png");
  });

  // ------------------------------------------------------------ GIF export
  // Encoding uses gifenc (MIT, https://github.com/mattdesl/gifenc), loaded from
  // a CDN by the module script in index.html, which puts it on window.gifenc.
  // This file only produces the frames.

  // frame rate -> simulation steps per GIF frame, so the GIF plays at the same
  // speed as the live view (about 60 steps per second)
  const GIF_STEPS = { 15: 4, 20: 3, 30: 2 };

  // Records a looping GIF by stepping the simulation frame by frame (so it never
  // drops frames). The last half second is cross-faded into the first frames so
  // the loop has no visible jump.
  async function recordGif() {
    if (recording) return;
    const button = $("downloadGif");
    const lib = window.gifenc;
    if (!lib) {                                                  // CDN blocked or offline
      button.textContent = "GIF library didn't load (offline?)";
      setTimeout(() => { button.textContent = "Download GIF"; }, 3000);
      return;
    }
    const { GIFEncoder, quantize, applyPalette } = lib;
    const wasPlaying = playing;
    recording = true; recordPct = 0;
    document.querySelector("main").classList.add("recording");
    button.disabled = true;
    const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      while (sim.t < sim.p.frames) {                             // finish painting first
        for (let k = 0; k < 20 && sim.t < sim.p.frames; k++) step();
        await yieldToBrowser();
      }
      const steps = GIF_STEPS[gifOpts.fps], delay = Math.round(1000 / gifOpts.fps);
      const frames = Math.round(gifOpts.seconds * gifOpts.fps);
      const fadeFrames = Math.max(1, Math.min(Math.round(gifOpts.fps / 2), Math.floor(frames / 3)));
      const gw = Math.min(gifOpts.width, PW), gh = Math.max(1, Math.round(gw * H / W));
      // Shrink in halving steps (each one averages 2x2 pixels), which keeps the
      // thin strokes smooth in every browser; a single big jump can alias in some.
      const stages = [];
      for (let sw = PW, sh = PH; sw / 2 >= gw * 1.001; ) {
        sw = Math.round(sw / 2); sh = Math.round(sh / 2);
        stages.push(Object.assign(document.createElement("canvas"), { width: sw, height: sh }));
      }
      const small = Object.assign(document.createElement("canvas"), { width: gw, height: gh });
      const sctx = small.getContext("2d", { willReadFrequently: true });
      const shrink = (c, src) => {
        const cx = c.getContext("2d");
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = "high";
        cx.drawImage(src, 0, 0, c.width, c.height);
        return c;
      };
      const grab = () => {                                       // advance one GIF frame and read it back
        for (let k = 0; k < steps; k++) step();
        writePixels();
        compose();
        let src = canvas;
        for (const c of stages) src = shrink(c, src);
        shrink(small, src);
        return sctx.getImageData(0, 0, gw, gh).data;
      };

      const total = frames + fadeFrames;
      const head = [];                                           // first frames, kept for the loop fade
      for (let i = 0; i < fadeFrames; i++) {
        head.push(grab());
        recordPct = Math.floor((i + 1) / total * 100);
        await yieldToBrowser();
      }

      // One 256-colour palette for the whole GIF, built from the opening frames,
      // so colours stay steady from frame to frame.
      const sample = new Uint8ClampedArray(head.length * head[0].length);
      head.forEach((f, i) => sample.set(f, i * f.length));
      const palette = quantize(sample, 256, { format: "rgb565" });

      const gif = GIFEncoder();
      const blended = new Uint8ClampedArray(gw * gh * 4);
      for (let i = fadeFrames; i < total; i++) {
        let px = grab();
        if (i >= frames) {                                       // fade the tail into the opening frames
          const m = i - frames, w = (m + 1) / (fadeFrames + 1), first = head[m];
          for (let q = 0; q < px.length; q++) blended[q] = px[q] + (first[q] - px[q]) * w;
          px = blended;
        }
        const index = applyPalette(px, palette, "rgb565");
        gif.writeFrame(index, gw, gh, i === fadeFrames ? { palette, delay, repeat: 0 } : { delay });
        recordPct = Math.floor((i + 1) / total * 100);
        if (i % 2) await yieldToBrowser();
      }
      gif.finish();

      const blob = new Blob([gif.bytes()], { type: "image/gif" });
      saveBlob(blob, `${fileStem()}-cover.gif`);
      button.textContent = `Saved · ${(blob.size / 1048576).toFixed(1)} MB`;
      setTimeout(() => { button.textContent = "Download GIF"; }, 2500);
      window.flowCover.lastGif = { bytes: blob.size, frames, width: gw, height: gh };
    } finally {
      recording = false;
      document.querySelector("main").classList.remove("recording");
      button.disabled = false;
      setPlaying(wasPlaying);
    }
  }
  $("downloadGif").addEventListener("click", recordGif);

  // automation/testing hook: window.flowCover.state()
  window.flowCover = {
    state: () => ({ style, pattern, t: sim.t, warm: sim.p.frames, playing, opts: { ...opts }, size: [PW, PH],
                    gif: { ...gifOpts }, recording }),
    command: buildCommand,
    perlin,
  };

  // ------------------------------------------------------------ start
  resetOptions();
  buildControls();
  syncControls();
  syncGifControls();
  updateSpec();
  updateNote();
  ctx.fillStyle = `rgb(${BG.join(",")})`;
  ctx.fillRect(0, 0, PW, PH);
  newSim();
  updateCommand();
  const fontsReady = document.fonts
    ? Promise.all([document.fonts.load(`700 ${44 * S}px "Fira Code"`), document.fonts.load(`500 ${20 * S}px "Fira Code"`)]).catch(() => {})
    : Promise.resolve();
  fontsReady.then(() => { renderText(); requestAnimationFrame(loop); });
})();
