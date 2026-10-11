'use strict';
/* Bant bant stereo ölçüm (src/shared/stereo-bands.js) ve onu çizen
 * Stereo İzler modu.
 *
 * Ölçüm bilinen cevaplı sinyallerle sınanıyor: tek kanaldaki bir ton
 * kendi bandında tam yanda, iki kanalda aynı sinyal tam ortada ve dar,
 * ters faz ve ilişkisiz gürültü dağınık. Mod gerçek kaynağıyla, sahte bir
 * tuvalde koşuyor; çizdiği segmentlerin nereye düştüğü ölçülüyor.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SB = require('../src/shared/stereo-bands.js');
const SP = require('../src/shared/spectrum.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const N = 2048;
const SR = 48000;
const sine = (f, g) => Float32Array.from({ length: N }, (_, i) => g * Math.sin((2 * Math.PI * f * i) / SR));
const zeros = () => new Float32Array(N);
function noise(seed) {
  let s = seed >>> 0;
  return Float32Array.from({ length: N }, () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 1.2 - 0.6;
  });
}
const toBytes = (f) => Uint8Array.from(f, (x) => Math.max(0, Math.min(255, Math.round(128 + x * 128))));
/* 30 Hz..15 kHz arası 40 ton. sin ile cos aynı genlik tayfını verir ama
   ilişkisizdir: her bantta enerji iki kanalda eşit (konum ~0), korelasyon
   ~0 (dağınık). Gürültüde bantların konumu da rastgele sapıyor ve
   yelpazeyi açan şeyin saçılma mı eğim mi olduğu ayrılamıyordu. */
const TONES = Array.from({ length: 40 }, (_, i) => 30 * Math.pow(500, i / 39));
const tones = (fn) => Float32Array.from({ length: N }, (_, i) =>
  TONES.reduce((s, f, j) => s + 0.033 * fn((2 * Math.PI * f * i) / SR + j * 2.39996), 0));

function bands(n) {
  const sb = new SB.StereoBands();
  sb.configure(n || 8, 20, 20000, SR);
  return sb;
}
const bandOf = (sb, hz) => {
  for (let k = 0; k < sb.n; k++) if (hz >= sb.edges[k] && hz < sb.edges[k + 1]) return k;
  return -1;
};

// ------------------------------------------------------------------ ölçüm

test('yalnız soldaki ton kendi bandında tam solda, yalnız sağdaki tam sağda, ikisi de dar', () => {
  const sb = bands(8);
  sb.update(sine(100, 0.8), zeros(), 0);
  const k = bandOf(sb, 100);
  assert.ok(k >= 0);
  assert.strictEqual(sb.pan[k], -1);
  assert.strictEqual(sb.spread[k], 0, 'tek kanaldaki kaynak tek noktada');
  sb.update(zeros(), sine(5000, 0.8), 0);
  const j = bandOf(sb, 5000);
  assert.strictEqual(sb.pan[j], 1);
  assert.strictEqual(sb.spread[j], 0);
});

test('iki bant ayrı yerde: soldaki bas ve sağdaki tiz birbirini sürüklemiyor', () => {
  const sb = bands(8);
  sb.update(sine(100, 0.8), sine(5000, 0.8), 0);
  assert.ok(sb.pan[bandOf(sb, 100)] < -0.95, 'bas bandı ' + sb.pan[bandOf(sb, 100)]);
  assert.ok(sb.pan[bandOf(sb, 5000)] > 0.95, 'tiz bandı ' + sb.pan[bandOf(sb, 5000)]);
});

test('aynı sinyal iki kanalda: her bant tam ortada ve dar (mono)', () => {
  const sb = bands(8);
  const x = noise(11);
  sb.update(x, x, 0);
  for (let k = 0; k < sb.n; k++) {
    assert.strictEqual(sb.pan[k], 0, 'bant ' + k);
    assert.ok(sb.spread[k] < 1e-6, 'bant ' + k + ' dağınıklık ' + sb.spread[k]);
    assert.ok(sb.level[k] > SB.QUIET_RMS, 'bant ' + k + ' sessiz sayıldı');
  }
});

test('sabit güçlü kaydırma: konum sin(p·π/2), dağınıklık 0', () => {
  const sb = bands(6);
  for (const p of [-1, -0.5, 0, 0.5, 1]) {
    const th = ((p + 1) * Math.PI) / 4;
    sb.update(sine(1000, 0.5 * Math.cos(th)), sine(1000, 0.5 * Math.sin(th)), 0);
    const k = bandOf(sb, 1000);
    assert.ok(Math.abs(sb.pan[k] - Math.sin((p * Math.PI) / 2)) < 1e-3, 'p=' + p + ': ' + sb.pan[k]);
    assert.ok(sb.spread[k] < 1e-3, 'p=' + p + ' dağınıklık ' + sb.spread[k]);
  }
});

