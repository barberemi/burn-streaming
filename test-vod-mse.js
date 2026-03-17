/**
 * burn-streaming — test-vod-mse.js
 *
 * Variante pour les players qui fetchent les segments via Web Worker (JW Player, etc.)
 * Intercepte via SourceBuffer.appendBuffer (MSE) au lieu de fetch/XHR.
 *
 * Prérequis : le bootstrap va re-fetcher le .m3u8 pour récupérer l'init segment (EXT-X-MAP).
 * Si ça ne marche pas, seek légèrement en avant pour forcer un nouvel append.
 *
 * À coller dans la console dans le bon contexte (iframe si besoin).
 * Pour arrêter : burnVodStop()
 * Diagnostic   : burnVodDiag()
 */

(function () {
  const API = 'http://localhost:3000';

  if (window._burnVod) window._burnVod.stop();

  const cache       = new Map(); // key → { segStart, subs }
  const timeline    = new Map(); // url → startTime absolu
  const initByMime  = new Map(); // mimeType → ArrayBuffer (init segment fMP4)

  // ── Bridge postMessage (currentTime depuis l'iframe cross-origin) ──────
  let _bridgeTime = null;
  window.addEventListener('message', (e) => {
    if (e.data?._burnVod === 'time') _bridgeTime = e.data.t;
  });

  function getCurrentTime() {
    const v = findVideo();
    return v?.currentTime ?? _bridgeTime ?? 0;
  }

  function broadcastSeek(t) {
    [...document.querySelectorAll('iframe')].forEach(f => {
      try { f.contentWindow.postMessage({ _burnVod: 'seek', t }, '*'); } catch {}
    });
  }
  let   interceptedCount = 0;
  let   activeRequests   = 0;
  const MAX_CONCURRENT   = 3;
  const queue            = [];

  async function drainQueue() {
    while (queue.length > 0 && activeRequests < MAX_CONCURRENT) {
      const t = getCurrentTime();
      queue.sort((a, b) => Math.abs((a.segStart??0) - t) - Math.abs((b.segStart??0) - t));
      const task = queue.shift();
      activeRequests++;
      processTask(task).finally(() => { activeRequests--; drainQueue(); });
    }
  }

  window.burnVodDiag = function () {
    const v = findVideo();
    console.group('[BurnVOD-MSE] Diagnostic');
    console.log(`Segments interceptés: ${interceptedCount}`);
    console.log(`Cache               : ${cache.size} segments`);
    console.log(`Timeline HLS        : ${timeline.size} entrées`);
    console.log(`Init segments       : ${[...initByMime.entries()].map(([m,v]) => `${m}=${v?.byteLength ?? 'en cours'}b`).join(', ')}`);
    console.log(`video.currentTime   : ${getCurrentTime().toFixed(2)}s (${_bridgeTime !== null ? 'bridge' : v ? 'direct' : 'inconnu'})`);
    console.log('── Cache détail ──');
    let i = 0;
    for (const [key, entry] of cache) {
      if (i++ > 5) { console.log('... (+ autres)'); break; }
      if (!entry) { console.log(`  ${key}: en cours...`); continue; }
      console.log(`  ${key}: segStart=${entry.segStart?.toFixed(2)}s, ${entry.subs.length} subs`);
    }
    console.groupEnd();
  };

  function findVideo() {
    const all = [...document.querySelectorAll('video')];
    // Chercher aussi dans les iframes same-origin
    for (const iframe of document.querySelectorAll('iframe')) {
      try { all.push(...iframe.contentDocument.querySelectorAll('video')); } catch {}
    }
    return all.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0] || null;
  }

  function parseM3u8(text, manifestUrl) {
    const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
    const lines = text.split('\n');
    let cumulative = 0, added = 0;

    for (let i = 0; i < lines.length; i++) {
      // Récupérer l'init segment depuis EXT-X-MAP
      const mapMatch = lines[i].match(/^#EXT-X-MAP:URI="([^"]+)"/);
      if (mapMatch) {
        const initUrl = mapMatch[1].startsWith('http') ? mapMatch[1] : base + mapMatch[1];
        fetch(initUrl).then(r => r.arrayBuffer()).then(buf => {
          // Stocker par taille (clé générique car MIME pas connu ici)
          initByMime.set('map:' + initUrl, buf);
          console.log(`[BurnVOD-MSE] Init segment récupéré: ${initUrl.split('/').pop()} (${buf.byteLength} bytes)`);
        }).catch(() => {});
      }

      const m = lines[i].match(/^#EXTINF:([\d.]+)/);
      if (m) {
        const duration = parseFloat(m[1]);
        const raw = lines[i + 1]?.trim();
        if (!raw || raw.startsWith('#')) continue;
        const url = raw.startsWith('http') ? raw : base + raw;
        if (!timeline.has(url)) { timeline.set(url, cumulative); added++; }
        cumulative += duration;
      }
    }
    if (added) console.log(`[BurnVOD-MSE] m3u8 parsé → ${added} segments (${cumulative.toFixed(1)}s)`);
  }

  async function processTask({ key, segStart, getBuffer }) {
    try {
      const buffer = await getBuffer();
      const resp = await fetch(`${API}/transcribe-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (!resp.ok) { console.warn('[BurnVOD-MSE] API error', resp.status); return; }
      const data = await resp.json();
      cache.set(key, { segStart, subs: data.segments || [] });
      console.log(`[BurnVOD-MSE] ✓ ${key} → ${data.segments?.length} segs | start=${segStart?.toFixed(1)}s`);
    } catch (e) {
      console.warn('[BurnVOD-MSE] Erreur:', e.message);
      cache.delete(key);
    }
  }

  function enqueue(key, segStart, getBuffer) {
    if (cache.has(key)) return;
    if (queue.some(t => t.key === key)) return;
    cache.set(key, null);
    interceptedCount++;
    queue.push({ key, segStart, getBuffer });
    drainQueue();
  }

  // ── Hook fetch pour les manifestes ────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    const response = await originalFetch.call(this, input, init);
    if (url.includes('.m3u8')) {
      response.clone().text().then(t => parseM3u8(t, url)).catch(() => {});
    }
    return response;
  };

  // ── Hook SourceBuffer.appendBuffer ────────────────────────────────────
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    sb._burnMime = mimeType;
    return sb;
  };

  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const mime = this._burnMime || '';

    // Ignorer audio-only
    if (!/^audio/i.test(mime)) {
      const raw = data instanceof ArrayBuffer
        ? data.slice(0)
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

      const bytes = new Uint8Array(raw);
      const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);

      if (boxType === 'ftyp' || boxType === 'moov' || boxType === 'styp') {
        // Stocker l'init segment
        this._burnInit = raw;
        initByMime.set(mime || 'unknown', raw);
        console.log(`[BurnVOD-MSE] Init segment capturé (${mime}, ${raw.byteLength} bytes)`);
      } else {
        // Fragment média — chercher l'init dans l'ordre de priorité
        const initData = this._burnInit
          ?? initByMime.get(mime || 'unknown')
          ?? [...initByMime.values()].find(v => v instanceof ArrayBuffer)
          ?? null;

        const segStart = this.buffered.length > 0 ? this.buffered.end(this.buffered.length - 1) : 0;
        const key = `mse:${Math.round(segStart)}`;

        if (!initData) {
          console.warn(`[BurnVOD-MSE] Pas d'init segment pour ${key} — seek pour en capturer un`);
        } else {
          enqueue(key, segStart, () => {
            const combined = new Uint8Array(initData.byteLength + raw.byteLength);
            combined.set(new Uint8Array(initData), 0);
            combined.set(new Uint8Array(raw), initData.byteLength);
            return Promise.resolve(combined.buffer);
          });
        }
      }
    }

    return origAppendBuffer.call(this, data);
  };

  // ── Overlay ───────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'burn-vod-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', bottom: '8%', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.82)', color: '#fff', fontSize: '22px', lineHeight: '1.4',
    fontFamily: 'Arial, sans-serif', padding: '10px 24px', borderRadius: '8px',
    zIndex: '2147483647', maxWidth: '80vw', textAlign: 'center',
    pointerEvents: 'none', opacity: '0', transition: 'opacity 0.2s',
  });
  document.body.appendChild(overlay);

  let lastText = '', lastSubText = '', lastSubEnd = 0;
  function showText(text) {
    if (text === lastText) return;
    lastText = text;
    overlay.textContent = text;
    overlay.style.opacity = text ? '1' : '0';
  }

  // ── Bootstrap : re-fetcher le m3u8 pour l'init segment ────────────────
  async function bootstrap() {
    const entries = performance.getEntriesByType('resource');
    const manifests = entries.filter(e => e.name.includes('.m3u8'));
    for (const m of manifests) {
      try {
        const resp = await originalFetch(m.name);
        if (resp.ok) parseM3u8(await resp.text(), m.name);
      } catch {}
    }
  }

  // ── Boucle de synchronisation ──────────────────────────────────────────
  let rafId = null, video = null;

  function syncLoop() {
    if (!video) video = findVideo();
    const t = getCurrentTime();
    if (t > 0 || video) {
      let found = '';
      for (const [, entry] of cache) {
        if (!entry || entry.segStart === null) continue;
        for (const sub of entry.subs) {
          const absStart = entry.segStart + sub.start;
          const absEnd   = entry.segStart + sub.end;
          if (t >= absStart - 0.1 && t <= absEnd + 0.5) {
            found = sub.text; lastSubText = found; lastSubEnd = absEnd; break;
          }
        }
        if (found) break;
      }
      if (!found && lastSubText && t <= lastSubEnd + 0.6) found = lastSubText;
      showText(found);
    }
    rafId = requestAnimationFrame(syncLoop);
  }
  rafId = requestAnimationFrame(syncLoop);

  // ── Stop ──────────────────────────────────────────────────────────────
  function stop() {
    cancelAnimationFrame(rafId);
    window.fetch = originalFetch;
    SourceBuffer.prototype.appendBuffer = origAppendBuffer;
    MediaSource.prototype.addSourceBuffer = origAddSourceBuffer;
    overlay.remove();
    cache.clear(); timeline.clear(); initByMime.clear();
    delete window._burnVod;
    delete window.burnVodStop;
    delete window.burnVodDiag;
    console.log('[BurnVOD-MSE] Arrêté.');
  }

  // ── Force reset hls.js pour récupérer l'init segment ─────────────────
  // hls.js ne renvoie l'init que lors d'un reset du transmuxer (seek à 0 + retour)
  window.burnVodForceInit = function () {
    const savedTime = getCurrentTime();
    if (savedTime === 0 && _bridgeTime === null && !findVideo()) {
      console.warn('[BurnVOD-MSE] Ni vidéo ni bridge actif — injecte test-vod-bridge.js dans l\'iframe d\'abord');
      return;
    }
    console.log(`[BurnVOD-MSE] Seek à 0 pour forcer le re-init (retour à ${savedTime.toFixed(1)}s dans 3s)...`);
    // Tenter seek direct sur la vidéo, sinon via bridge
    const v = findVideo();
    if (v) {
      v.currentTime = 0;
      setTimeout(() => { v.currentTime = savedTime; console.log('[BurnVOD-MSE] Retour.'); burnVodDiag(); }, 3000);
    } else {
      broadcastSeek(0);
      setTimeout(() => { broadcastSeek(savedTime); console.log('[BurnVOD-MSE] Retour.'); burnVodDiag(); }, 3000);
    }
  };

  window._burnVod    = { stop };
  window.burnVodStop = stop;

  bootstrap();

  console.log('%c[BurnVOD-MSE] Actif (SourceBuffer hooké)', 'color:#2980b9;font-weight:bold');
  console.log('→ burnVodDiag()      pour voir l\'état');
  console.log('→ Injecte test-vod-bridge.js dans l\'iframe pour le currentTime cross-origin');
  console.log('→ burnVodForceInit() si "Pas d\'init segment" — seek à 0 et retour auto');
  console.log('→ burnVodStop()      pour arrêter');
})();
