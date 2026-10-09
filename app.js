import { parseRecords, toPoints, analyzeGroup, synthetic } from './calib.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const num = (v, d = 3) => (v == null ? '—' : v.toFixed(d));

let last = null;

function exampleText() {
  const a = synthetic('calibrated', 2000, 11).map((r) => ({ model: 'calibrated (synthetic)', ...r }));
  const b = synthetic('overconfident', 2000, 23).map((r) => ({ model: 'overconfident (synthetic)', ...r }));
  return 'model,confidence,correct\n' + [...a, ...b].map((r) => `${r.model},${r.confidence},${r.correct}`).join('\n');
}

function settings() {
  return {
    target: Math.min(0.9999, Math.max(0.5, Number($('targetNum').value) / 100)),
    bins: Number($('bins').value),
    conservative: $('conservative').checked,
  };
}

function run() {
  $('error').textContent = '';
  const text = $('input').value;
  if (!text.trim()) { last = null; renderEmpty(); return; }
  let parsed;
  try {
    parsed = toPoints(parseRecords(text));
  } catch (e) {
    last = null;
    $('error').textContent = e.message;
    renderEmpty();
    return;
  }
  const s = settings();
  const results = [...parsed.groups].slice(0, 4).map(([name, pts], i) => ({ name, color: COLORS[i], r: analyzeGroup(pts, s) })).filter((x) => x.r);
  const m = parsed.mapping;
  const using = [`confidence ← <code>${esc(m.confidence)}</code>${m.percent ? ' (0–100 → 0–1)' : ''}`,
    m.correct ? `correct ← <code>${esc(m.correct)}</code>` : `correct ← <code>${esc(m.prediction)}</code> = <code>${esc(m.label)}</code>`,
    m.model ? `model ← <code>${esc(m.model)}</code>` : null].filter(Boolean).join(' · ');
  $('mapping').innerHTML = using + (parsed.skipped ? ` · skipped ${parsed.skipped} unreadable rows` : '') + (parsed.groups.size > 4 ? ' · showing first 4 models' : '');
  last = { results, s };
  renderCards(results, s);
  renderCurve(results, s);
  renderReliability(results);
}

function renderEmpty() {
  $('cards').innerHTML = '<div class="card empty">Paste data or load the example.</div>';
  $('curve').innerHTML = ''; $('rel').innerHTML = ''; $('legend1').innerHTML = ''; $('legend2').innerHTML = '';
}

function renderCards(results, s) {
  $('cards').innerHTML = results.map(({ name, color, r }) => {
    const p = r.pick;
    const t = r.split.test;
    let flag = '';
    if (!p) flag = `<div class="flag warn">No threshold reaches ${pct(s.target)} on this data. Even the most confident items fall short.</div>`;
    else if (t && t.acc != null && t.acc < s.target) flag = `<div class="flag warn">On held-out data, accuracy above this threshold was ${pct(t.acc)}, under the target. Collect more data or raise the threshold.</div>`;
    else if (t && t.acc != null && t.coverage < 0.6 * p.coverage) flag = `<div class="flag warn">Tuned on all items, the threshold clears ${pct(p.coverage, 0)} of traffic. Tuned on half and checked on the other half, it clears ${pct(t.coverage, 0)}. That gap means the threshold is fitted to this sample, so plan for the lower number.</div>`;
    else if (t && t.acc != null) flag = `<div class="flag good">Held out: ${pct(t.acc)} accuracy at ${pct(t.coverage, 0)} coverage. The threshold holds up.</div>`;
    if (r.n < 200) flag += `<div class="flag warn">Only ${r.n} items. Thresholds this close to 100% need hundreds of examples to be stable.</div>`;
    return `<div class="model">
      <div class="name"><span class="sw" style="background:${color}"></span>${esc(name)}</div>
      <div class="headline">${p ? pct(p.coverage, 0) : '0%'}</div>
      <div class="sub">of traffic auto-handled at ≥ ${pct(s.target)} accuracy${s.conservative ? ' (lower bound)' : ''}</div>
      <div class="kv">
        <span>threshold</span><span>${p ? 'conf ≥ ' + num(p.threshold, 3) : '—'}</span>
        <span>accuracy above it</span><span>${p ? pct(p.acc) : '—'}</span>
        <span>held-out accuracy / coverage</span><span>${t && t.acc != null ? pct(t.acc) + ' / ' + pct(t.coverage, 0) : '—'}</span>
        <span>items · overall accuracy</span><span>${r.n} · ${pct(r.acc)}</span>
        <span>mean confidence</span><span>${pct(r.meanConf)}</span>
        <span>ECE · MCE</span><span>${num(r.ece)} · ${num(r.mce)}</span>
        <span>Brier · AUROC</span><span>${num(r.brier)} · ${num(r.auroc)}</span>
      </div>${flag}
    </div>`;
  }).join('');
}

const W = 460, H = 300, M = { l: 44, r: 14, t: 12, b: 36 };
const X = (v) => M.l + v * (W - M.l - M.r);
const Y = (v, lo = 0) => M.t + (1 - (v - lo) / (1 - lo)) * (H - M.t - M.b);

