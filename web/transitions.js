// Tab transitions: one short Three.js scene per tab, played over the content while it swaps.
//   Dashboard  → command grid: three pylons (Base, Hob, Unichain) rise and link up
//   The House  → blueprint: Hob's house draws itself edge by edge, then we fly into the visor
//   The Story  → chapter tunnel: eight chapter frames, the camera dives through them
//   How it works → the map: six entities appear, their links draw in, packets of light run the loop
//   For Judges → verification: a laser scans a geodesic core, then a check mark burns in
// Three.js (vendor/three.module.min.js, r170) is loaded on the first tab change only.

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const META = {
  home: { n: "01", t: "Dashboard", s: "Live telemetry · Base ⟷ Hob ⟷ Unichain" },
  dash: { n: "02", t: "The House", s: "Rules · members · co-sign queue" },
  story: { n: "03", t: "The Story", s: "Eight chapters, every one on-chain" },
  flow: { n: "04", t: "How it works", s: "Every entity · every interaction" },
  hood: { n: "05", t: "For Judges", s: "Evidence · verified contracts · scenarios" },
};
const DUR = 1050; // scene time, ms
const OUT = 280; // dissolve, ms

let T = null; // three namespace
let loading = null;
let renderer = null;
let raf = 0;
let run = 0;
const scenes = {};

const ov = document.createElement("div");
ov.className = "tx-ov";
ov.setAttribute("aria-hidden", "true");
ov.innerHTML = `<canvas class="tx-cv"></canvas><div class="tx-vig"></div><div class="tx-hud"><span class="tx-k"></span><b class="tx-t"></b><span class="tx-s"></span><span class="tx-bar"><i></i></span></div>`;
const cv = ov.querySelector("canvas");

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = (x) => 1 - Math.pow(1 - x, 3);
const clamp = (x) => Math.min(1, Math.max(0, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));

function three() {
  if (T) return Promise.resolve(T);
  loading ??= import("./vendor/three.module.min.js").then((m) => (T = m));
  return loading;
}

