// trust-threshold core: parse (confidence, correct) rows, measure calibration,
// and find the confidence threshold that meets a target accuracy.
// Pure functions, no DOM — used by the page and by the tests.

const CONF_KEYS = ['confidence', 'conf', 'probability', 'prob', 'p', 'score', 'logprob_conf'];
const CORRECT_KEYS = ['correct', 'is_correct', 'right', 'hit', 'ok', 'label_correct'];
const PRED_KEYS = ['prediction', 'pred', 'predicted', 'answer', 'output'];
const GOLD_KEYS = ['label', 'gold', 'target', 'truth', 'expected', 'reference'];
const MODEL_KEYS = ['model', 'system', 'name', 'variant'];

function pick(keys, cols) {
  const lower = cols.map((c) => c.toLowerCase().trim());
  for (const k of keys) {
    const i = lower.indexOf(k);
    if (i >= 0) return cols[i];
  }
  return null;
}

function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v >= 0.5;
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'correct', 'right'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'wrong', 'incorrect'].includes(s)) return false;
  const x = Number(s);
  return Number.isFinite(x) && s !== '' ? x >= 0.5 : null;
}

// Parse CSV / TSV / JSON array / JSONL into records (plain objects).
export function parseRecords(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t[0] === '[') {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
  }
  if (t[0] === '{') {
    return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const head = splitCsvLine(lines[0], sep);
  const headerLike = head.some((h) => Number.isNaN(Number(h)));
  const cols = headerLike ? head : head.map((_, i) => (i === 0 ? 'confidence' : i === 1 ? 'correct' : 'col' + i));
  const body = headerLike ? lines.slice(1) : lines;
  return body.map((l) => {
    const cells = splitCsvLine(l, sep);
    const o = {};
    cols.forEach((c, i) => { o[c] = cells[i]; });
    return o;
  });
}

// Records → { groups: Map<model, [{c, y}]>, skipped, mapping }.
export function toPoints(records) {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const conf = pick(CONF_KEYS, cols);
  const correct = pick(CORRECT_KEYS, cols);
  const pred = pick(PRED_KEYS, cols);
  const gold = pick(GOLD_KEYS, cols);
  const model = pick(MODEL_KEYS, cols);
  if (!conf) throw new Error(`no confidence column found (looked for: ${CONF_KEYS.join(', ')})`);
  if (!correct && !(pred && gold)) throw new Error(`need a "correct" column, or both a prediction and a label column`);
  const raw = records.map((r) => Number(String(r[conf]).replace('%', '')));
  const finite = raw.filter(Number.isFinite);
  const percent = finite.length > 0 && Math.max(...finite) > 1 && Math.max(...finite) <= 100;
  const groups = new Map();
  let skipped = 0;
  records.forEach((r, i) => {
    let c = raw[i];
    if (percent) c /= 100;
    const y = correct ? toBool(r[correct]) : String(r[pred]).trim() === String(r[gold]).trim();
    if (!Number.isFinite(c) || c < 0 || c > 1 || y == null) { skipped++; return; }
    const m = model ? String(r[model] ?? '').trim() || '(blank)' : 'all';
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push({ c, y: y ? 1 : 0 });
  });
  return { groups, skipped, mapping: { confidence: conf, correct, prediction: correct ? null : pred, label: correct ? null : gold, model, percent } };
}

// Equal-width reliability bins.
export function reliability(points, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, conf: 0, acc: 0 }));
  for (const p of points) {
    const b = out[Math.min(bins - 1, Math.floor(p.c * bins))];
    b.n += 1; b.conf += p.c; b.acc += p.y;
  }
  for (const b of out) if (b.n) { b.conf /= b.n; b.acc /= b.n; }
  return out;
}

