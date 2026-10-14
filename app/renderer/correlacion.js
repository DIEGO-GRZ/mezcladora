'use strict';
// Web Worker: mide el retraso entre dos señales (original y suma de stems) con correlación cruzada por FFT.
// Corre fuera del hilo de la interfaz para que la mezcladora nunca se trabe.
// Entrada: { id, o: Float32Array, s: Float32Array, rate, maxMs }
// Salida:  { id, retraso: segundos (negativo = los stems van adelantados), confianza: 0..1 }

function fft(re, im, inversa) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {           // reordenamiento por bits invertidos
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inversa ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inversa) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

self.onmessage = ({ data: { id, o, s, rate, maxMs } }) => {
  const N = o.length, n = N * 2;                 // relleno con ceros: correlación lineal, no circular
  const oRe = new Float64Array(n), oIm = new Float64Array(n), sRe = new Float64Array(n), sIm = new Float64Array(n);
  let eo = 0, es = 0;
  for (let i = 0; i < N; i++) { oRe[i] = o[i]; sRe[i] = s[i]; eo += o[i] * o[i]; es += s[i] * s[i]; }
  if (eo < 1e-6 || es < 1e-6) return self.postMessage({ id, retraso: 0, confianza: 0 }); // silencio: no se puede medir
  fft(oRe, oIm, false); fft(sRe, sIm, false);
  // corr[k] = Σ o[i]·s[i+k]  →  IFFT( conj(O) · S )
  const cRe = new Float64Array(n), cIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cRe[i] = oRe[i] * sRe[i] + oIm[i] * sIm[i];
    cIm[i] = oRe[i] * sIm[i] - oIm[i] * sRe[i];
  }
  fft(cRe, cIm, true);
  const M = Math.round(rate * maxMs / 1000);
  let mejor = -Infinity, lag = 0;
  for (let k = -M; k <= M; k++) {
    const v = cRe[(k + n) % n];
    if (v > mejor) { mejor = v; lag = k; }
  }
  self.postMessage({ id, retraso: lag / rate, confianza: mejor / Math.sqrt(eo * es) });
};
