'use strict';
/* OSC çıkışı (#437): src/main/osc-out.js.
 *
 * Kodlama OSC 1.0 belirtimindeki iki örnek pakete bayt bayt karşılaştırılıyor;
 * üretilen her paket uygulamanın kendi OSC alıcısının ayrıştırıcısıyla
 * (osc-server.js) geri çözülüyor. Gönderim gerçek bir UDP soketine, bu
 * makinenin döngü arayüzü üzerinden sınanıyor.
 */
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const O = require('../src/main/osc-out.js');
const { parsePacket } = require('../src/main/osc-server.js');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const decode = (buf) => { const out = []; parsePacket(buf, out, 0); return out[0]; };
const on = (extra) => O.normalize(Object.assign({ enabled: true }, extra));

// ------------------------------------------------------------------ kodlama

test('OSC 1.0 belirtimindeki iki örnek paket bayt bayt aynı', () => {
  assert.strictEqual(
    hex(O.encodeMessage('/oscillator/4/frequency', [['f', 440]])),
    '2f6f7363696c6c61746f722f342f6672657175656e6379002c66000043dc0000'
  );
  assert.strictEqual(
    hex(O.encodeMessage('/foo', [['i', 1000], ['i', -1], ['s', 'hello'], ['f', 1.234], ['f', 5.678]])),
    '2f666f6f000000002c69697366660000000003e8ffffffff68656c6c6f0000003f9df3b640b5b22d'
  );
});

test('dize NUL ile biter ve 4 bayta tamamlanır; UTF-8 karakter yarıda kesilmez', () => {
  for (let n = 0; n <= 9; n++) {
    const b = O.oscString('x'.repeat(n));
    assert.strictEqual(b.length % 4, 0, 'boy ' + n);
    assert.ok(b.length >= n + 1 && b.length - n <= 4, 'dolgu ' + n);
    assert.strictEqual(b[b.length - 1], 0);
  }
  assert.strictEqual(O.oscString('a\0b').toString('utf8').replace(/\0+$/, ''), 'ab', 'içteki NUL atılmalı');
  const long = O.oscString('ğ'.repeat(150)); // 300 bayt
  const text = long.toString('utf8').replace(/\0+$/, '');
  assert.ok(Buffer.byteLength(text) <= 200 && text.length === 100, 'kesme: ' + text.length);
  assert.ok(!text.includes('�'), 'yarım karakter kalmış');
});

test('sonlu olmayan sayı 0, tam sayı int32 sınırında', () => {
  const m = decode(O.encodeMessage('/x', [['f', NaN], ['f', Infinity], ['i', 1e12], ['i', -1e12], ['i', 2.6]]));
  assert.deepStrictEqual(m.args, [0, 0, 2147483647, -2147483648, 3]);
});

// ------------------------------------------------------------------ ayarlar

test('ayarlar: geçersiz her alan güvenli varsayılana düşer', () => {
  assert.deepStrictEqual(O.normalize(undefined), Object.assign({}, O.DEFAULTS));
  for (const host of ['evil host', 'a/b', '::1', '', 5, '-x.com', 'a'.repeat(254)]) {
    assert.strictEqual(on({ host }).host, '127.0.0.1', 'adres ' + host);
  }
  for (const host of ['192.168.1.20', 'resolume-pc.local', 'localhost']) assert.strictEqual(on({ host }).host, host);
  for (const port of [0, 70000, 'x', 1.5, -1]) assert.strictEqual(on({ port }).port, 9001, 'port ' + port);
  assert.strictEqual(on({ port: 7000 }).port, 7000);
  assert.strictEqual(on({ rate: 0 }).rate, 1);
  assert.strictEqual(on({ rate: 100 }).rate, 30);
  assert.strictEqual(on({ rate: 'x' }).rate, 30);
  assert.strictEqual(on({ prefix: '/cayadev/' }).prefix, '/cayadev');
  assert.strictEqual(on({ prefix: '' }).prefix, '');
  for (const prefix of ['/a/b/c/d/e', '/bad prefix', 'noslash', '/a//b']) {
    assert.strictEqual(on({ prefix }).prefix, '/cayadev', 'önek ' + prefix);
  }
  assert.strictEqual(O.normalize({ enabled: 'yes' }).enabled, false, 'yalnız true açar');
});

test('varsayılan: kapalı, hedef bu bilgisayar, OSC girişinin portundan farklı', () => {
  global.window = global.window || {};
  require('../src/shared/defaults.js');
  const d = global.window.SV.defaultConfig();
  assert.strictEqual(d.oscOut.enabled, false);
  assert.strictEqual(d.oscOut.host, '127.0.0.1');
  assert.notStrictEqual(d.oscOut.port, d.control.osc.port, 'iki varsayılan geri besleme olurdu');
  assert.deepStrictEqual(O.normalize(d.oscOut), Object.assign({}, O.DEFAULTS), 'varsayılanlar iki yerde aynı');
});

