import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecords, toPoints, reliability, metrics, auroc, wilsonLower,
  coverageCurve, thresholdFor, splitHalf, analyzeGroup, synthetic, shuffled,
} from '../calib.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('parses CSV with header, quotes, TSV, JSON and JSONL', () => {
  assert.deepEqual(parseRecords('confidence,correct\n0.9,1\n"0.5",0'), [{ confidence: '0.9', correct: '1' }, { confidence: '0.5', correct: '0' }]);
  assert.equal(parseRecords('conf\tok\n0.9\t1').length, 1);
  assert.equal(parseRecords('[{"p":0.9,"correct":true}]')[0].p, 0.9);
  assert.equal(parseRecords('{"p":0.9,"correct":true}\n{"p":0.2,"correct":false}\n').length, 2);
  // no header: first column = confidence, second = correct
  assert.deepEqual(parseRecords('0.9,1\n0.1,0')[1], { confidence: '0.1', correct: '0' });
  assert.equal(parseRecords('model,confidence,correct\n"a, b",0.9,1')[0].model, 'a, b');
});

test('maps columns: percent confidence, booleans, prediction vs label, models', () => {
  const a = toPoints(parseRecords('Confidence,Correct\n90,yes\n40%,no\nabc,1\n50,maybe'));
  assert.equal(a.mapping.percent, true);
  assert.deepEqual(a.groups.get('all'), [{ c: 0.9, y: 1 }, { c: 0.4, y: 0 }]);
  assert.equal(a.skipped, 2);
  const b = toPoints(parseRecords('model,prob,pred,label\nx,0.8,A,A\nx,0.7,B,A\ny,0.6,C,C'));
  assert.deepEqual(b.groups.get('x'), [{ c: 0.8, y: 1 }, { c: 0.7, y: 0 }]);
  assert.equal(b.groups.get('y').length, 1);
  assert.throws(() => toPoints(parseRecords('foo,bar\n1,2')), /no confidence column/);
  assert.throws(() => toPoints(parseRecords('confidence,foo\n0.5,2')), /correct/);
});

test('reliability bins and ECE on a hand-computed case', () => {
  const pts = [{ c: 0.95, y: 1 }, { c: 0.95, y: 0 }, { c: 0.15, y: 0 }, { c: 0.15, y: 0 }];
  const rel = reliability(pts, 10);
  assert.equal(rel[9].n, 2);
  close(rel[9].acc, 0.5);
  close(rel[1].conf, 0.15);
  const m = metrics(pts, 10);
  // bins: (0.95 vs 0.5)·½ + (0.15 vs 0)·½
  close(m.ece, 0.45 * 0.5 + 0.15 * 0.5);
  close(m.mce, 0.45);
  close(m.acc, 0.25);
  close(m.brier, (0.05 ** 2 + 0.95 ** 2 + 0.15 ** 2 * 2) / 4);
  assert.equal(reliability([{ c: 1, y: 1 }], 10)[9].n, 1, 'confidence 1.0 lands in the top bin');
});

test('AUROC handles perfect, inverted and tied rankings', () => {
  assert.equal(auroc([{ c: 0.9, y: 1 }, { c: 0.1, y: 0 }]), 1);
  assert.equal(auroc([{ c: 0.1, y: 1 }, { c: 0.9, y: 0 }]), 0);
  assert.equal(auroc([{ c: 0.5, y: 1 }, { c: 0.5, y: 0 }]), 0.5);
  assert.equal(auroc([{ c: 0.5, y: 1 }]), null);
});

test('Wilson lower bound', () => {
  close(wilsonLower(95, 100), 0.88825, 1e-4);
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(950, 1000) > wilsonLower(95, 100));
});

test('coverage curve treats ties together and picks the widest threshold', () => {
  const pts = [
    { c: 0.99, y: 1 }, { c: 0.99, y: 1 }, { c: 0.9, y: 1 }, { c: 0.9, y: 0 },
    { c: 0.8, y: 1 }, { c: 0.5, y: 0 },
  ];
  const curve = coverageCurve(pts);
  assert.deepEqual(curve.map((p) => p.accepted), [2, 4, 5, 6]);
  close(curve[1].acc, 0.75);
  close(curve[2].acc, 0.8);
  const pick = thresholdFor(pts, 0.8);
  assert.equal(pick.threshold, 0.8);
  close(pick.coverage, 5 / 6);
  assert.equal(thresholdFor(pts, 1).threshold, 0.99);
  assert.equal(thresholdFor([{ c: 0.9, y: 0 }], 0.5), null);
  // conservative needs more evidence: 2/2 correct has a low lower bound
  assert.equal(thresholdFor(pts, 0.8, { conservative: true }), null);
});

test('split-half is reproducible and measures on unseen items', () => {
  const pts = synthetic('calibrated', 1000, 3).map((r) => ({ c: Number(r.confidence), y: r.correct }));
  const a = splitHalf(pts, 0.9, { seed: 5 });
  const b = splitHalf(pts, 0.9, { seed: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.test.n, 500);
  assert.ok(a.test.coverage > 0 && a.test.coverage < 1);
  assert.equal(shuffled(pts, 5).length, pts.length);
});

test('synthetic examples behave as labelled', () => {
  const g = (k) => analyzeGroup(synthetic(k, 4000, 9).map((r) => ({ c: Number(r.confidence), y: r.correct })), { target: 0.95 });
  const cal = g('calibrated');
  const over = g('overconfident');
  assert.ok(cal.ece < 0.03, `calibrated ECE ${cal.ece}`);
  assert.ok(over.ece > 0.1, `overconfident ECE ${over.ece}`);
  assert.ok(over.meanConf - over.acc > 0.1);
  assert.ok(cal.pick && cal.pick.coverage > 0.1);
  assert.ok(!over.pick || over.pick.coverage < cal.pick.coverage);
});
