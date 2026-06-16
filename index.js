/**
 * 取色歌词 v1.0.0
 * 已播放 = 封面主色，未播放 = 默认色；频谱律动 + 平滑过渡。
 * 关键约束：
 *  1. CSS 走 ctx.css.inject 并以 .echo-cover-color-* 命名空间，避免污染宿主。
 *  2. 桌面歌词颜色必须经 window.electron.desktopLyric.updateSettings。
 *  3. 频谱字段为 frame.bins / 订阅选项 binCount。
 *  4. ctx.player.currentTrack 为 ComputedRef，需 .value 解包。
 */
const K = "cover-color-lyric:settings:v1";
const C = { played: "#31cfa1", unplayed: "#7a7a7a" };
const D = { enabled: true, transitionMs: 600, spectrumPulse: true, pulseIntensity: 0.35 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const h2r = h => {
  if (typeof h !== "string") return [0, 0, 0];
  let s = h.trim().replace("#", "");
  if (s.length === 3) s = s.split("").map(c => c + c).join("");
  if (s.length !== 6 || /[^0-9a-f]/i.test(s)) return [0, 0, 0];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const r2h = (r, g, b) => "#" + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

const extractDominantColor = c => {
  const w = c.width, h = c.height;
  if (!w || !h) return null;
  let d; try { d = c.getContext("2d").getImageData(0, 0, w, h).data; } catch { return null; }
  const buckets = new Map();
  const BIN = 24;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < 125) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2 / 255;
    if (l < 0.12 || l > 0.94) continue;
    const dm = max - min;
    if (dm < 12) continue;
    const s = dm / 255;
    if (s < 0.18) continue;
    let hue;
    if (max === r) hue = ((g - b) / dm) % 6;
    else if (max === g) hue = (b - r) / dm + 2;
    else hue = (r - g) / dm + 4;
    hue = (hue * 60 + 360) % 360;
    const key = Math.floor(hue / BIN);
    const cur = buckets.get(key) || { sSum: 0, lSum: 0, count: 0, weight: 0 };
    cur.sSum += s; cur.lSum += l; cur.count++; cur.weight += s * s;
    buckets.set(key, cur);
  }
  if (!buckets.size) return null;
  let best = null, bestW = 0;
  for (const v of buckets.values()) if (v.weight > bestW) { bestW = v.weight; best = v; }
  if (!best || best.count < 3) return null;
  let domH = 0, dw = 0;
  for (const [k, v] of buckets) if (v.weight > dw) { dw = v.weight; domH = k * BIN + BIN / 2; }
  const avgS = best.sSum / best.count, avgL = best.lSum / best.count;
  const s2 = clamp(avgS, 0.25, 1), l2 = clamp(avgL, 0.2, 0.8);
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2, p = 2 * l2 - q;
  const hue2 = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const h3 = domH / 360;
  return r2h(hue2(h3 + 1 / 3) * 255, hue2(h3) * 255, hue2(h3 - 1 / 3) * 255);
};

const extractColorFromUrl = url => new Promise(resolve => {
  if (!url) return resolve(null);
  const img = new Image();
  img.crossOrigin = "anonymous";
  let done = false;
  const finish = v => { if (!done) { done = true; resolve(v); } };
  const timer = setTimeout(() => finish(null), 8000);
  img.onload = () => {
    clearTimeout(timer);
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, 64, 64);
      finish(extractDominantColor(c));
    } catch { finish(null); }
  };
  img.onerror = () => { clearTimeout(timer); finish(null); };
  try { img.src = url; } catch { clearTimeout(timer); finish(null); }
});

const buildPalette = main => main ? { played: main, unplayed: C.unplayed } : { ...C };

const pushColors = (played, unplayed) => {
  const d = window.electron?.desktopLyric;
  if (d?.updateSettings) { try { const r = d.updateSettings({ playedColor: played, unplayedColor: unplayed }); r?.catch?.(() => {}); return; } catch {} }
  try { const s = window.__pinia__?.state?.value?.desktopLyric?.settings; if (s) { s.playedColor = played; s.unplayedColor = unplayed; } } catch {}
};

const publishVars = (played, unplayed) => {
  try {
    let el = document.getElementById("cover-color-lyric-vars");
    if (!el) { el = document.createElement("style"); el.id = "cover-color-lyric-vars"; document.head.appendChild(el); }
    el.textContent = `:root{--ccl-played:${played};--ccl-unplayed:${unplayed};}`;
  } catch {}
};

const isHttpUrl = v => typeof v === "string" && /^https?:\/\//i.test(v);
const pickUrl = (o, k) => { if (!o || typeof o !== "object") return null; for (const x of k) { const v = o[x]; if (isHttpUrl(v)) return v; } return null; };

