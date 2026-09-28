// 控制面板“画质与显示”折叠区：由 DISPLAY_SCHEMA 生成控件，双向同步 DisplaySettings
import { DISPLAY_SCHEMA } from './display.js';
import { QUALITY_LEVELS } from './config.js';

const OPEN_KEY = 'xian3d.display.open';

export function buildDisplayPanel(ui, display, { open } = {}) {
  const sec = document.createElement('details');
  sec.className = 'sec disp';
  let wasOpen = false;
  try { wasOpen = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  sec.open = open ?? wasOpen;
  sec.addEventListener('toggle', () => {
    try { localStorage.setItem(OPEN_KEY, sec.open ? '1' : '0'); } catch {}
  });

  let html = `<summary class="sec-h disp-h">画质与显示 <span class="disp-state"></span></summary><div class="disp-body">`;
  let inGroup = false;
  for (const d of DISPLAY_SCHEMA) {
    if (d.group) {
      if (inGroup) html += '</div>';
      html += `<div class="disp-group"><div class="disp-gh">${d.group}</div>`;
      inGroup = true;
      continue;
    }
    const id = `d-${d.key}`;
    if (d.type === 'bool') {
      html += `<label class="disp-row disp-bool" data-key="${d.key}"><input type="checkbox" class="${id}" /> ${d.label}</label>`;
    } else if (d.type === 'select') {
      html += `<label class="disp-row" data-key="${d.key}"><span>${d.label}</span><select class="${id}">${d.options.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>`;
    } else {
      html += `<div class="disp-row disp-range" data-key="${d.key}"><div class="disp-rl"><span>${d.label}</span><b class="${id}-v"></b></div><input type="range" class="${id}" min="${d.min}" max="${d.max}" step="${d.step}" /></div>`;
    }
  }
  if (inGroup) html += '</div>';
  html += `<div class="row disp-actions"><button class="disp-reset" title="把各细项恢复为当前预设档位">恢复预设</button></div></div>`;
  sec.innerHTML = html;

  const $ = (s) => sec.querySelector(s);
  const toSlider = (d, v) => (d.zeroAt != null && !v ? d.zeroAt : v);
  const fromSlider = (d, v) => (d.zeroAt != null && v >= d.zeroAt ? 0 : v);

  for (const d of DISPLAY_SCHEMA) {
    if (!d.key) continue;
    const el = $(`.d-${d.key}`);
    if (d.type === 'bool') el.addEventListener('change', () => display.set(d.key, el.checked));
    else if (d.type === 'select') el.addEventListener('change', () => display.set(d.key, d.num ? parseFloat(el.value) : el.value));
    else {
      const out = $(`.d-${d.key}-v`);
      // 拖动时只更新数字；松手（change）再应用，避免像素比/视距等拖动中反复重建
      el.addEventListener('input', () => { out.textContent = d.fmt(fromSlider(d, parseFloat(el.value))); });
      el.addEventListener('change', () => display.set(d.key, fromSlider(d, parseFloat(el.value))));
    }
  }
  $('.disp-reset').addEventListener('click', () => ui.emit('quality', display.base));

  const sync = () => {
    const v = display.values;
    for (const d of DISPLAY_SCHEMA) {
      if (!d.key) continue;
      const el = $(`.d-${d.key}`);
      if (d.type === 'bool') el.checked = !!v[d.key];
      else if (d.type === 'select') el.value = String(v[d.key]);
      else {
        if (!el.matches(':active')) el.value = toSlider(d, v[d.key]);
        $(`.d-${d.key}-v`).textContent = d.fmt(v[d.key]);
      }
      const row = el.closest('.disp-row');
      row.classList.toggle('disabled', !!d.dep && !v[d.dep]);
    }
    const pi = display.presetIndex;
    $('.disp-state').textContent = pi >= 0 ? `预设：${QUALITY_LEVELS[pi].name}` : `自定义（基于${QUALITY_LEVELS[display.base].name}）`;
    ui.setQualityActive(pi, pi < 0);
  };
  display.onChange(sync);
  sync();
  return { el: sec, sync };
}