function size() {
  const r = ov.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(w, h, false);
  for (const s of Object.values(scenes)) { s.camera.aspect = w / h; s.camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------- helpers
const RED = 0xff1e42, EMBER = 0xff3300, DIM = 0x5a0814, ICE = 0xffd6dc;
const lm = (color, opacity = 1) => new T.LineBasicMaterial({ color, transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false });
const mm = (color, opacity = 1) => new T.MeshBasicMaterial({ color, transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
function line(points, mat) {
  const g = new T.BufferGeometry().setFromPoints(points.map((p) => new T.Vector3(...p)));
  return new T.Line(g, mat);
}
function loop(points, mat) {
  const g = new T.BufferGeometry().setFromPoints(points.map((p) => new T.Vector3(...p)));
  return new T.LineLoop(g, mat);
}
function circle(r, n = 64) {
  return Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, 0, Math.sin((i / n) * Math.PI * 2) * r]);
}
function dust(n, spread, color = RED) {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) p[i] = (Math.random() - 0.5) * spread;
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(p, 3));
  return new T.Points(g, new T.PointsMaterial({ color, size: 0.08, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false }));
}
function label(text, w = 256, h = 128) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = "#ff1e42";
  x.font = `700 ${Math.round(h * 0.62)}px "Space Grotesk", "JetBrains Mono", monospace`;
  x.textAlign = "center"; x.textBaseline = "middle";
  x.shadowColor = "#ff1e42"; x.shadowBlur = 18;
  x.fillText(text, w / 2, h / 2);
  const tex = new T.CanvasTexture(c);
  const m = new T.Mesh(new T.PlaneGeometry(w / h, 1), new T.MeshBasicMaterial({ map: tex, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
  return m;
}
function base(fov = 50) {
  const scene = new T.Scene();
  scene.fog = new T.Fog(0x050507, 18, 70);
  const camera = new T.PerspectiveCamera(fov, 1, 0.1, 200);
  return { scene, camera };
}

// ---------------------------------------------------------------- Dashboard: command grid
function buildHome() {
  const { scene, camera } = base(48);
  const grid = new T.GridHelper(90, 45, RED, DIM);
  grid.material.transparent = true; grid.material.opacity = 0.55; grid.material.blending = T.AdditiveBlending;
  scene.add(grid);
  const towers = [[-9, 5, RED], [0, 8, EMBER], [9, 5, RED]].map(([x, h, c]) => {
    const g = new T.Group();
    const box = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(2.4, h, 2.4)), lm(c));
    box.position.y = h / 2;
    const core = new T.Mesh(new T.BoxGeometry(2.3, h, 2.3), mm(c, 0.07));
    core.position.y = h / 2;
    const ring = loop(circle(2.4), lm(c, 0.9));
    ring.position.y = h + 0.6;
    g.add(box, core, ring);
    g.position.x = x;
    g.scale.y = 0.001;
    scene.add(g);
    return { g, ring, h };
  });
  const beamMat = lm(ICE);
  const beams = [line([[-9, 5.6, 0], [-9, 5.6, 0]], beamMat), line([[9, 5.6, 0], [9, 5.6, 0]], beamMat)];
  beams.forEach((b) => scene.add(b));
  const cycles = Array.from({ length: 8 }, (_, i) => {
    const x = (i - 3.5) * 4;
    const l = line([[x, 0.05, 40], [x, 0.05, 40]], lm(i % 2 ? EMBER : RED));
    scene.add(l);
    return { l, x, d: 0.15 + Math.random() * 0.25 };
  });
  scene.add(dust(300, 80));
  return {
    scene, camera,
    update(t) {
      const c = ease(seg(t, 0, 0.9));
      camera.position.set(Math.sin(c * 0.6) * 6, 38 - c * 30, 34 - c * 12);
      camera.lookAt(0, 3 + c * 1.5, 0);
      towers.forEach((tw, i) => {
        tw.g.scale.y = Math.max(0.001, out(seg(t, 0.12 + i * 0.08, 0.55 + i * 0.08)));
        tw.ring.rotation.y = t * 6 + i;
      });
      const b = out(seg(t, 0.55, 0.85));
      for (const [k, bm] of beams.entries()) {
        const x0 = k === 0 ? -9 : 9;
        const p = bm.geometry.attributes.position;
        p.setXYZ(1, x0 + (0 - x0) * b, 5.6 + 2.4 * b, 0);
        p.needsUpdate = true;
      }
      for (const cy of cycles) {
        const z = 40 - out(seg(t, cy.d, cy.d + 0.6)) * 40;
        const p = cy.l.geometry.attributes.position;
        p.setXYZ(0, cy.x, 0.05, Math.min(40, z + 9));
        p.setXYZ(1, cy.x, 0.05, z);
        p.needsUpdate = true;
      }
    },
  };
}

// ---------------------------------------------------------------- The House: blueprint
function buildDash() {
  const { scene, camera } = base(45);
  const shape = new T.Shape();
  [[0, 5.2], [5.4, 1.2], [5.4, -4], [4.2, -5.2], [-4.2, -5.2], [-5.4, -4], [-5.4, 1.2]].forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const geo = new T.EdgesGeometry(new T.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false }));
  const house = new T.LineSegments(geo, lm(RED));
  const total = geo.attributes.position.count;
  house.position.z = -3;
  const g = new T.Group();
  g.add(house);
  // visor and eyes on the front face
  const visor = loop([[-3.6, -0.4, 3.05], [3.6, -0.4, 3.05], [3.6, -2, 3.05], [-3.6, -2, 3.05]], lm(EMBER));
  const eyes = new T.Group();
  for (const x of [-1.8, 1.8]) {
    const e = new T.Mesh(new T.PlaneGeometry(1.8, 0.55), mm(RED, 1));
    e.position.set(x, -1.2, 3.06);
    eyes.add(e);
  }
  const antenna = line([[2.8, 3.2, 0], [2.8, 6.4, 0]], lm(RED));
  const floor = new T.GridHelper(20, 20, DIM, DIM);
  floor.position.y = -5.25;
  floor.material.transparent = true; floor.material.opacity = 0.6;
  g.add(visor, eyes, antenna, floor);
  scene.add(g);
  scene.add(dust(260, 60));
  return {
    scene, camera,
    update(t) {
      const d = out(seg(t, 0, 0.55));
      geo.setDrawRange(0, Math.max(2, Math.floor((total * d) / 2) * 2));
      g.rotation.y = -1.1 + ease(seg(t, 0, 0.7)) * 1.1;
      g.rotation.x = 0.18 - ease(seg(t, 0, 0.7)) * 0.18;
      const on = seg(t, 0.5, 0.6);
      visor.material.opacity = on;
      antenna.material.opacity = on;
      eyes.children.forEach((e) => (e.material.opacity = on * (t > 0.78 && t < 0.82 ? 0.1 : 1)));
      eyes.scale.x = 1 + Math.sin(t * 30) * 0.03;
      const z = ease(seg(t, 0.68, 1));
      camera.position.set(0, -1.2 * z + 1.5 * (1 - z), 22 - z * 18.4);
      camera.lookAt(0, -1.2, 3);
    },
  };
}

