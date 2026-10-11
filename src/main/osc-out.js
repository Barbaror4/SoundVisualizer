/*
 * SoundVisualizer — CaYaDev Ses Görselleştirici
 * Copyright (c) 2026 Çağan Turgut (CaYatur) — CaYaDev, https://cayadev.com
 * https://github.com/CaYatur/SoundVisualizer
 * SPDX-License-Identifier: MIT
 */
'use strict';
/* OSC (Open Sound Control) ÇIKIŞI — UDP (#437).

   Görselleştiricinin ölçtüğünü başka yazılımlara yollar: Resolume,
   TouchDesigner, Max/MSP, ışık masaları. Uygulama böylece bir çözümleme
   kaynağı olur; OSC girişinin (osc-server.js) tersi.

   ADRESLER (önek varsayılan /cayadev, OSC girişinin varsayılan eşlemesiyle
   aynı ad alanı; ayardan değişir)
     /level /bass /mid /treble        f    0..1, ayarlanan hızda sürekli
     /hit/kick /hit/snare /hit/hat    f    vuruş şiddeti 0..1, yalnız vuruşta
     /tempo/bpm /tempo/confidence     f    değişince, değişmese saniyede bir
     /tempo/beat                      i i  ölçüdeki vuruş (1..N) ve N
     /scene /visualizer /background   s    değişince, beş saniyede bir yine
     /milkdrop/preset                 s    değişince, beş saniyede bir yine

   NEDEN TEK TEK MESAJ, BUNDLE DEĞİL: bazı alıcılar (basit Max/Pd yamaları,
   bazı ışık masaları) #bundle açmıyor. Saniyede ~120 küçük UDP paketi yerel
   ağ ve döngü arayüzü için önemsiz.

   NEDEN DURUM YİNELENİYOR: UDP'de kayıp olağan ve alıcı sonradan da
   açılabilir. Yalnız değişimde gönderilen bir sahne adını sonradan açılan
   alıcı hiç görmezdi.

   NEDEN SEVİYE EN ÇOK 30 Hz: değerler görselleştiricinin ölçer iletisinden
   geliyor (visualizer.js, ~30 Hz); daha sık göndermek aynı değeri yinelerdi.
   Vuruşlar hız sınırına takılmaz: ölçer iletileri arasında görülen en güçlü
   vuruş iletiye biniyor ve hemen gidiyor.

   Kodlama elle (OSC 1.0): dize NUL ile biter ve 4 bayta tamamlanır, sayılar
   büyük endian. Giriş tarafı gibi bağımlılık eklemeye değmez.

   GÜVENLİK: varsayılan kapalı, hedef 127.0.0.1. Hedef bu bilgisayarın OSC
   girişiyse (açık ve aynı port) gönderilmez: çıkış girişe dönüp eşlenmiş
   bir ayarı sürerse geri besleme döngüsü olur. Ayardaki her alan burada
   yeniden denetlenir; MCP ya da elle düzenlenmiş bir ayar dosyası geçersiz
   bir hedef yazsa da güvenli varsayılana düşülür. */

const dgram = require('dgram');
const dns = require('dns');
const net = require('net');
const os = require('os');

const DEFAULTS = {
  enabled: false,
  host: '127.0.0.1',
  port: 9001,
  rate: 30,
  prefix: '/cayadev',
  levels: true,
  hits: true,
  tempo: true,
  state: true,
};
const MAX_RATE = 30;
const BPM_STEP = 0.5; // bu kadar oynamayan tempo yeniden gönderilmez
const HEARTBEAT_MS = 1000;
const STATE_REPEAT_MS = 5000;
const MAX_STRING = 200; // bayt
const LOOP = 'loop';
const STATE_KEYS = ['scene', 'visualizer', 'background', 'milkdrop/preset'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const unit = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const int32 = (v) => clamp(Math.round(Number(v) || 0), -2147483648, 2147483647);

// --------------------------------------------------------------- ayarlar
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/* Soket udp4: IPv6 adresi geçersiz sayılıyor. Ad, çözülebilen bir ana
   bilgisayar adı olmalı; "evil host" ya da "a/b" kabul edilmez. */
function validHost(h) {
  return typeof h === 'string' && (net.isIPv4(h) || (!net.isIP(h) && HOSTNAME.test(h)));
}

function normalize(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const host = typeof c.host === 'string' ? c.host.trim() : '';
  const port = Number(c.port);
  const rate = Number(c.rate);
  const prefix = typeof c.prefix === 'string' ? c.prefix.trim().replace(/\/+$/, '') : null;
  return {
    enabled: c.enabled === true,
    host: validHost(host) ? host : DEFAULTS.host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
    rate: Number.isFinite(rate) ? clamp(Math.round(rate), 1, MAX_RATE) : DEFAULTS.rate,
    // En çok dört parça; boş önek kökten yollar (/level)
    prefix: prefix !== null && /^(\/[A-Za-z0-9_-]{1,32}){0,4}$/.test(prefix) ? prefix : DEFAULTS.prefix,
    levels: c.levels !== false,
    hits: c.hits !== false,
    tempo: c.tempo !== false,
    state: c.state !== false,
  };
}

// ------------------------------------------------------------- kodlama
/* Dize: UTF-8, NUL ile biter, toplam boy 4'ün katı (en az bir NUL). OSC 1.0
   ASCII diyor; sahne adları Türkçe olabildiği için UTF-8 yollanıyor —
   Resolume, TouchDesigner ve Max böyle okur. Uzun dize karakter sınırında
   kesilir, çok baytlı bir karakter yarıda kalmaz. */
function oscString(s) {
  let str = String(s == null ? '' : s).replace(/\0/g, '');
  if (Buffer.byteLength(str, 'utf8') > MAX_STRING) {
    const chars = Array.from(str);
    while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > MAX_STRING) chars.pop();
    str = chars.join('');
  }
  const b = Buffer.from(str, 'utf8');
  const out = Buffer.alloc((Math.floor(b.length / 4) + 1) * 4);
  b.copy(out);
  return out;
}