export function metrics(points, bins = 10) {
  const n = points.length;
  if (!n) return null;
  const rel = reliability(points, bins);
  let ece = 0, mce = 0;
  for (const b of rel) {
    if (!b.n) continue;
    const gap = Math.abs(b.acc - b.conf);
    ece += (b.n / n) * gap;
    mce = Math.max(mce, gap);
  }
  const acc = points.reduce((s, p) => s + p.y, 0) / n;
  const meanConf = points.reduce((s, p) => s + p.c, 0) / n;
  const brier = points.reduce((s, p) => s + (p.c - p.y) ** 2, 0) / n;
  return { n, acc, meanConf, ece, mce, brier, auroc: auroc(points), rel };
}

// Probability a random correct item has higher confidence than a wrong one.
export function auroc(points) {
  const pos = points.filter((p) => p.y === 1).length;
  const neg = points.length - pos;
  if (!pos || !neg) return null;
  const s = [...points].sort((a, b) => a.c - b.c);
  let rankSum = 0;
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && s[j].c === s[i].c) j++;
    const avg = (i + 1 + j) / 2; // average rank for ties
    for (let k = i; k < j; k++) if (s[k].y === 1) rankSum += avg;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// Wilson score interval lower bound for k successes out of n.
export function wilsonLower(k, n, z = 1.96) {
  if (!n) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / d;
}

// Accuracy–coverage curve: accept everything with confidence ≥ t, for every
// distinct t (high to low). Ties are accepted or rejected together.
export function coverageCurve(points) {
  const s = [...points].sort((a, b) => b.c - a.c);
  const n = s.length;
  const curve = [];
  let k = 0, hits = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && s[j].c === s[i].c) { hits += s[j].y; j++; }
    k = j;
    curve.push({ threshold: s[i].c, accepted: k, hits, coverage: k / n, acc: hits / k, lower: wilsonLower(hits, k) });
    i = j;
  }
  return curve;
}

// The lowest threshold (= most coverage) whose accepted accuracy meets the
// target. conservative: require the 95% Wilson lower bound to meet it.
export function thresholdFor(points, target, { conservative = false, minAccepted = 1 } = {}) {
  let best = null;
  for (const pt of coverageCurve(points)) {
    if (pt.accepted < minAccepted) continue;
    const score = conservative ? pt.lower : pt.acc;
    if (score >= target) best = pt;
  }
  return best;
}

// Deterministic shuffle so a split-half check is reproducible.
export function shuffled(points, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a = [...points];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick the threshold on one half, then measure it on the other half — the
// honest number, since a threshold tuned on its own eval set flatters itself.
export function splitHalf(points, target, opts = {}) {
  const a = shuffled(points, opts.seed ?? 1);
  const mid = Math.floor(a.length / 2);
  const tune = a.slice(0, mid);
  const test = a.slice(mid);
  const pick = thresholdFor(tune, target, opts);
  if (!pick || !test.length) return { tuned: pick, test: null };
  const acc = test.filter((p) => p.c >= pick.threshold);
  const hits = acc.reduce((s, p) => s + p.y, 0);
  return {
    tuned: pick,
    test: { threshold: pick.threshold, accepted: acc.length, coverage: acc.length / test.length, acc: acc.length ? hits / acc.length : null, n: test.length },
  };
}

export function analyzeGroup(points, { target = 0.95, bins = 10, conservative = false, seed = 1 } = {}) {
  const m = metrics(points, bins);
  if (!m) return null;
  return {
    ...m,
    curve: coverageCurve(points),
    pick: thresholdFor(points, target, { conservative }),
    split: splitHalf(points, target, { conservative, seed }),
  };
}

// Synthetic examples for the demo buttons. Clearly not real model outputs.
export function synthetic(kind, n = 2000, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let c, pTrue;
    if (kind === 'calibrated') {
      c = Math.min(0.999, 0.35 + 0.65 * Math.sqrt(rnd()));
      pTrue = c;
    } else { // overconfident: says 0.9+ a lot; only the very top is right ≥95% of the time
      c = Math.min(0.999, 0.7 + 0.3 * Math.pow(rnd(), 0.5));
      pTrue = 0.4 + (c - 0.7) * 1.9;
    }
    pts.push({ confidence: c.toFixed(3), correct: rnd() < pTrue ? 1 : 0 });
  }
  return pts;
}
