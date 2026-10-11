/*
 * SoundVisualizer — CaYaDev Ses Görselleştirici
 * Copyright (c) 2026 Çağan Turgut (CaYatur) — CaYaDev, https://cayadev.com
 * https://github.com/CaYatur/SoundVisualizer
 * SPDX-License-Identifier: MIT
 */
'use strict';
/* Bant bant stereo görüntü: her frekans bandı sol-sağ eksende NEREDE ve ne
   kadar DAĞINIK.

   Gonyometre ve analysis.js'in genişlik/korelasyonu tüm sinyali tek sayıya
   indiriyor. Müzikte bas ve davul genelde ortada, gitar bir yana, hi-hat
   öbür yana, yankı iki yana yayılır; tek sayı bunların ortalamasını verir ve
   hepsi "biraz geniş, ortada" görünür. Burada her bant kendi sol ve sağ
   kanal enerjisinden ölçülüyor, böylece sola kaydırılmış bir enstrüman
   kendi bandında solda görünür.

   YÖNTEM
   Her bant, iki kenarı arasında bir bant geçiren süzgeç (RBJ "constant
   0 dB peak gain" biquad). Kenarlar verilmezse logaritmik aralıklı; Stereo
   İzler tayfın kendi kenarlarını veriyor (mel, bark...). İki kanal aynı süzgeçten
   geçiyor; çıkışlardan üç toplam tutuluyor: ΣL², ΣR², ΣLR.
     konum    (ΣR² − ΣL²) / (ΣR² + ΣL²)      -1 tam sol, 0 orta, +1 tam sağ
     dağınıklık 1 − ΣLR / √(ΣL²·ΣR²), [0,1]'e kırpılır: tek bir kaynak
              nereye kaydırılmış olursa olsun 0, ilişkisiz iki kanal 1,
              ters faz da 1
     seviye   √((ΣL² + ΣR²) / 2N), bandın RMS'i
   Konum enerji oranından geldiği için sabit güçlü bir kaydırmada
   (gL = cos θ, gR = sin θ) tam sol, orta ve tam sağda kesin; aradaki
   noktalarda tekdüze artar.

   Dağınıklık BİLEREK analysis.js'in genişliği (2·ΣS²/(ΣM²+ΣS²)) değil. O
   tanımda tam sola kaydırılmış mono bir gitar ile iki yana yayılmış bir
   yankı aynı sayıyı (1) alıyor: yalnız soldaki sinyalin orta ve yan
   enerjisi eşit. Burada konum ile dağınıklık ayrı sorular: gitar "solda,
   dar", yankı "ortada, dağınık".

   Süzgeç her karede sıfır durumdan, tamponun başından başlıyor: kareler
   arasında durum taşınmıyor çünkü tampon kayan bir pencere (yeni kare
   öncekiyle örtüşüyor) ve durum taşımak aynı örnekleri iki kez saymak
   olurdu. Isınma payı (pencerenin ilk çeyreği) toplamlara katılmıyor.

   Sessizlikte ve nicemleme gürültüsünün altında konum ve dağınıklık 0:
   8 bitlik örneklerde ±1 basamaklık gürültünün bir yönü yok, ona bakarak
   bir yan seçmek yanlış olurdu.

   Ayırma yok: sonuç dizileri configure() ile, tampon boyu değişince de
   örnek tamponu bir kez ayrılıyor; kare başına update() yalnızca sayı
   yazar. Saf aritmetik: testleri Node'da koşar. */