/* args: [['f', 0.5], ['i', 3], ['s', 'ad']]. Sonsuz ya da NaN bir sayı 0
   olarak gider: alıcıda NaN, bazı yamalarda bütün zinciri bozuyor. */
function encodeMessage(address, args) {
  let tags = ',';
  const parts = [];
  for (const a of Array.isArray(args) ? args : []) {
    const t = a && a[0];
    const v = a && a[1];
    if (t === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number.isFinite(v) ? v : 0, 0);
      parts.push(b);
      tags += 'f';
    } else if (t === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(int32(v), 0);
      parts.push(b);
      tags += 'i';
    } else if (t === 's') {
      parts.push(oscString(v));
      tags += 's';
    }
  }
  return Buffer.concat([oscString(address), oscString(tags)].concat(parts));
}

// ----------------------------------------------------------------- plan
/* Ne zaman ne gönderileceği. Ağdan bağımsız, saati dışarıdan alıyor:
   testler zamanı ve girdiyi kendisi veriyor. */
class Planner {
  constructor() { this.reset(); }

  reset() {
    this.levelsDue = -Infinity;
    this.bpm = null;
    this.bpmAt = -Infinity;
    this.stateAt = -Infinity;
    this.state = {};
    for (const k of STATE_KEYS) this.state[k] = '';
  }

  /* Ölçer karesinden (main.js 'audio-meter') iletiler. `ctx`: bpm,
     confidence, scene, visualizer, background — ana sürecin bildikleri. */
  frame(o, frame, ctx, now) {
    const out = [];
    const p = o.prefix;
    const f = frame || {};
    const c = ctx || {};
    /* Hız bir takvimle tutuluyor, "son gönderimden bu yana" ile değil.
       Ölçer iletileri ~33 ms arayla ama titreyerek geliyor; aralık eşiği
       30 Hz'de erken gelen her iletiyi atıyordu ve uygulamada ölçülen hız
       17 Hz'di. Takvimde bir gecikme sonraki iletide kapanıyor, ortalama
       ayarlanan hızda kalıyor. Bir dönemden fazla geride kalınırsa (ölçer
       durduysa) takvim şimdiden yeniden başlar: biriken ileti seli olmaz. */
    if (o.levels && now >= this.levelsDue) {
      const period = 1000 / o.rate;
      this.levelsDue = (this.levelsDue < now - period ? now : this.levelsDue) + period;
      for (const k of ['level', 'bass', 'mid', 'treble']) out.push([p + '/' + k, [['f', unit(f[k])]]]);
    }
    if (o.hits && f.hits && typeof f.hits === 'object') {
      for (const k of ['kick', 'snare', 'hat']) {
        const v = unit(f.hits[k]);
        if (v > 0) out.push([p + '/hit/' + k, [['f', v]]]);
      }
    }
    if (o.tempo && Number.isFinite(c.bpm) && c.bpm > 0) {
      if (this.bpm === null || Math.abs(c.bpm - this.bpm) >= BPM_STEP || now - this.bpmAt >= HEARTBEAT_MS) {
        this.bpm = c.bpm;
        this.bpmAt = now;
        out.push([p + '/tempo/bpm', [['f', c.bpm]]]);
        out.push([p + '/tempo/confidence', [['f', unit(c.confidence)]]]);
      }
    }
    if (o.state) {
      const md = f.mdPreset && typeof f.mdPreset === 'object' ? f.mdPreset.name : '';
      const cur = { scene: c.scene, visualizer: c.visualizer, background: c.background, 'milkdrop/preset': md };
      const repeat = now - this.stateAt >= STATE_REPEAT_MS;
      if (repeat) this.stateAt = now;
      for (const k of STATE_KEYS) {
        const v = typeof cur[k] === 'string' ? cur[k] : '';
        // Boşa dönüş de bildirilir (MilkDrop ekrandan kalktı), boş değer yinelenmez
        if (v !== this.state[k] || (repeat && v)) {
          this.state[k] = v;
          out.push([p + '/' + k, [['s', v]]]);
        }
      }
    }
    return out;
  }