function axes(ylo, xlabel, ylabel) {
  let g = '';
  for (let i = 0; i <= 5; i++) {
    const v = i / 5;
    const yv = ylo + (1 - ylo) * v;
    g += `<line x1="${X(0)}" x2="${X(1)}" y1="${Y(yv, ylo)}" y2="${Y(yv, ylo)}" stroke="var(--grid)"/>`;
    g += `<text x="${M.l - 6}" y="${Y(yv, ylo) + 4}" text-anchor="end">${Math.round(yv * 100)}%</text>`;
    g += `<text x="${X(v)}" y="${H - M.b + 16}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }
  g += `<text x="${(X(0) + X(1)) / 2}" y="${H - 4}" text-anchor="middle">${xlabel}</text>`;
  g += `<text transform="translate(11 ${(Y(1, ylo) + Y(ylo, ylo)) / 2}) rotate(-90)" text-anchor="middle">${ylabel}</text>`;
  return g;
}

function legend(id, results, extra = '') {
  $(id).innerHTML = results.map(({ name, color }) => `<span><span class="sw" style="background:${color}"></span> ${esc(name)}</span>`).join('') + extra;
}

function renderCurve(results, s) {
  const lows = results.flatMap(({ r }) => r.curve.map((p) => p.acc));
  const ylo = Math.max(0, Math.min(0.8, Math.floor((Math.min(...lows, s.target) - 0.02) * 10) / 10));
  let g = axes(ylo, 'coverage (share of items auto-handled)', 'accuracy of handled items');
  g += `<line x1="${X(0)}" x2="${X(1)}" y1="${Y(s.target, ylo)}" y2="${Y(s.target, ylo)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
  g += `<text x="${X(1) - 2}" y="${Y(s.target, ylo) - 5}" text-anchor="end">target ${pct(s.target)}</text>`;
  for (const { color, r } of results) {
    const pts = [{ coverage: 0, acc: r.curve[0]?.acc ?? 1 }, ...r.curve];
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.coverage).toFixed(1)},${Y(Math.max(ylo, p.acc), ylo).toFixed(1)}`).join('');
    g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
    if (r.pick) {
      g += `<line x1="${X(r.pick.coverage)}" x2="${X(r.pick.coverage)}" y1="${Y(s.target, ylo)}" y2="${Y(ylo, ylo)}" stroke="${color}" stroke-dasharray="2 3"/>`;
      g += `<circle cx="${X(r.pick.coverage)}" cy="${Y(Math.max(ylo, r.pick.acc), ylo)}" r="4.5" fill="${color}" stroke="var(--panel)" stroke-width="1.5"/>`;
    }
  }
  $('curve').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Accuracy versus coverage">${g}</svg>`;
  legend('legend1', results, '<span>· dot = chosen threshold</span>');
}

function renderReliability(results) {
  let g = axes(0, 'stated confidence', 'actual accuracy');
  g += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
  for (const { color, r } of results) {
    const bins = r.rel.filter((b) => b.n > 0);
    const maxN = Math.max(...bins.map((b) => b.n));
    // Bins with very few items are shown as dots but kept off the line.
    const minN = Math.max(5, Math.ceil(r.n * 0.005));
    const d = bins.filter((b) => b.n >= minN).map((b, i) => `${i ? 'L' : 'M'}${X(b.conf).toFixed(1)},${Y(b.acc).toFixed(1)}`).join('');
    g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
    for (const b of bins) {
      g += `<circle cx="${X(b.conf)}" cy="${Y(b.acc)}" r="${(2.5 + 4 * Math.sqrt(b.n / maxN)).toFixed(1)}" fill="${color}" fill-opacity=".85" stroke="var(--panel)"><title>${pct(b.lo, 0)}–${pct(b.hi, 0)}: ${b.n} items, said ${pct(b.conf)}, right ${pct(b.acc)}</title></circle>`;
    }
  }
  $('rel').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reliability diagram">${g}</svg>`;
  legend('legend2', results, '<span>· dashed = perfectly calibrated · dot size = items</span>');
}

function markdown() {
  if (!last) return '';
  const { results, s } = last;
  const L = [`Target accuracy ${pct(s.target)}${s.conservative ? ' (95% lower bound)' : ''}`, '',
    '| Model | Items | Auto-handled | Threshold | Acc. above | Held-out acc. / cov. | ECE | Brier | AUROC |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const { name, r } of results) {
    const p = r.pick, t = r.split.test;
    L.push(`| ${name} | ${r.n} | ${p ? pct(p.coverage, 0) : '0%'} | ${p ? num(p.threshold) : '—'} | ${p ? pct(p.acc) : '—'} | ${t && t.acc != null ? pct(t.acc) + ' / ' + pct(t.coverage, 0) : '—'} | ${num(r.ece)} | ${num(r.brier)} | ${num(r.auroc)} |`);
  }
  L.push('', '_Made with trust-threshold — https://thinx-pro.github.io/trust-threshold/_');
  return L.join('\n');
}

let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 150); };
$('input').addEventListener('input', schedule);
$('target').addEventListener('input', () => { $('targetNum').value = $('target').value; run(); });
$('targetNum').addEventListener('change', () => { $('target').value = Math.min(99.9, Math.max(80, Number($('targetNum').value))); run(); });
$('bins').addEventListener('change', run);
$('conservative').addEventListener('change', run);
$('example').addEventListener('click', () => { $('input').value = exampleText(); run(); });
$('clear').addEventListener('click', () => { $('input').value = ''; $('mapping').textContent = ''; run(); });
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { $('input').value = await f.text(); run(); }
});
$('copy').addEventListener('click', async () => {
  const md = markdown();
  if (!md) return;
  try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied.'; }
  catch { $('copied').textContent = 'Clipboard blocked by the browser.'; }
  setTimeout(() => { $('copied').textContent = ''; }, 2000);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) { $('input').value = await f.text(); run(); }
});

$('input').value = exampleText();
run();