// --------------------------------------------------------------------- plan

const FRAME = { level: 0.5, bass: 1.7, mid: -0.2, treble: NaN };

test('seviyeler ayarlanan hızda, 0..1 aralığında', () => {
  const p = new O.Planner();
  const o = on({ rate: 10, hits: false, tempo: false, state: false });
  const at = [0, 50, 98, 120, 199, 230].filter((t) => p.frame(o, FRAME, {}, t).length);
  assert.deepStrictEqual(at, [0, 120, 230]);
  const m = new O.Planner().frame(o, FRAME, {}, 0);
  assert.deepStrictEqual(m.map((x) => [x[0], x[1][0][1]]), [
    ['/cayadev/level', 0.5], ['/cayadev/bass', 1], ['/cayadev/mid', 0], ['/cayadev/treble', 0],
  ]);
});

/* Uygulamada ölçüldü: ölçer iletileri ~33 ms arayla ama titreyerek
   geliyor. Eski aralık eşiği 30 Hz ayarında 17 Hz gönderiyordu. */
test('seviye hızı ölçer iletileri titrese de ortalamada tutuyor', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const rate of [30, 20, 15, 10, 1]) {
    const p = new O.Planner();
    const o = on({ rate, hits: false, tempo: false, state: false });
    let sent = 0;
    for (let i = 0, t = 0; t < 10000; i++, t = i * 33.3 + (rand() - 0.5) * 8) {
      if (p.frame(o, FRAME, {}, t).length) sent++;
    }
    const want = Math.min(rate, 30) * 10;
    assert.ok(Math.abs(sent - want) <= Math.max(2, want * 0.03), rate + ' Hz: 10 sn\'de ' + sent + ', beklenen ~' + want);
  }
  // Ölçer durup geri gelince birikmiş ileti seli yok
  const p = new O.Planner();
  const o = on({ rate: 30, hits: false, tempo: false, state: false });
  p.frame(o, FRAME, {}, 0);
  const burst = [5000, 5010, 5020, 5030].filter((t) => p.frame(o, FRAME, {}, t).length).length;
  assert.strictEqual(burst, 1, 'duraklamadan sonra tek ileti');
});

test('vuruşlar yalnız gerçekleştiğinde ve hız sınırına takılmadan', () => {
  const p = new O.Planner();
  const o = on({ levels: false, tempo: false, state: false });
  assert.deepStrictEqual(p.frame(o, { hits: { kick: 0, snare: 0, hat: 0 } }, {}, 0), []);
  const m = p.frame(o, { hits: { kick: 0.8, snare: 0, hat: 1.4 } }, {}, 1);
  assert.deepStrictEqual(m, [['/cayadev/hit/kick', [['f', 0.8]]], ['/cayadev/hit/hat', [['f', 1]]]]);
  assert.strictEqual(p.frame(on({ hits: false, levels: false, tempo: false, state: false }), { hits: { kick: 1 } }, {}, 2).length, 0);
});

test('tempo: değişince ya da saniyede bir, güvenle birlikte', () => {
  const p = new O.Planner();
  const o = on({ levels: false, hits: false, state: false });
  const sent = (bpm, t) => p.frame(o, {}, { bpm, confidence: 1.3 }, t).map((m) => m[0] + '=' + m[1][0][1]);
  assert.deepStrictEqual(sent(120, 0), ['/cayadev/tempo/bpm=120', '/cayadev/tempo/confidence=1']);
  assert.deepStrictEqual(sent(120.3, 100), [], '0,5 BPM altı oynama gönderilmez');
  assert.strictEqual(sent(121, 200).length, 2);
  assert.deepStrictEqual(sent(121, 900), []);
  assert.strictEqual(sent(121, 1250).length, 2, 'saniyelik yineleme');
  assert.deepStrictEqual(sent(0, 3000), [], 'tempo yokken sessiz');
  assert.deepStrictEqual(sent(NaN, 3001), []);
});

test('durum: değişimde, beş saniyede bir yine; boşa dönüş bir kez', () => {
  const p = new O.Planner();
  const o = on({ levels: false, hits: false, tempo: false });
  const ctx = { scene: 'Intro', visualizer: 'bars', background: 'gradient' };
  const names = (frame, c, t) => p.frame(o, frame, c, t).map((m) => m[0] + '=' + m[1][0][1]);
  assert.deepStrictEqual(names({}, ctx, 0), ['/cayadev/scene=Intro', '/cayadev/visualizer=bars', '/cayadev/background=gradient']);
  assert.deepStrictEqual(names({}, ctx, 100), []);
  assert.deepStrictEqual(names({}, Object.assign({}, ctx, { scene: 'Drop' }), 200), ['/cayadev/scene=Drop']);
  assert.deepStrictEqual(names({ mdPreset: { name: 'Geiss - Reaction' } }, Object.assign({}, ctx, { scene: 'Drop' }), 300),
    ['/cayadev/milkdrop/preset=Geiss - Reaction']);
  assert.deepStrictEqual(names({ mdPreset: null }, Object.assign({}, ctx, { scene: 'Drop' }), 400), ['/cayadev/milkdrop/preset=']);
  assert.deepStrictEqual(names({}, Object.assign({}, ctx, { scene: 'Drop' }), 5000),
    ['/cayadev/scene=Drop', '/cayadev/visualizer=bars', '/cayadev/background=gradient'], 'boş değer yinelenmez');
});