  /* Tempo motorunun vuruşu (panel, autovj.js): ölçüdeki yeri 1..N. */
  beat(o, info) {
    if (!o.tempo || !info || typeof info !== 'object') return [];
    const n = clamp(int32(info.beatsPerBar) || 4, 1, 64);
    const b = int32(info.beat);
    if (b < 1 || b > n) return [];
    return [[o.prefix + '/tempo/beat', [['i', b], ['i', n]]]];
  }
}

// --------------------------------------------------------- geri besleme
/* Bu bilgisayara giden adresler: döngü arayüzü, makinenin kendi IPv4
   adresleri, onların alt ağ yayın adresleri ve genel yayın. Hedef bunlardan
   biriyse ve OSC girişi aynı portu dinliyorsa paket girişe geri döner. */
function isLocalAddress(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  if (addr === 'localhost' || addr === '0.0.0.0' || addr === '255.255.255.255' || /^127\./.test(addr)) return true;
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (!a || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (a.address === addr) return true;
      if (a.netmask && net.isIPv4(a.address) && net.isIPv4(a.netmask)) {
        const ip = a.address.split('.').map(Number);
        const mask = a.netmask.split('.').map(Number);
        if (ip.map((x, i) => (x | (~mask[i] & 255))).join('.') === addr) return true;
      }
    }
  }
  return false;
}

function loopError(o, address, oscIn) {
  if (!oscIn || oscIn.enabled !== true || Number(oscIn.port) !== o.port) return null;
  return isLocalAddress(address || o.host) ? LOOP : null;
}

// ---------------------------------------------------------------- soket
let socket = null;
let started = '';
const planner = new Planner();
let state = { running: false, host: '', address: '', port: 0, packets: 0, lastSend: 0, error: null };

/* Ad bir kez, açılışta çözülür. Her pakette çözmek saniyede yüz kez
   getaddrinfo demek: Node onu iş parçacığı havuzunda koşturuyor. */
function resolveHost(host) {
  if (net.isIPv4(host)) return Promise.resolve(host);
  if (host === 'localhost') return Promise.resolve('127.0.0.1');
  return new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

function start(cfg, oscIn) {
  const o = normalize(cfg);
  if (!o.enabled) return stop().then(status);
  const key = o.host + ':' + o.port;
  // Hedef aynıysa soket yeniden kurulmaz; yalnız döngü denetimi tazelenir
  if (socket && state.running && started === key) {
    state.error = loopError(o, state.address, oscIn);
    return Promise.resolve(status());
  }
  return stop()
    .then(() => resolveHost(o.host))
    .then((address) => new Promise((resolve) => {
      const s = dgram.createSocket({ type: 'udp4' });
      s.on('error', (err) => {
        state.error = err.code || err.message;
        state.running = false;
        try { s.close(); } catch { /* zaten kapalı */ }
        if (socket === s) socket = null;
        resolve(status());
      });
      s.bind(() => {
        // Yayın adresine (ör. 192.168.1.255) gönderim isteğe bağlı ama izinli
        try { s.setBroadcast(true); } catch { /* izin yoksa tek adrese devam */ }
        socket = s;
        started = key;
        planner.reset();
        state = { running: true, host: o.host, address, port: o.port, packets: 0, lastSend: 0, error: loopError(o, address, oscIn) };
        resolve(status());
      });
    }))
    .catch((err) => {
      state = { running: false, host: o.host, address: '', port: o.port, packets: 0, lastSend: 0, error: err.code || err.message };
      return status();
    });
}

function stop() {
  return new Promise((resolve) => {
    state.running = false;
    started = '';
    if (!socket) { resolve(); return; }
    const s = socket;
    socket = null;
    try { s.close(() => resolve()); } catch { resolve(); }
    setTimeout(resolve, 200);
  });
}

function emit(o, msgs) {
  for (const [address, args] of msgs) {
    const buf = encodeMessage(address, args);
    try {
      socket.send(buf, o.port, state.address, (err) => {
        if (err) state.error = err.code || err.message;
        else {
          state.packets++;
          state.lastSend = Date.now();
        }
      });
    } catch (err) {
      state.error = err.message;
    }
  }
  return msgs.length;
}

function ready(cfg) {
  if (!socket || !state.running || state.error === LOOP) return null;
  const o = normalize(cfg);
  return o.enabled ? o : null;
}

// Ölçer karesi (~30 Hz). Dönüş: gönderilen ileti sayısı.
function send(cfg, frame, ctx) {
  const o = ready(cfg);
  return o ? emit(o, planner.frame(o, frame, ctx, Date.now())) : 0;
}

// Tempo vuruşu (panelden)
function beat(cfg, info) {
  const o = ready(cfg);
  return o ? emit(o, planner.beat(o, info)) : 0;
}

function status() {
  return Object.assign({}, state);
}

module.exports = {
  start, stop, send, beat, status,
  normalize, encodeMessage, oscString, Planner, isLocalAddress, loopError,
  DEFAULTS, LOOP,
};