test('ters faz ve ilişkisiz gürültü dağınık; konum yine ortada', () => {
  const sb = bands(8);
  const x = noise(3);
  sb.update(x, x.map((v) => -v), 0);
  for (let k = 0; k < sb.n; k++) {
    assert.strictEqual(sb.spread[k], 1, 'ters faz bant ' + k);
    assert.ok(Math.abs(sb.pan[k]) < 1e-6, 'ters faz konum ' + sb.pan[k]);
  }
  sb.update(noise(5), noise(9), 0);
  // En alt bant 25-60 Hz: 1536 örnekte birkaç periyot, ölçümü gürültülü
  for (let k = 1; k < sb.n; k++) assert.ok(sb.spread[k] > 0.8, 'ilişkisiz bant ' + k + ': ' + sb.spread[k]);
});

test('sessizlik ve nicemleme gürültüsü: yön yok, NaN yok', () => {
  const sb = bands(8);
  sb.update(zeros(), zeros(), 0);
  for (let k = 0; k < sb.n; k++) {
    assert.strictEqual(sb.level[k], 0);
    assert.strictEqual(sb.pan[k], 0);
    assert.strictEqual(sb.spread[k], 0);
  }
  // Tek basamaklık titreşim yalnız solda: yön seçilmemeli
  const lsb = new Uint8Array(N).map((_, i) => 128 + (i % 3 === 0 ? 1 : 0));
  sb.update(lsb, new Uint8Array(N).fill(128), 128);
  for (let k = 0; k < sb.n; k++) assert.strictEqual(sb.pan[k], 0, 'bant ' + k + ': ' + sb.pan[k]);
  // Eksik ya da boyları farklı kanallar
  sb.update(null, zeros(), 0);
  sb.update(zeros(), new Float32Array(10), 0);
  for (let k = 0; k < sb.n; k++) assert.ok(Number.isFinite(sb.pan[k]) && sb.level[k] === 0);
});

test('bayt girişi (128 merkezli) kayan noktalıyla aynı sonucu veriyor', () => {
  const a = bands(8);
  const b = bands(8);
  const l = sine(300, 0.6);
  const r = sine(300, 0.3);
  a.update(l, r, 0);
  b.update(toBytes(l), toBytes(r), 128);
  for (let k = 0; k < 8; k++) {
    if (a.level[k] < 0.02) continue;
    assert.ok(Math.abs(a.pan[k] - b.pan[k]) < 0.02, 'bant ' + k + ': ' + a.pan[k] + ' / ' + b.pan[k]);
  }
});

test('kenarlar: logaritmik, sınırlar içinde; tayfın mel kenarları da kabul ediliyor', () => {
  const e = SB.bandEdges(8, 20, 20000, 44100);
  assert.strictEqual(e[0], 25, 'alt kenar 25 Hz\'e çekiliyor');
  assert.ok(e[8] <= 44100 * 0.45 + 1e-9, 'üst kenar Nyquist\'in %45\'i');
  for (let i = 1; i < 8; i++) assert.ok(Math.abs(e[i] / e[i - 1] - e[i + 1] / e[i]) < 1e-9, 'oranlar eşit');

  const mel = SP.bandEdges(10, 20, 20000, 'mel');
  const sb = new SB.StereoBands();
  sb.configure(10, 20, 20000, SR, mel);
  assert.strictEqual(sb.n, 10);
  for (let i = 1; i < 10; i++) assert.ok(Math.abs(sb.edges[i] - mel[i]) < 1e-9, 'iç kenar ' + i + ' korunmadı');
  for (let i = 1; i <= 10; i++) assert.ok(sb.edges[i] >= sb.edges[i - 1] * 1.05 - 1e-9, 'bant ' + i + ' çöktü');
  // Sınırın dışına düşen kenarlar çöküp sonsuz Q üretmiyor
  const fit = SB.fitEdges(Float64Array.from([1, 2, 3, 30000, 40000]), SR);
  for (let i = 1; i < fit.length; i++) assert.ok(fit[i] > fit[i - 1], 'kenar ' + i);
});

test('update kare başına dizi ayırmıyor: aynı dizilere yazıyor', () => {
  const sb = bands(8);
  const before = [sb.pan, sb.spread, sb.level];
  sb.update(noise(1), noise(2), 0);
  const scratch = sb._l;
  sb.update(noise(3), noise(4), 0);
  assert.deepStrictEqual([sb.pan, sb.spread, sb.level], before);
  assert.strictEqual(sb._l, scratch);
});

