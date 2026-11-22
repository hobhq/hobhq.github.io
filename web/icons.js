// Hob HUD icon set: line icons drawn for the Ares theme.
// Each icon has one moving part (class a-*), animated in style.css.
// icon(name) returns inline SVG; unknown names fall back to Material Symbols.

const P = {
  // vault: chamfered safe, the dial turns
  vault: `<path d="M4 5h13l3 3v11H7l-3-3Z"/><path d="M20 10h1.5M20 15h1.5" /><g class="a-spin" style="transform-origin:12px 12.5px"><circle cx="12" cy="12.5" r="3.6"/><path d="M12 8.9v1.6M12 14.5v1.6M8.4 12.5H10M14 12.5h1.6"/></g>`,
  // mirror: three nodes, data flows between them
  mirror: `<circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="5.5" r="2.2"/><circle cx="19" cy="18.5" r="2.2"/><path class="a-flow" d="M7 11 17 6.4M7 13l10 4.6"/>`,
  // pip: angular AI head, the visor scans
  pip: `<path d="M12 2.5v3"/><path class="a-beacon" d="M11 2h2"/><path d="M5 7h14l2 2v8l-2 2H5l-2-2V9Z"/><path d="M6.5 11h11v3.5h-11Z" opacity=".55"/><path class="a-scan" d="M8 12.75h2.5M13.5 12.75H16"/><path d="M9.5 17h5"/>`,
  // enforce: shield, a scan line sweeps down
  enforce: `<path d="M12 2.5 20 5.5v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10v-6Z"/><path class="a-sweep" d="M6.5 8h11"/><path d="m8.8 12 2.2 2.2 4.4-4.4"/>`,
  // bolt: lightning, flickers like a live line
  bolt: `<path class="a-flicker" d="M13.5 2 5 13.5h6L10 22l9-12h-6l.5-8Z"/>`,
  // react: a ring that spins around a core
  react: `<circle cx="12" cy="12" r="2.4"/><g class="a-spin" style="transform-origin:12px 12px"><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/><path d="M12 20.5A8.5 8.5 0 0 1 3.5 12"/></g><path d="M20.5 12h1.5M2 12h1.5" opacity=".6"/>`,
  sync: `<g class="a-spin" style="transform-origin:12px 12px"><path d="M19.5 9A8 8 0 0 0 5 7.5"/><path d="M5 3.5v4h4"/><path d="M4.5 15A8 8 0 0 0 19 16.5"/><path d="M19 20.5v-4h-4"/></g>`,
  lock: `<path class="a-latch" d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M5 10.5h14v10H5Z"/><path class="a-blink" d="M12 14v3"/>`,
  unlock: `<path class="a-latch-open" d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/><path d="M5 10.5h14v10H5Z"/><path d="M12 14v3"/>`,
  warning: `<path d="M12 3 22 20.5H2Z"/><path class="a-blink" d="M12 9.5v5.5M12 17.5v.5"/>`,
  verified: `<path d="M12 2.5 20 5.5v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10v-6Z"/><path class="a-draw" d="m8.5 12 2.5 2.5 4.5-5"/>`,
  speed: `<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 8.5v1.5M6 11l1 1M18 11l-1 1" opacity=".6"/><path class="a-needle" style="transform-origin:12px 17px" d="M12 17 16 11.5"/><circle cx="12" cy="17" r="1.2"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5" /><path class="a-hand" style="transform-origin:12px 12px" d="M12 12h4"/>`,
  link: `<path d="M10 14 14 10"/><path d="M9 7.5 11 5.5a4 4 0 0 1 5.7 5.7l-2 2"/><path d="M15 16.5 13 18.5a4 4 0 0 1-5.7-5.7l2-2"/><path class="a-flow" d="M10 14 14 10"/>`,
  grid: `<path d="M3.5 3.5h7v7h-7ZM13.5 3.5h7v7h-7ZM3.5 13.5h7v7h-7Z"/><path class="a-blink" d="M13.5 13.5h7v7h-7Z"/>`,
  house: `<path d="M3 11 12 3.5 21 11"/><path d="M5.5 9.5V20.5h13V9.5"/><path class="a-scan" d="M9 14.5h2M13 14.5h2"/>`,
  story: `<path d="M4 4.5h6l2 2 2-2h6v14h-6l-2 2-2-2H4Z"/><path d="M12 6.5v14" opacity=".55"/><path class="a-type" d="M6.5 9h3M6.5 12h3M14.5 9h3M14.5 12h2"/>`,
  judge: `<path d="M12 3v17"/><g class="a-tilt" style="transform-origin:12px 7px"><path d="M5 7h14"/><path d="M5 7 2.5 13h5Z"/><path d="M19 7l-2.5 6h5Z"/></g><path d="M8 20.5h8"/>`,
  play: `<path class="a-flicker" d="M7 4.5v15L19.5 12Z"/>`,
  send: `<path d="M3 11.5 21 3.5l-6 17-3.5-7.5Z"/><path class="a-flow" d="M11.5 13 21 3.5"/>`,
  lab: `<path d="M9 3.5h6M10 3.5v6L4.5 19.5h15L14 9.5v-6"/><path class="a-bubble" d="M9.5 15.5h.5M13 16.5h.5M11.5 13.5h.5"/>`,
  block: `<circle cx="12" cy="12" r="8.5"/><path class="a-blink" d="m6 6 12 12"/>`,
  ledger: `<path d="M4 4.5h16v15H4Z"/><path d="M4 9h16" /><path class="a-type" d="M7 12.5h6M7 15.5h4M15.5 12.5h1.5M15.5 15.5h1.5"/>`,
  // flow: three entities, the links pulse between them
  flow: `<path d="M3 4h6v5H3ZM3 15h6v5H3Z"/><path d="M15 9.5h6v5h-6Z"/><path class="a-flow" d="M9 6.5c3 0 3 5.5 6 5.5M9 17.5c3 0 3-5.5 6-5.5"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle class="a-look" cx="12" cy="12" r="2.8"/>`,
};

const ALIAS = {
  account_balance_wallet: "vault", device_hub: "mirror", smart_toy: "pip", gavel: "judge", bolt: "bolt",
  sync: "sync", lock: "lock", lock_open: "unlock", warning: "warning", verified_user: "verified", verified: "verified",
  shield_with_heart: "verified", speed: "speed", schedule: "clock", link: "link", grid_view: "grid", chalet: "house",
  auto_stories: "story", play_arrow: "play", send: "send", science: "lab", block: "block", enforce: "enforce", react: "react",
  ledger: "ledger", eye: "eye",
};

export function icon(name, cls = "") {
  const key = ALIAS[name] ?? (P[name] ? name : null);
  if (!key) return `<span class="ms ${cls}">${name}</span>`;
  return `<svg class="ai ai-${key} ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">${P[key]}</svg>`;
}

// Static markup: <i data-i="pip"></i> becomes the icon.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("i[data-i]")) {
    el.outerHTML = icon(el.dataset.i, el.className);
  }
}