// ---------------------------------------------------------------- The Story: chapter tunnel
function buildStory() {
  const { scene, camera } = base(60);
  scene.fog = new T.Fog(0x050507, 6, 40);
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const f = new T.Group();
    const w = 5, h = 3.2;
    f.add(loop([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], lm(i === 7 ? EMBER : RED)));
    f.add(line([[-w / 2 + 0.3, -h / 2 + 0.35, 0], [w / 2 - 0.3, -h / 2 + 0.35, 0]], lm(DIM)));
    const n = label(String(i + 1).padStart(2, "0"));
    n.scale.setScalar(1.5);
    f.add(n);
    const a = i * 0.85;
    f.position.set(Math.sin(a) * 3.2, Math.cos(a) * 1.6, -i * 7);
    f.rotation.z = Math.sin(a) * 0.12;
    scene.add(f);
    frames.push(f);
  }
  const rings = [];
  for (let i = 0; i < 26; i++) {
    const r = loop(circle(8, 6), lm(i % 3 ? DIM : RED, 0.8));
    r.rotation.x = Math.PI / 2;
    r.rotation.z = (i * Math.PI) / 18;
    r.position.z = 6 - i * 2.4;
    scene.add(r);
    rings.push(r);
  }
  scene.add(dust(400, 50));
  const end = frames[7].position;
  return {
    scene, camera,
    update(t) {
      const c = ease(seg(t, 0, 0.92));
      const z = 10 + (end.z + 5 - 10) * c;
      camera.position.set(end.x * c * c, end.y * c * c, z);
      camera.lookAt(end.x * c, end.y * c, z - 8);
      camera.rotation.z += Math.sin(c * Math.PI) * 0.25;
      rings.forEach((r, i) => (r.rotation.z = (i * Math.PI) / 18 + t * 2));
      frames.forEach((f, i) => (f.children[0].material.opacity = 0.4 + 0.6 * clamp(1 - Math.abs(f.position.z - (z - 5)) / 8)));
    },
  };
}

// ---------------------------------------------------------------- For Judges: verification scan
function buildHood() {
  const { scene, camera } = base(45);
  const geo = new T.EdgesGeometry(new T.IcosahedronGeometry(4.2, 1));
  const dim = new T.LineSegments(geo, lm(DIM));
  const plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
  const brightMat = lm(RED);
  brightMat.clippingPlanes = [plane];
  const bright = new T.LineSegments(geo, brightMat);
  const core = new T.Mesh(new T.IcosahedronGeometry(1.4, 0), mm(EMBER, 0.25));
  const coreEdges = new T.LineSegments(new T.EdgesGeometry(new T.IcosahedronGeometry(1.4, 0)), lm(EMBER));
  const g = new T.Group();
  g.add(dim, bright, core, coreEdges);
  scene.add(g);
  const laser = new T.Group();
  laser.add(loop(circle(6.2, 96), lm(ICE)));
  const disc = new T.Mesh(new T.CircleGeometry(6.2, 64), mm(RED, 0.12));
  disc.rotation.x = -Math.PI / 2;
  laser.add(disc);
  scene.add(laser);
  // the check mark: two glowing bars that grow from their start point
  const check = new T.Group();
  const bar = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const pivot = new T.Group();
    pivot.position.set(x0, y0, 6);
    pivot.rotation.z = Math.atan2(y1 - y0, x1 - x0);
    const m = new T.Mesh(new T.BoxGeometry(len, 0.15, 0.06), mm(ICE, 1));
    m.position.x = len / 2;
    const glow = new T.Mesh(new T.BoxGeometry(len, 0.42, 0.04), mm(EMBER, 0.3));
    glow.position.x = len / 2;
    pivot.add(glow, m);
    check.add(pivot);
    return pivot;
  };
  const b1 = bar(-2.4, 0.1, -0.6, -1.7), b2 = bar(-0.75, -1.65, 2.8, 1.9);
  scene.add(check);
  const ticks = new T.Group();
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ticks.add(line([[Math.cos(a) * 7, Math.sin(a) * 7, 0], [Math.cos(a) * (i % 3 ? 7.4 : 7.9), Math.sin(a) * (i % 3 ? 7.4 : 7.9), 0]], lm(i % 3 ? DIM : RED)));
  }
  scene.add(ticks);
  scene.add(dust(220, 50));
  camera.position.set(0, 0.5, 17);
  camera.lookAt(0, 0, 0);
  return {
    scene, camera, clip: true,
    update(t) {
      g.rotation.y = t * 2.2;
      g.rotation.x = 0.3 + t * 0.4;
      core.rotation.y = coreEdges.rotation.y = -t * 5;
      ticks.rotation.z = -t * 1.5;
      const y = 6 - ease(seg(t, 0.05, 0.65)) * 12;
      laser.position.y = y;
      laser.visible = t < 0.68;
      plane.constant = -y;
      const k = seg(t, 0.64, 0.88);
      b1.scale.x = Math.max(0.001, out(clamp(k * 2.2)));
      b2.scale.x = Math.max(0.001, out(clamp(k * 2 - 0.9)));
      b2.visible = k > 0.45;
      check.visible = k > 0;
      brightMat.color.setHex(t > 0.88 && t < 0.92 ? 0xffffff : RED);
      camera.position.z = 17 - ease(seg(t, 0.6, 1)) * 3;
    },
  };
}