const findCoverUrl = ctx => {
  try {
    const t = ctx.player?.currentTrack?.value;
    if (t && typeof t === "object") {
      const u = pickUrl(t, ["coverUrl", "cover", "picUrl", "imgUrl", "pic", "image", "albumPic", "songPic"]);
      if (u) return u;
      if (t.album) { const u2 = pickUrl(t.album, ["coverUrl", "cover", "picUrl", "pic", "image"]); if (u2) return u2; }
      for (const k of Object.keys(t)) { const v = t[k], lk = k.toLowerCase(); if (isHttpUrl(v) && (lk.includes("cover") || lk.includes("img") || lk.includes("pic") || lk.includes("image"))) return v; }
    }
  } catch {}
  try {
    const np = ctx.stores?.nowPlaying || ctx.stores?.player;
    if (np) { const u = pickUrl(np, ["cover", "coverUrl", "picUrl", "imgUrl", "currentCover"]); if (u) return u; }
  } catch {}
  return null;
};

const findCoverUrlAsync = async ctx => {
  const s = findCoverUrl(ctx);
  if (s) return s;
  try {
    const snap = await ctx.nowPlaying?.getSnapshot?.();
    const pb = snap?.playback;
    if (pb) { const u = pickUrl(pb, ["cover", "coverUrl", "picUrl", "imgUrl", "pic", "image"]); if (u) return u; }
  } catch {}
  return null;
};