// --------------------------------------------------------------- Stereo İzler

/* Mod gerçek dosyalarıyla koşuyor; iz tamponunun bağlamı moveTo/lineTo
   çiftlerini, o anki çizgi kalınlığıyla (bant başına farklı) kaydediyor. */
function runTrails(left, right, opts) {
  const o = opts || {};
  let segs = [];
  let lw = 0;
  let from = null;
  const trailCtx = new Proxy({}, {
    get(target, k) {
      if (k === 'moveTo') return (x, y) => { from = [x, y]; };
      if (k === 'lineTo') return (x, y) => { segs.push({ x0: from[0], y0: from[1], x, y, lw }); };
      if (k in target) return target[k];
      return () => {};
    },
    set(target, k, v) { if (k === 'lineWidth') lw = v; target[k] = v; return true; },
  });
  const plain = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const win = { document: { createElement: () => ({ width: 0, height: 0, getContext: () => trailCtx }) } };
  win.window = win;
  win.SVGlow = class { apply() {} };
  const ctx = vm.createContext(win);
  for (const f of ['src/shared/onset.js', 'src/shared/spectrum.js', 'src/shared/stereo-bands.js',
    'src/visualizer/modes/generative.js', 'src/visualizer/modes/generative2.js']) {
    vm.runInContext(read(f), ctx, { filename: path.basename(f) });
  }
  const W = 1280;
  const H = 720;
  const mode = new win.SVModes.stereotrails({ width: W, height: H, getContext: () => plain });
  const L = toBytes(left);
  const R = toBytes(right);
  const level = o.level == null ? 0.6 : o.level;
  const audio = {
    timeL: L, timeR: R, timeBytes: L, sampleRate: SR, bass: 0,
    getBars: (n) => (o.bars ? Float32Array.from(o.bars) : new Float32Array(n).fill(level)),
  };
  const cfg = { visualizer: { barCount: 128, minFreq: 20, maxFreq: 20000, sensitivity: 1, thickness: 0.42, lineWidth: 3, glow: 0, colorMode: 'rainbow', trailHeight: o.trailHeight } };
  for (let f = 0; f < (o.frames || 90); f++) {
    segs = [];
    mode.draw(audio, cfg, f / 60, 1 / 60);
  }
  // Segmentin ucu, tabanın ortasına göre (H biriminde)
  return { segs, cx: W / 2, H, dx: segs.map((s) => (s.x - W / 2) / H) };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const p90 = (a) => a.map(Math.abs).sort((x, y) => x - y)[Math.floor(a.length * 0.9)];

test('Stereo İzler: soldaki ses sola, sağdaki sağa eğiliyor; mono dik', () => {
  const left = runTrails(noise(21), zeros());
  const right = runTrails(zeros(), noise(21));
  const mono = runTrails(noise(21), noise(21));
  for (const r of [left, right, mono]) assert.ok(r.segs.length > 200, 'parçacık az: ' + r.segs.length);
  assert.ok(left.dx.filter((d) => d < 0).length / left.dx.length > 0.95, 'solda olmayan segment çok');
  assert.ok(right.dx.filter((d) => d > 0).length / right.dx.length > 0.95, 'sağda olmayan segment çok');
  assert.ok(mean(left.dx) < -0.15 && mean(right.dx) > 0.15, mean(left.dx) + ' / ' + mean(right.dx));
  assert.ok(Math.abs(mean(mono.dx)) < 0.03, 'mono ortadan kaymış: ' + mean(mono.dx));
  assert.ok(p90(mono.dx) < p90(left.dx) * 0.6, 'mono dik bir sütun olmalı');
});

test('Stereo İzler: dağınık ses (ilişkisiz kanallar) monodan geniş bir yelpaze açıyor', () => {
  const mono = runTrails(tones(Math.sin), tones(Math.sin));
  const wide = runTrails(tones(Math.sin), tones(Math.cos));
  assert.ok(Math.abs(mean(wide.dx)) < 0.05, 'dağınık ses ortada kalmalı: ' + mean(wide.dx));
  // Ölçüldü: ~8 kat; saçılma dağınıklığı okumasa ~1,5 kat
  assert.ok(p90(wide.dx) > p90(mono.dx) * 4, p90(wide.dx) + ' / ' + p90(mono.dx));
});

test('Stereo İzler: ince bir stereo görüntü de görünür eğiliyor', () => {
  // p = 0,15 sabit güçlü kaydırma; müzikte bantların çoğu bu kadar ortada
  const th = (1.15 * Math.PI) / 4;
  const src = tones(Math.sin);
  const subtle = runTrails(src.map((x) => x * Math.cos(th) * Math.SQRT2), src.map((x) => x * Math.sin(th) * Math.SQRT2));
  const hard = runTrails(zeros(), src.map((x) => x * Math.SQRT2));
  // Ölçüldü: eğriyle tam sağın ~%72'si, doğrusal eşlemede ~%41'i
  assert.ok(mean(subtle.dx) > mean(hard.dx) * 0.55, mean(subtle.dx) + ' / ' + mean(hard.dx));
});

test('Stereo İzler: her bant kendi yerinde — soldaki bas sola, sağdaki tiz sağa', () => {
  const r = runTrails(sine(100, 0.8), sine(5000, 0.8));
  const widths = [...new Set(r.segs.map((s) => s.lw))].sort((a, b) => b - a);
  assert.ok(widths.length >= 6, 'bant sayısı: ' + widths.length);
  // Kalın çizgi bas, ince çizgi tiz. Bas yayları kısa ve çabuk düşüyor:
  // tek karede bant başına ~20 parçacık, bu yüzden iki bant birlikte
  const lows = widths.slice(0, 2);
  const highs = widths.slice(-2);
  const bass = r.segs.filter((s) => lows.includes(s.lw)).map((s) => s.x - r.cx);
  const treble = r.segs.filter((s) => highs.includes(s.lw)).map((s) => s.x - r.cx);
  assert.ok(bass.length > 20 && treble.length > 20, bass.length + ' / ' + treble.length);
  assert.ok(mean(bass) < 0 && mean(treble) > 0, 'bas ' + mean(bass) + ', tiz ' + mean(treble));
});

test('Stereo İzler: yükseklik 1 bugünkü tepeyi korur, üstü ekranın dışına çıkar', () => {
  const srcL = noise(61);
  const srcR = noise(62);
  const base = runTrails(srcL, srcR, { frames: 90 });
  const same = runTrails(srcL, srcR, { trailHeight: 1, frames: 90 });
  const high = runTrails(srcL, srcR, { trailHeight: 2.5, frames: 90 });
  const peak = (r) => Math.min(...r.segs.map((s) => Math.min(s.y0, s.y)));
  assert.deepStrictEqual(same.segs, base.segs, 'ayar yokken ve 1 iken kare aynı olmalı');
  assert.ok(high.segs.length > 20 && base.segs.length > 20);
  // Ekran y'si yukarı küçülür. 2.5 kat, 720p'de tepeyi en az bir ekran boyu yukarı taşır.
  assert.ok(peak(high) < peak(base) - 720, peak(high) + ' / ' + peak(base));
});

test('Stereo İzler: seviye getBars\'tan geliyor (tayf ayarları işliyor), sessizlikte çizim yok', () => {
  const quiet = runTrails(noise(41), noise(42), { level: 0 });
  assert.strictEqual(quiet.segs.length, 0, 'bar 0 iken parçacık atıldı');
  const only = runTrails(noise(41), noise(42), { bars: [0.8, 0, 0, 0, 0, 0, 0, 0] });
  assert.ok(only.segs.length > 20);
  assert.strictEqual(new Set(only.segs.map((s) => s.lw)).size, 1, 'yalnız ilk bant atmalı');
});

test('Stereo İzler: aynı ses aynı kareyi veriyor (dışa aktarım için belirlenimli)', () => {
  const a = runTrails(noise(51), noise(52), { frames: 40 });
  const b = runTrails(noise(51), noise(52), { frames: 40 });
  assert.deepStrictEqual(a.segs, b.segs);
  assert.doesNotMatch(read('src/visualizer/modes/generative2.js'), /Math\.random\(/);
});

/* Mod SVStereoBands'i kurulurken okuyor: yardımcı sayfada yoksa katman
   sessizce boş çizer. Mod dosyasını yükleyen her sayfa yardımcıyı da
   yüklemeli (bkz. mode-catalog.test.js, Çalan Parça). */
test('Stereo İzler modunu yükleyen her sayfa stereo-bands.js\'i de yüklüyor', () => {
  for (const page of ['src/visualizer/index.html', 'src/web/overlay.html', 'src/exporter/index.html', 'src/admin/index.html']) {
    const html = read(page);
    assert.ok(html.includes('modes/generative2.js'), page + ': mod yok');
    assert.ok(html.includes('shared/stereo-bands.js'), page + ': SVStereoBands yok');
  }
});
