// boot.js - startup load screen with the "typer" character reveal
// (ported from arlan.me/vault/typer). Each glyph ripples through a pool of
// randomized visual states (filled pill, inverse, accent, outlined pill...)
// before settling into plain text, then the overlay fades into the editor.
// Standalone on purpose: no imports from the app so it runs instantly.

const ALL_VARIATIONS = [
  "charFill",
  "charInverse",
  "charAccent",
  "charAccentInverse",
  "charAccentFill",
  "charBorder",
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// round v to the nearest multiple of step (quantizes per-char progress so a
// glyph holds each state for a beat instead of flickering every frame)
const roundToStep = (v, step) => Math.round(v / step) * step;

const remap = (v, inLo, inHi, outLo, outHi) =>
  ((v - inLo) * (outHi - outLo)) / (inHi - inLo) + outLo;

// cubic bezier easing y for a given x, endpoints (0,0)(1,1). Newton's method.
// Places each char's reveal "control point" along an eased curve so the
// ripple accelerates and settles instead of marching in a straight line.
function bezierEase(x, x1, y1, x2, y2, eps = 1e-6) {
  const bx = (t) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = (t) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  const bxDeriv = (t) =>
    3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2);
  let t = clamp(x, 0, 1);
  for (let i = 0; i < 8; i++) {
    const err = bx(t) - x;
    if (Math.abs(err) < eps) break;
    const d = bxDeriv(t);
    if (Math.abs(d) < 1e-6) break;
    t = clamp(t - err / d, 0, 1);
  }
  return by(t);
}

class Typer {
  constructor(element, opts = {}) {
    this.element = element;
    this.source = element.textContent;
    this.fps = opts.fps ?? 23;
    this.cycles = opts.cycles ?? 4;
    this.onDone = opts.onDone || null;
    this.loop = null;
    this.frame = 0;
    this.charNodes = [];

    this.length = this.source.replace(/\s/g, "").length;
    this.divisor = this.length > 1 ? this.length - 1 : 1;
    this.frames = this.length ? this.fps * (1 + this.length * 0.01) : 0;
    // the last char's control point sits at 1, and it needs local progress 1
    // on top of that to settle -> global progress must reach 2 by the end
    this.denominator = this.frames * 0.5 || 1;

    this.variations = [...ALL_VARIATIONS];
    this.shuffle();

    if (this.length) {
      this.build();
      this.element.dataset.typerType = "initial";
    }
  }

  // split into words (preserving whitespace) and wrap each char in a span.
  // Each char gets a bezier-eased control point from its position in the line.
  build() {
    this.element.innerHTML = "";
    this.charNodes = [];
    const parts = this.source.split(/(\s+)/);
    let i = 0;
    for (const part of parts) {
      if (part.trim() === "") {
        this.element.append(document.createTextNode(part));
        continue;
      }
      const word = document.createElement("span");
      word.className = "word";
      for (const ch of part.split("")) {
        const pos = i / this.divisor;
        const cp = roundToStep(bezierEase(pos, 0, 0.75, 0.75, 0), 0.05);
        const span = document.createElement("span");
        span.className = "char charInit";
        span.textContent = ch || " ";
        this.charNodes.push({ el: span, cp, currentClass: "char charInit" });
        i += 1;
        word.appendChild(span);
      }
      this.element.appendChild(word);
    }
  }

  in() {
    if (this.loop || !this.charNodes.length) return;
    this.element.dataset.typerType = "in";
    this.frame = 0;
    this.applyFrame();
    this.loop = window.setInterval(() => this.tick(), 1000 / this.fps);
  }

  tick() {
    this.frame = clamp(this.frame + 1, 0, this.frames);
    this.applyFrame();
    if (this.frame >= this.frames) {
      window.clearInterval(this.loop);
      this.loop = null;
      this.element.dataset.typerType = "done";
      if (this.onDone) this.onDone();
    }
  }

  applyFrame() {
    const progress = this.frame / this.denominator;
    for (const node of this.charNodes) {
      // this char's local progress = global progress minus its control point
      let p = clamp(roundToStep(progress - node.cp, 0.1), 0, 1);
      let cls;
      if (p <= 0) {
        cls = "char charInit";
      } else if (p >= 1) {
        cls = "char"; // settled -> plain char
      } else {
        // mid-reveal: roll through the shuffled state pool by cycle
        const idx = Math.round(remap(p, 0, 1, 0, this.cycles));
        cls = `char ${this.variations[idx % this.variations.length]}`;
      }
      if (cls !== node.currentClass) {
        node.currentClass = cls;
        node.el.className = cls;
      }
    }
  }

  shuffle() {
    this.variations.sort(() => 0.5 - Math.random());
  }
}

// -------------------- boot sequence --------------------

const overlay = document.getElementById("boot-overlay");
const title = document.getElementById("boot-title");

function dismiss() {
  overlay.classList.add("fade-out");
  setTimeout(() => overlay.remove(), 700);
}

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  // no reveal animation: show the title plainly, then fade in
  setTimeout(dismiss, 800);
} else {
  const typer = new Typer(title, {
    fps: 23,
    cycles: 4,
    onDone: () => setTimeout(dismiss, 500),
  });
  // wait for the display font so glyph widths don't shift mid-reveal
  const start = () => requestAnimationFrame(() => typer.in());
  const fontLoad = document.fonts?.load?.('600 48px "PP Neue Montreal"');
  if (fontLoad?.then) {
    let started = false;
    const once = () => {
      if (!started) {
        started = true;
        start();
      }
    };
    fontLoad.then(once, once);
    setTimeout(once, 400); // fallback if the font stalls
  } else {
    start();
  }
}