const lerp = (a, b, t) => { const [ar, ag, ab] = h2r(a), [br, bg, bb] = h2r(b); return r2h(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t); };
const animate = (from, to, ms, onUpd, onDone) => {
  if (!from || !to || ms <= 0) { onUpd(to); onDone?.(); return () => {}; }
  const start = performance.now();
  let raf;
  const step = now => {
    const t = clamp((now - start) / ms, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    onUpd(lerp(from, to, e));
    if (t < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
};

const CSS = `.echo-cover-color-panel{display:contents}
.echo-cover-color-panel .echo-cover-color-settings{display:grid;gap:14px;padding:4px 0 12px;color:var(--color-text-main,#f8fafc);font-size:13px}
.echo-cover-color-panel .echo-cover-color-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;border:1px solid var(--border-subtle,rgba(148,163,184,.18));border-radius:10px;background:var(--control-muted-bg,rgba(148,163,184,.08))}
.echo-cover-color-panel .echo-cover-color-row__copy{display:grid;gap:4px;flex:1;min-width:0}
.echo-cover-color-panel .echo-cover-color-row__title{font-size:13px;font-weight:750;line-height:1.3}
.echo-cover-color-panel .echo-cover-color-row__sub{font-size:11px;line-height:1.45;color:var(--color-text-secondary,rgba(148,163,184,.9))}
.echo-cover-color-panel .echo-cover-color-slider-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;font-size:12px;margin-top:6px}
.echo-cover-color-panel .echo-cover-color-slider-value{font-variant-numeric:tabular-nums;color:var(--color-text-secondary,rgba(148,163,184,.9));font-size:11px}
.echo-cover-color-panel .echo-cover-color-preview{margin-top:4px;padding:18px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);background:linear-gradient(135deg,rgba(0,0,0,.4),rgba(0,0,0,.7))}
.echo-cover-color-panel .echo-cover-color-preview__label{font-size:11px;color:var(--color-text-secondary,rgba(148,163,184,.9));letter-spacing:.5px;margin-bottom:8px}
.echo-cover-color-panel .echo-cover-color-preview__primary{font-size:20px;font-weight:800;line-height:1.3;text-shadow:0 2px 4px rgba(0,0,0,.4)}
.echo-cover-color-panel .echo-cover-color-preview__secondary{font-size:13px;margin-top:4px;opacity:.75}
.echo-cover-color-panel .echo-cover-color-section-title{margin:4px 0 0;font-size:12px;font-weight:800;color:var(--color-text-main,#f8fafc);letter-spacing:.4px}
.echo-cover-color-panel .echo-cover-color-section-sub{font-size:11px;color:var(--color-text-secondary,rgba(148,163,184,.9));margin:2px 0 8px}
.echo-cover-color-panel .echo-cover-color-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.echo-cover-color-panel .echo-cover-color-confirm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);z-index:9999}
.echo-cover-color-panel .echo-cover-color-confirm__box{background:var(--bg-elevated,#1e1e24);border:1px solid var(--border-subtle,rgba(148,163,184,.2));border-radius:10px;padding:20px;min-width:280px;max-width:420px;color:var(--color-text-main,#f8fafc);box-shadow:0 8px 32px rgba(0,0,0,.4)}
.echo-cover-color-panel .echo-cover-color-confirm__title{font-size:14px;font-weight:750;margin-bottom:8px}
.echo-cover-color-panel .echo-cover-color-confirm__msg{font-size:12px;line-height:1.6;color:var(--color-text-secondary,rgba(148,163,184,.9));margin-bottom:16px}
.echo-cover-color-panel .echo-cover-color-confirm__actions{display:flex;justify-content:flex-end;gap:8px}`;

let unsubSpec = null, cancelTrans = null, activeDis = null;

export async function activate(ctx) {
  let settings = { ...D };
  try { settings = { ...D, ...(await ctx.storage.get(K) || {}) }; } catch {}

  let lastUrl = null, palette = { ...C }, transitioning = false;
  const disposeCss = ctx.css.inject(CSS, { id: "cover-color-lyric-css" });

  if (settings.spectrumPulse && ctx.audio?.spectrum?.subscribe) {
    try {
      unsubSpec = ctx.audio.spectrum.subscribe({ fftSize: 256, smoothing: 0.6, fps: 24, binCount: 16 }, f => {
        if (transitioning) return;
        const bins = f?.bins;
        let e = 0;
        if (Array.isArray(bins) && bins.length) { let s = 0; for (const b of bins) s += Number(b) || 0; e = s / bins.length; }
        else if (typeof f?.rms === "number") e = f.rms;
        const k = 1 + clamp(e, 0, 1) * (settings.pulseIntensity || 0.35);
        const [r, g, b] = h2r(palette.played);
        publishVars(r2h(r * k, g * k, b * k), palette.unplayed);
      });
    } catch {}
  }

  const apply = async force => {
    if (!settings.enabled) return;
    const url = await findCoverUrlAsync(ctx);
    if (!url || (url === lastUrl && !force)) return;
    lastUrl = url;
    const main = await extractColorFromUrl(url);
    const p = buildPalette(main);
    const fp = palette.played;
    palette = p;
    transitioning = true;
    cancelTrans?.();
    cancelTrans = animate(fp, p.played, settings.transitionMs,
      m => publishVars(m, p.unplayed),
      () => { publishVars(p.played, p.unplayed); transitioning = false; cancelTrans = null; }
    );
    pushColors(p.played, p.unplayed);
  };

  ctx.events.onTrackChange(() => setTimeout(() => apply(true), 500));
  setTimeout(() => apply(true), 1000);

  try { ctx.shortcuts?.register?.("CommandOrControl+Shift+L", () => {
    settings.enabled = !settings.enabled;
    ctx.storage.set(K, settings).catch(() => {});
    try { ctx.toast?.info?.(settings.enabled ? "取色歌词 已启用" : "取色歌词 已停用"); } catch {}
    if (settings.enabled) apply(true);
  }); } catch {}
  try {
    ctx.commands?.register?.("cover-color-lyric.refresh", async () => apply(true), { title: "刷新封面取色" });
    ctx.commands?.register?.("cover-color-lyric.toggle", () => {
      settings.enabled = !settings.enabled;
      ctx.storage.set(K, settings).catch(() => {});
      if (settings.enabled) apply(true);
    }, { title: "切换取色歌词" });
  } catch {}

  const { h, reactive, ref, defineAsyncComponent, computed } = ctx.vue;
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Slider = defineAsyncComponent(ctx.ui.components.Slider);
  const Button = defineAsyncComponent(ctx.ui.components.Button);

  const confirm = (title, msg, onOk) => {
    const overlay = document.createElement("div");
    overlay.className = "echo-cover-color-confirm";
    overlay.innerHTML = `<div class="echo-cover-color-confirm__box"><div class="echo-cover-color-confirm__title">${title}</div><div class="echo-cover-color-confirm__msg">${msg}</div><div class="echo-cover-color-confirm__actions"></div></div>`;
    const actions = overlay.querySelector(".echo-cover-color-confirm__actions");
    const mkBtn = (txt, primary, fn) => {
      const b = document.createElement("button");
      b.textContent = txt;
      b.style.cssText = `padding:6px 14px;border-radius:6px;border:1px solid ${primary ? "var(--color-primary,#31cfa1)" : "var(--border-subtle,rgba(148,163,184,.3))"};background:${primary ? "color-mix(in srgb,var(--color-primary,#31cfa1) 18%,transparent)" : "transparent"};color:var(--color-text-main,#f8fafc);cursor:pointer;font-size:12px`;
      b.onclick = () => { overlay.remove(); fn?.(); };
      return b;
    };
    actions.appendChild(mkBtn("取消", false));
    actions.appendChild(mkBtn("确认恢复", true, onOk));
    document.body.appendChild(overlay);
  };

  const Panel = ctx.vue.defineComponent({
    name: "CoverColorLyricSettings",
    setup() {
      const draft = reactive(JSON.parse(JSON.stringify(settings)));
      const nonce = ref(0);
      const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
      const persist = debounce(async () => {
        settings = { ...settings, ...draft };
        try { await ctx.storage.set(K, settings); } catch {}
        nonce.value++;
        apply(true);
      }, 250);

      const live = computed(() => { void nonce.value; return palette; });

      const sec = (t, s) => h("div", null, [
        h("div", { class: "echo-cover-color-section-title" }, t),
        s ? h("div", { class: "echo-cover-color-section-sub" }, s) : null,
      ]);

      const sw = (key, label, sub) => h("div", { class: "echo-cover-color-row" }, [
        h("div", { class: "echo-cover-color-row__copy" }, [
          h("div", { class: "echo-cover-color-row__title" }, label),
          h("div", { class: "echo-cover-color-row__sub" }, sub),
        ]),
        h(Switch, { modelValue: draft[key], "onUpdate:modelValue": v => { draft[key] = v; persist(); } }),
      ]);

      const sl = (label, key, min, max, step, fmt) => h("div", { class: "echo-cover-color-row" }, [
        h("div", { class: "echo-cover-color-row__copy" }, [
          h("div", { class: "echo-cover-color-row__title" }, label),
          h("div", { class: "echo-cover-color-slider-row" }, [
            h(Slider, { modelValue: draft[key], min, max, step, "onUpdate:modelValue": v => { draft[key] = v; persist(); } }),
            h("span", { class: "echo-cover-color-slider-value" }, fmt ? fmt(draft[key]) : String(draft[key])),
          ]),
        ]),
      ]);

      const preview = () => h("div", { class: "echo-cover-color-preview" }, [
        h("div", { class: "echo-cover-color-preview__label" }, "预览"),
        h("div", {
          class: "echo-cover-color-preview__primary",
          style: `background:linear-gradient(90deg, ${live.value.played} 60%, ${live.value.unplayed} 60%);-webkit-background-clip:text;background-clip:text;color:transparent`,
        }, "这是一行示例歌词"),
        h("div", { class: "echo-cover-color-preview__secondary", style: `color:${live.value.unplayed}` }, "Translated lyrics line"),
      ]);

      const reset = () => {
        confirm("恢复默认设置", "将重置所有自定义设置（启用状态、律动、过渡时长等）到初始默认值，是否继续？", async () => {
          const fresh = { ...D };
          Object.keys(draft).forEach(k => delete draft[k]);
          Object.assign(draft, fresh);
          settings = { ...D };
          try { await ctx.storage.set(K, settings); } catch {}
          nonce.value++;
          await apply(true);
          try { ctx.toast?.info?.("已恢复默认设置"); } catch {}
        });
      };

      return () => h("div", { class: "echo-cover-color-panel" }, [
        h("div", { class: "echo-cover-color-settings" }, [
          sw("enabled", "取色歌词", "桌面歌词颜色自动跟随封面主色调"),
          preview(),
          sec("律动与过渡"),
          sw("spectrumPulse", "频谱律动", "播放时根据音量让歌词颜色轻微脉冲"),
          draft.spectrumPulse ? sl("律动强度", "pulseIntensity", 0, 1, 0.05, v => `${Math.round(v * 100)}%`) : null,
          sl("颜色过渡时长", "transitionMs", 0, 2000, 50, v => `${v}ms`),
          h("div", { class: "echo-cover-color-actions" }, [
            h(Button, { size: "xs", variant: "outline", onClick: reset }, { default: () => "恢复默认设置" }),
          ]),
        ]),
      ]);
    },
  });

  const settingsDis = ctx.ui.settings.define({ title: "取色歌词", description: "桌面歌词颜色自动跟随封面主色调", component: Panel });

  activeDis = ctx.dispose(() => {
    try { unsubSpec?.(); } catch {}
    try { cancelTrans?.(); } catch {}
    try { settingsDis?.(); } catch {}
    try { disposeCss?.(); } catch {}
    try { document.getElementById("cover-color-lyric-vars")?.remove(); } catch {}
  });
}

export async function deactivate(ctx) {
  try { unsubSpec?.(); } catch {} unsubSpec = null;
  try { cancelTrans?.(); } catch {} cancelTrans = null;
  try { activeDis?.(); } catch {} activeDis = null;
  try { if (typeof document !== "undefined") document.getElementById("cover-color-lyric-vars")?.remove(); } catch {}
}