// ---------------------------------------------------------------- How it works: the map assembles
function buildFlow() {
  const { scene, camera } = base(48);
  const P = { alice: [-7, 3.2, 0], bob: [-7, 0, 0], pip: [-7, -3.2, 0], base: [0, 2.6, 0], uni: [0, -2.6, 0], hob: [7, 0, 0] };
  const nodes = {};
  for (const [k, p] of Object.entries(P)) {
    const r = k === "hob" ? 1.25 : 0.7;
    const color = k === "pip" ? 0xff7a1a : k === "hob" ? RED : k === "base" || k === "uni" ? EMBER : ICE;
    const g = new T.Group();
    g.add(new T.LineSegments(new T.EdgesGeometry(new T.OctahedronGeometry(r, 0)), lm(color)));
    g.add(new T.Mesh(new T.OctahedronGeometry(r * 0.55, 0), mm(color, 0.35)));
    g.add(loop(circle(r * 1.5, 48).map(([x, , z]) => [x, z, 0]), lm(color, 0.5)));
    g.position.set(...p);
    scene.add(g);
    nodes[k] = g;
  }
  const pairs = [["alice", "base"], ["bob", "base"], ["pip", "base"], ["alice", "uni"], ["bob", "uni"], ["pip", "uni"], ["base", "hob"], ["uni", "hob"]];
  const curves = pairs.map(([a, b]) => {
    const A = new T.Vector3(...P[a]), B = new T.Vector3(...P[b]);
    const m = A.clone().lerp(B, 0.5); m.z += 1.2;
    return new T.QuadraticBezierCurve3(A, m, B);
  });
  const wires = curves.map((c, i) => {
    const geo = new T.BufferGeometry().setFromPoints(c.getPoints(60));
    geo.setDrawRange(0, 0);
    const w = new T.Line(geo, lm(i >= 6 ? RED : DIM, i >= 6 ? 1 : 0.9));
    scene.add(w);
    return w;
  });
  // callbacks: Hob back to both vaults, arcing the other way
  const back = [["hob", "base"], ["hob", "uni"]].map(([a, b]) => {
    const A = new T.Vector3(...P[a]), B = new T.Vector3(...P[b]);
    const m = A.clone().lerp(B, 0.5); m.z -= 1.6; m.y += a === "hob" && b === "base" ? 0.8 : -0.8;
    const c = new T.QuadraticBezierCurve3(A, m, B);
    const geo = new T.BufferGeometry().setFromPoints(c.getPoints(60));
    geo.setDrawRange(0, 0);
    const w = new T.Line(geo, lm(EMBER));
    scene.add(w);
    return { c, w };
  });
  const packet = (color) => { const m = new T.Mesh(new T.SphereGeometry(0.16, 12, 12), mm(color, 1)); scene.add(m); return m; };
  const pk = [packet(0xffb020), packet(RED), packet(EMBER), packet(EMBER)];
  scene.add(dust(200, 46));
  camera.position.set(0, -3, 19);
  camera.lookAt(0, 0, 0);
  return {
    scene, camera,
    update(t) {
      let i = 0;
      for (const g of Object.values(nodes)) {
        const k = out(seg(t, 0.02 + i * 0.05, 0.3 + i * 0.05));
        g.scale.setScalar(Math.max(0.001, k));
        g.rotation.y = t * 3 + i;
        i++;
      }
      wires.forEach((w, j) => w.geometry.setDrawRange(0, Math.floor(61 * ease(seg(t, 0.25 + j * 0.03, 0.55 + j * 0.03)))));
      back.forEach(({ w }, j) => w.geometry.setDrawRange(0, Math.floor(61 * ease(seg(t, 0.62 + j * 0.04, 0.85)))));
      // one loop: Pip spends on Unichain → Hob → callbacks to both vaults
      const a = seg(t, 0.45, 0.62), b = seg(t, 0.6, 0.74), c = seg(t, 0.74, 0.95);
      pk[0].visible = a > 0 && a < 1; pk[0].position.copy(curves[5].getPoint(ease(a)));
      pk[1].visible = b > 0 && b < 1; pk[1].position.copy(curves[7].getPoint(ease(b)));
      pk[2].visible = pk[3].visible = c > 0 && c < 1;
      pk[2].position.copy(back[0].c.getPoint(ease(c))); pk[3].position.copy(back[1].c.getPoint(ease(c)));
      nodes.hob.scale.setScalar(Math.max(0.001, out(seg(t, 0.27, 0.55))) * (1 + 0.35 * Math.sin(Math.PI * seg(t, 0.72, 0.8))));
      camera.position.set(Math.sin(t * 0.8) * 3, -3 + t * 2.5, 19 - ease(t) * 3.5);
      camera.lookAt(0, 0, 0);
    },
  };
}

