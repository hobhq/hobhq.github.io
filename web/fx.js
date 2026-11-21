// Ares HUD effects: boot overlay, perspective light-grid with light trails,
// scan-in of panels as they appear. Decorative only; the page works without it.
import { hydrateIcons } from "./icons.js";

hydrateIcons();
const root = document.documentElement;
root.classList.add("fx");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- boot overlay (once per session)
(() => {
  let seen = false;
  try { seen = sessionStorage.getItem("hob-boot") === "1"; sessionStorage.setItem("hob-boot", "1"); } catch { /* private mode */ }
  if (seen || reduce) return;
  const b = document.createElement("div");
  b.className = "boot";
  b.setAttribute("aria-hidden", "true");
  b.innerHTML = `<div class="boot-in"><span class="boot-k">// HOB · REACTIVE GUARDIAN</span><b class="boot-t">ONLINE</b><span class="boot-bar"><i></i></span><span class="boot-s">BASE ⟷ LASNA ⟷ UNICHAIN</span></div>`;
  document.body.appendChild(b);
  setTimeout(() => b.classList.add("out"), 1100);
  setTimeout(() => b.remove(), 1700);
})();

// ---------------------------------------------------------------- scan-in panels
const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) {
    e.target.classList.add("scan-in");
    io.unobserve(e.target);
  }
}, { rootMargin: "0px 0px -6% 0px" }) : null;
function watch() {
  if (!io || reduce) return;
  for (const el of document.querySelectorAll(".glass-card, .node, .duty-c, .person")) {
    if (el.dataset.fx) continue;
    el.dataset.fx = "1";
    io.observe(el);
  }
}
watch();
new MutationObserver(() => watch()).observe(document.querySelector(".main"), { childList: true, subtree: true });

// ---------------------------------------------------------------- light grid
const cv = document.createElement("canvas");
cv.id = "fx-bg";
cv.setAttribute("aria-hidden", "true");
document.body.prepend(cv);
const g = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
function size() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
}
size();
addEventListener("resize", () => { size(); if (reduce) draw(0); });

const RAYS = 13;
const trails = Array.from({ length: 5 }, (_, i) => spawn(i * 0.23));
function spawn(u = 0) {
  return { ray: Math.floor(Math.random() * RAYS) - (RAYS >> 1), u, speed: 0.05 + Math.random() * 0.07, hue: Math.random() < 0.75 ? "255,30,66" : "255,80,20" };
}
const ease = (u) => Math.pow(u, 2.1);

function draw(t) {
  g.clearRect(0, 0, W, H);
  const railW = W > 1180 ? 256 : 0;
  const vx = railW + (W - railW) / 2;
  const hy = H * 0.6;
  const floorH = H - hy;
  const spread = (W - railW) * 0.16;

  // horizon glow
  const hg = g.createLinearGradient(0, hy - 60, 0, hy + 40);
  hg.addColorStop(0, "rgba(255,30,66,0)");
  hg.addColorStop(0.6, "rgba(255,30,66,0.10)");
  hg.addColorStop(1, "rgba(255,30,66,0)");
  g.fillStyle = hg;
  g.fillRect(railW, hy - 60, W - railW, 100);
  g.strokeStyle = "rgba(255,30,66,0.35)";
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(railW, hy); g.lineTo(W, hy); g.stroke();

  // rays toward the vanishing point
  for (let i = -RAYS; i <= RAYS; i++) {
    const xb = vx + i * spread;
    const grad = g.createLinearGradient(0, hy, 0, H);
    grad.addColorStop(0, "rgba(255,30,66,0)");
    grad.addColorStop(1, "rgba(255,30,66,0.16)");
    g.strokeStyle = grad;
    g.beginPath(); g.moveTo(vx, hy); g.lineTo(xb, H); g.stroke();
  }
  // rows rolling toward the viewer
  const phase = (t / 9000) % 1;
  for (let k = 0; k < 18; k++) {
    const u = (k + phase) / 18;
    const y = hy + floorH * ease(u);
    g.strokeStyle = `rgba(255,30,66,${(0.02 + u * 0.16).toFixed(3)})`;
    g.beginPath(); g.moveTo(railW, y); g.lineTo(W, y); g.stroke();
  }

  // light trails riding the rays
  g.lineCap = "round";
  for (const tr of trails) {
    const at = (u) => {
      const e = ease(Math.min(Math.max(u, 0), 1));
      return [vx + tr.ray * spread * e, hy + floorH * e];
    };
    const head = tr.u, tail = Math.max(0, tr.u - 0.22);
    const [x1, y1] = at(tail), [x2, y2] = at(head);
    const lg = g.createLinearGradient(x1, y1, x2, y2);
    lg.addColorStop(0, `rgba(${tr.hue},0)`);
    lg.addColorStop(1, `rgba(${tr.hue},0.95)`);
    g.strokeStyle = lg;
    g.lineWidth = 1 + ease(head) * 2.5;
    g.shadowColor = `rgba(${tr.hue},0.9)`;
    g.shadowBlur = 12;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.shadowBlur = 0;
  }
  g.lineWidth = 1;
}

let last = 0, prev = 0, raf = 0;
function frame(t) {
  raf = requestAnimationFrame(frame);
  if (t - last < 33) return; // ~30 fps is plenty for a backdrop
  const dt = Math.min(0.1, (t - (prev || t)) / 1000);
  prev = t; last = t;
  for (const tr of trails) {
    tr.u += tr.speed * dt * 2.2;
    if (tr.u > 1.25) Object.assign(tr, spawn(0));
  }
  draw(t);
}
if (reduce) draw(0);
else {
  raf = requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { prev = 0; raf = requestAnimationFrame(frame); }
  });
}