(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const MIN_HZ = 25;
  // RMS bunun altındaysa yön yok: 8 bitte bir basamak 1/128, gürültüsü ~0,002
  const QUIET_RMS = 0.004;

  /* Logaritmik aralıklı n+1 kenar. Alt kenar 25 Hz'den, üst kenar
     Nyquist'in %45'inden öteye geçmez: süzgeç tasarımı Nyquist'e yakın
     bozuluyor. */
  function bandEdges(n, minHz, maxHz, sampleRate) {
    const lo = Math.max(MIN_HZ, minHz || MIN_HZ);
    const hi = Math.max(lo * 1.5, Math.min(maxHz || 20000, sampleRate * 0.45));
    const out = new Float64Array(n + 1);
    const r = Math.log(hi / lo);
    for (let i = 0; i <= n; i++) out[i] = lo * Math.exp((r * i) / n);
    return out;
  }

  /* Dışarıdan verilen kenarlar (ör. SVSpectrum.bandEdges'in mel ya da bark
     ölçeği) aynı sınırlara çekiliyor. Her bant en az %5 genişlikte kalır:
     iki kenar sınırda üst üste düşerse Q sonsuza gider. */
  function fitEdges(edges, sampleRate) {
    const n = edges.length - 1;
    const out = new Float64Array(n + 1);
    const top = sampleRate * 0.45;
    for (let i = 0; i <= n; i++) {
      const prev = i ? out[i - 1] * 1.05 : MIN_HZ;
      out[i] = Math.max(prev, clamp(edges[i], MIN_HZ, top));
    }
    return out;
  }

  /* RBJ bant geçiren, tepe kazancı 0 dB. b1 = 0 ve b2 = -b0 olduğu için
     yalnız üç katsayı tutuluyor. Merkez kenarların geometrik ortası, Q bant
     genişliğinden. */
  function bandpass(f0, q, sampleRate) {
    const w = (2 * Math.PI * f0) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return { b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
  }

  class StereoBands {
    constructor() {
      this.n = 0;
      this.edges = null;
      this.pan = null;    // -1..1
      this.spread = null; // 0..1
      this.level = null;  // bandın RMS'i, tam ölçekli sinüste ~0,7
      this._b0 = null;
      this._a1 = null;
      this._a2 = null;
      this._l = null;
      this._r = null;
    }

    /* Ayar değişince çağrılır (her karede değil: dizileri yeniden ayırır).
       `edges` verilirse (n+1 kenar) bantlar onlardan, verilmezse
       minHz..maxHz arası logaritmik. */
    configure(n, minHz, maxHz, sampleRate, edges) {
      n = clamp(n | 0, 1, 32);
      const sr = sampleRate || 48000;
      this.n = n;
      this.edges = edges && edges.length === n + 1 ? fitEdges(edges, sr) : bandEdges(n, minHz, maxHz, sr);
      this.pan = new Float32Array(n);
      this.spread = new Float32Array(n);
      this.level = new Float32Array(n);
      this._b0 = new Float64Array(n);
      this._a1 = new Float64Array(n);
      this._a2 = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const lo = this.edges[k];
        const hi = this.edges[k + 1];
        const f0 = Math.sqrt(lo * hi);
        const c = bandpass(f0, f0 / (hi - lo), sr);
        this._b0[k] = c.b0;
        this._a1[k] = c.a1;
        this._a2[k] = c.a2;
      }
    }

    /* left / right: aynı boyda örnek dizileri. `center` 8 bitlik baytlar
       için 128 (görselleştiricinin timeL/timeR'ı), -1..1 kayan noktalı
       diziler için 0. Kanallardan biri yoksa ya da boylar farklıysa her
       şey sıfırlanır. */
    update(left, right, center) {
      const n = this.n;
      if (!n) return this;
      const N = left && right && left.length === right.length ? left.length : 0;
      if (N < 8) {
        this.pan.fill(0);
        this.spread.fill(0);
        this.level.fill(0);
        return this;
      }
      if (!this._l || this._l.length !== N) {
        this._l = new Float32Array(N);
        this._r = new Float32Array(N);
      }
      const c0 = center || 0;
      const scale = c0 ? 1 / c0 : 1;
      const L = this._l;
      const R = this._r;
      for (let i = 0; i < N; i++) {
        L[i] = (left[i] - c0) * scale;
        R[i] = (right[i] - c0) * scale;
      }
      const warm = N >> 2;
      const count = N - warm;
      for (let k = 0; k < n; k++) {
        const b0 = this._b0[k];
        const a1 = this._a1[k];
        const a2 = this._a2[k];
        let xl1 = 0, xl2 = 0, yl1 = 0, yl2 = 0;
        let xr1 = 0, xr2 = 0, yr1 = 0, yr2 = 0;
        let sll = 0, srr = 0, slr = 0;
        for (let i = 0; i < N; i++) {
          const xl = L[i];
          const xr = R[i];
          const yl = b0 * (xl - xl2) - a1 * yl1 - a2 * yl2;
          const yr = b0 * (xr - xr2) - a1 * yr1 - a2 * yr2;
          xl2 = xl1; xl1 = xl; yl2 = yl1; yl1 = yl;
          xr2 = xr1; xr1 = xr; yr2 = yr1; yr1 = yr;
          if (i >= warm) {
            sll += yl * yl;
            srr += yr * yr;
            slr += yl * yr;
          }
        }
        const tot = sll + srr;
        const rms = Math.sqrt(tot / (2 * count));
        this.level[k] = rms;
        if (rms < QUIET_RMS) {
          this.pan[k] = 0;
          this.spread[k] = 0;
          continue;
        }
        this.pan[k] = clamp((srr - sll) / tot, -1, 1);
        // Tek kanalda enerji yoksa kaynak tek noktada: korelasyon 1 sayılır
        const den = Math.sqrt(sll * srr);
        this.spread[k] = den > tot * 1e-6 ? clamp(1 - slr / den, 0, 1) : 0;
      }
      return this;
    }
  }

  const api = { StereoBands, bandEdges, fitEdges, bandpass, QUIET_RMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SVStereoBands = api;
})();