const BUILD = { home: buildHome, dash: buildDash, story: buildStory, flow: buildFlow, hood: buildHood };

// ---------------------------------------------------------------- play
function hud(tab) {
  const m = META[tab];
  ov.querySelector(".tx-k").textContent = `// SEC_LOAD // ${m.n}`;
  ov.querySelector(".tx-t").textContent = m.t;
  ov.querySelector(".tx-t").dataset.text = m.t;
  ov.querySelector(".tx-s").textContent = m.s;
  ov.dataset.tab = tab;
}

export async function play(tab) {
  if (reduce || !META[tab]) return;
  const me = ++run;
  cancelAnimationFrame(raf);
  if (!ov.isConnected) document.body.appendChild(ov);
  hud(tab);
  ov.classList.remove("out", "live");
  void ov.offsetWidth; // restart the CSS animations
  ov.classList.add("on");
  try {
    await three();
  } catch {
    // no WebGL module: the HUD card alone still plays
  }
  if (me !== run) return;
  if (T && !renderer) {
    try {
      renderer = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setClearColor(0x050507, 0);
      renderer.localClippingEnabled = true;
    } catch {
      renderer = false;
    }
  }
  let s = null;
  if (renderer) {
    s = scenes[tab] ??= BUILD[tab]();
    size();
    ov.classList.add("live");
  }
  const t0 = performance.now();
  const frame = (now) => {
    if (me !== run) return;
    const t = clamp((now - t0) / DUR);
    if (s) { s.update(t); renderer.render(s.scene, s.camera); }
    if (t < 1) raf = requestAnimationFrame(frame);
    else {
      ov.classList.add("out");
      setTimeout(() => { if (me === run) ov.classList.remove("on", "out", "live"); }, OUT);
    }
  };
  raf = requestAnimationFrame(frame);
}

// ?txdebug: render one frame of a scene at a fixed time (used to check the scenes, never in normal use)
if (location.search.includes("txdebug")) {
  window.__txFrame = async (tab, t) => {
    run++;
    cancelAnimationFrame(raf);
    if (!ov.isConnected) document.body.appendChild(ov);
    hud(tab);
    ov.classList.add("on", "live");
    await three();
    renderer ||= new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.localClippingEnabled = true;
    const s = (scenes[tab] ??= BUILD[tab]());
    size();
    s.update(t);
    renderer.render(s.scene, s.camera);
  };
}

addEventListener("resize", () => { if (renderer && ov.classList.contains("on")) size(); });
document.addEventListener("hob:tab", (e) => play(e.detail));