test('tempo vuruşu: ölçüdeki yer 1..N; geçersiz ya da kapalıysa hiçbir şey', () => {
  const p = new O.Planner();
  assert.deepStrictEqual(p.beat(on(), { beat: 3, beatsPerBar: 4 }), [['/cayadev/tempo/beat', [['i', 3], ['i', 4]]]]);
  assert.deepStrictEqual(p.beat(on(), { beat: 1 }), [['/cayadev/tempo/beat', [['i', 1], ['i', 4]]]], 'ölçü varsayılanı 4');
  for (const info of [{ beat: 0 }, { beat: 5, beatsPerBar: 4 }, null, 'x', { beat: 'a' }]) {
    assert.deepStrictEqual(p.beat(on(), info), [], JSON.stringify(info));
  }
  assert.deepStrictEqual(p.beat(on({ tempo: false }), { beat: 1 }), []);
});

test('önek her adrese uygulanıyor; boş önek kökten', () => {
  const m = new O.Planner().frame(on({ prefix: '/vj/a', hits: false, tempo: false, state: false }), FRAME, {}, 0);
  assert.ok(m.every((x) => x[0].startsWith('/vj/a/')));
  const r = new O.Planner().frame(on({ prefix: '', hits: false, tempo: false, state: false }), FRAME, {}, 0);
  assert.strictEqual(r[0][0], '/level');
  assert.deepStrictEqual(new O.Planner().beat(on({ prefix: '' }), { beat: 2 })[0][0], '/tempo/beat');
});

test('üretilen her ileti uygulamanın kendi OSC alıcısıyla geri çözülüyor', () => {
  const p = new O.Planner();
  const o = on();
  const msgs = p.frame(o, Object.assign({ hits: { kick: 0.9, snare: 0.4, hat: 0.2 }, mdPreset: { name: 'Martin - Liquid' } }, FRAME),
    { bpm: 127.5, confidence: 0.75, scene: 'Main', visualizer: 'stereotrails', background: 'nebula' }, 0)
    .concat(p.beat(o, { beat: 2, beatsPerBar: 3 }));
  assert.strictEqual(msgs.length, 4 + 3 + 2 + 4 + 1);
  for (const [address, args] of msgs) {
    const m = decode(O.encodeMessage(address, args));
    assert.ok(m, 'çözülemedi: ' + address);
    assert.strictEqual(m.address, address);
    assert.strictEqual(m.args.length, args.length);
    args.forEach(([t, v], i) => {
      if (t === 'f') assert.ok(Math.abs(m.args[i] - v) < 1e-5, address + ' ' + m.args[i] + ' / ' + v);
      else assert.strictEqual(m.args[i], v, address);
    });
  }
});

// ---------------------------------------------------------- geri besleme

test('geri besleme: hedef bu bilgisayarın açık OSC girişiyse gönderilmez', () => {
  const o = on({ port: 9000 });
  assert.strictEqual(O.loopError(o, '127.0.0.1', { enabled: true, port: 9000 }), O.LOOP);
  assert.strictEqual(O.loopError(o, '255.255.255.255', { enabled: true, port: 9000 }), O.LOOP, 'yayın da bu makineye döner');
  assert.strictEqual(O.loopError(o, '127.0.0.1', { enabled: false, port: 9000 }), null, 'giriş kapalı');
  assert.strictEqual(O.loopError(o, '127.0.0.1', { enabled: true, port: 9001 }), null, 'başka port');
  assert.strictEqual(O.loopError(o, '203.0.113.5', { enabled: true, port: 9000 }), null, 'başka makine');
  for (const a of ['127.0.0.1', '127.8.8.8', 'localhost', '0.0.0.0']) assert.ok(O.isLocalAddress(a), a);
  assert.ok(!O.isLocalAddress('203.0.113.5'));
  // Makinenin kendi IPv4 adresi (varsa) ve onun alt ağ yayın adresi
  const own = [].concat(...Object.values(os.networkInterfaces())).find((a) => a && !a.internal && (a.family === 'IPv4' || a.family === 4));
  if (own) {
    assert.ok(O.isLocalAddress(own.address), own.address);
    const ip = own.address.split('.').map(Number);
    const mask = own.netmask.split('.').map(Number);
    assert.ok(O.isLocalAddress(ip.map((x, i) => x | (~mask[i] & 255)).join('.')), 'alt ağ yayını');
  }
});

// ------------------------------------------------------------ gerçek UDP

function receiver() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const got = [];
    sock.on('message', (buf) => parsePacket(buf, got, 0));
    sock.bind(0, '127.0.0.1', () => resolve({ sock, got, port: sock.address().port }));
  });
}
const waitFor = (fn, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => (fn() || Date.now() - t0 > ms ? resolve(fn()) : setTimeout(tick, 10));
  tick();
});

test('gerçek UDP: seviye, vuruş, tempo, durum ve tempo vuruşu alıcıya ulaşıyor', async () => {
  const r = await receiver();
  const cfg = { enabled: true, host: '127.0.0.1', port: r.port };
  try {
    const st = await O.start(cfg, { enabled: true, port: r.port + 1 });
    assert.strictEqual(st.running, true, JSON.stringify(st));
    assert.strictEqual(st.error, null);
    const n = O.send(cfg, Object.assign({ hits: { kick: 1 } }, FRAME), { bpm: 128, confidence: 0.9, scene: 'Main', visualizer: 'bars', background: 'ink' });
    assert.strictEqual(O.beat(cfg, { beat: 1, beatsPerBar: 4 }), 1);
    await waitFor(() => r.got.length >= n + 1, 2000);
    const addrs = r.got.map((m) => m.address);
    for (const a of ['/cayadev/level', '/cayadev/hit/kick', '/cayadev/tempo/bpm', '/cayadev/scene', '/cayadev/tempo/beat']) {
      assert.ok(addrs.includes(a), a + ' gelmedi: ' + addrs.join(', '));
    }
    assert.deepStrictEqual(r.got.find((m) => m.address === '/cayadev/tempo/beat').args, [1, 4]);
    assert.strictEqual(O.status().packets, n + 1);
  } finally {
    await O.stop();
    r.sock.close();
  }
  assert.strictEqual(O.status().running, false);
  assert.strictEqual(O.send(cfg, FRAME, {}), 0, 'kapalıyken gönderim yok');
});

test('gerçek UDP: hedef açık OSC girişiyse paket gitmiyor, giriş kapanınca gidiyor', async () => {
  const r = await receiver();
  const cfg = { enabled: true, host: '127.0.0.1', port: r.port };
  try {
    const st = await O.start(cfg, { enabled: true, port: r.port });
    assert.strictEqual(st.error, O.LOOP);
    assert.strictEqual(O.send(cfg, FRAME, {}), 0);
    assert.strictEqual(O.beat(cfg, { beat: 1 }), 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(r.got.length, 0);
    // Aynı hedefle yeniden eşitleme: soket kalır, denetim tazelenir
    const again = await O.start(cfg, { enabled: false, port: r.port });
    assert.strictEqual(again.error, null);
    assert.ok(O.send(cfg, FRAME, {}) > 0);
    await waitFor(() => r.got.length > 0, 2000);
    assert.ok(r.got.length > 0);
  } finally {
    await O.stop();
    r.sock.close();
  }
});

// --------------------------------------------------------------- bağlantı

test('bağlantı: ana süreç, panel ve görselleştirici çıkışı doğru yerden besliyor', () => {
  const main = read('src/main/main.js');
  assert.match(main, /oscOut\.send\(currentConfig\.oscOut, data, oscOutContext\(\)\)/, 'ölçer iletisinden gönderim');
  assert.match(main, /if \(!o\.enabled \|\| HW_OFF\) return oscOut\.stop\(\)/, 'otomasyonda ağa paket yok');
  assert.match(main, /ipcMain\.on\('tempo:beat'[\s\S]{0,200}e\.sender !== adminWin\.webContents\) return;/, 'vuruş yalnız panelden');
  assert.match(main, /oscOut\.stop\(\)\.catch/, 'kapanışta soket kapanıyor');
  assert.match(read('src/visualizer/visualizer.js'), /hits: \{ kick: hitLatch\.kick, snare: hitLatch\.snare, hat: hitLatch\.hat \}/);
  assert.match(read('src/admin/autovj.js'), /fired && cfg\.oscOut && cfg\.oscOut\.enabled[\s\S]{0,120}reportTempoBeat/);
  const admin = read('src/admin/admin.js');
  assert.match(admin, /id: 'oscOut'[\s\S]{0,400}roots: \['oscOut'\][\s\S]{0,120}surface: 'oscout'/);
  assert.strictEqual(require('../src/shared/mcp.js').groupForPath('oscOut.host'), 'output', 'MCP izni Art-Net ile aynı');
});
