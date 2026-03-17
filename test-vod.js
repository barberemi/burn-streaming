/**
 * burn-streaming — test-vod.js
 *
 * Mode VOD : intercepte les segments HLS (.ts / .m4s) avant leur lecture,
 * les transcrit en avance, et synchronise l'affichage avec video.currentTime.
 * Supporte fetch ET XMLHttpRequest.
 *
 * À coller dans la console sur n'importe quel site de streaming VOD.
 * Pour arrêter : burnVodStop()
 * Diagnostic   : burnVodDiag()
 */

(function () {
  const API = 'http://localhost:3000';

  // ── Nettoyage si re-lancé ──────────────────────────────────────────────
  if (window._burnVod) window._burnVod.stop();

  const cache    = new Map(); // url → { segStart, subs: [{text,start,end}] }
  const timeline = new Map(); // url → startTime absolu
  let   interceptedCount = 0;
  let   activeRequests   = 0;
  const MAX_CONCURRENT   = 3; // max requêtes simultanées vers Whisper
  const queue            = []; // { url, segStart, getBuffer }

  // ── Récupération rétroactive des segments déjà chargés ────────────────
  async function bootstrapFromPerformance() {
    const entries = performance.getEntriesByType('resource');

    // Chercher le manifeste .m3u8 le plus récent et le re-parser
    const manifests = entries.filter(e => e.name.includes('.m3u8'));
    for (const m of manifests) {
      try {
        const resp = await originalFetch(m.name);
        if (resp.ok) parseM3u8(await resp.text(), m.name);
      } catch {}
    }

    // Enqueuer les segments déjà téléchargés
    const segments = entries.filter(e => isSegment(e.name));
    let bootstrapped = 0;
    for (const e of segments) {
      if (!cache.has(e.name)) {
        const url = e.name;
        const segStart = timeline.get(url) ?? null;
        enqueue(url, segStart, () => originalFetch(url).then(r => r.arrayBuffer()));
        bootstrapped++;
      }
    }
    if (bootstrapped) console.log(`[BurnVOD] Bootstrap: ${bootstrapped} segments retroactifs enqueués`);
  }

  async function drainQueue() {
    while (queue.length > 0 && activeRequests < MAX_CONCURRENT) {
      // Prioriser le segment le plus proche du currentTime
      const v = findVideo();
      const t = v?.currentTime ?? 0;
      queue.sort((a, b) => Math.abs((a.segStart??0) - t) - Math.abs((b.segStart??0) - t));
      const task = queue.shift();
      activeRequests++;
      preTranscribeWithStart(task.url, task.segStart, task.getBuffer)
        .finally(() => { activeRequests--; drainQueue(); });
    }
  }

  // ── Diagnostic ─────────────────────────────────────────────────────────
  window.burnVodDiag = function () {
    const videos  = [...document.querySelectorAll('video')];
    const iframes = [...document.querySelectorAll('iframe')];
    const v = videos.sort((a,b) => b.videoWidth*b.videoHeight - a.videoWidth*a.videoHeight)[0];
    console.group('[BurnVOD] Diagnostic');
    console.log(`Videos trouvés      : ${videos.length}`, videos);
    console.log(`Iframes trouvés     : ${iframes.length}`, iframes.map(f => f.src));
    console.log(`Segments interceptés: ${interceptedCount}`);
    console.log(`Cache               : ${cache.size} segments`);
    console.log(`Timeline HLS        : ${timeline.size} entrées`);
    if (v) console.log(`video.currentTime   : ${v.currentTime.toFixed(2)}s`);
    console.log('── Cache détail ──');
    let i = 0;
    for (const [url, entry] of cache) {
      if (i++ > 5) { console.log('... (+ autres)'); break; }
      const name = url.split('?')[0].split('/').pop();
      if (!entry) { console.log(`  ${name}: en cours...`); continue; }
      console.log(`  ${name}: segStart=${entry.segStart?.toFixed(2)}s, ${entry.subs.length} subs`, entry.subs);
    }
    console.groupEnd();
  };

  // ── Trouver l'élément video ────────────────────────────────────────────
  function findVideo() {
    return [...document.querySelectorAll('video')].sort(
      (a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight)
    )[0] || null;
  }

  // ── Parser un manifeste HLS (.m3u8) ───────────────────────────────────
  function parseM3u8(text, manifestUrl) {
    const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
    const lines = text.split('\n');
    let cumulative = 0;
    let added = 0;

    for (let i = 0; i < lines.length; i++) {
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
    if (added) console.log(`[BurnVOD] m3u8 parsé → ${added} segments (durée totale: ${cumulative.toFixed(1)}s)`);
  }

  // ── Détection des URL de segments ─────────────────────────────────────
  function isSegment(url) {
    return /\.(ts|m4s)(\?|$)/i.test(url) ||
           /\/seg[-_]?\d/i.test(url) ||
           /\/chunk[-_]?\d/i.test(url) ||
           /hls.*\.(ts|m4s)/i.test(url);
  }

  function isManifest(url) {
    return url.includes('.m3u8');
  }

  // ── Envoi à l'API ──────────────────────────────────────────────────────
  async function preTranscribeWithStart(url, segStart, getBuffer) {
    console.debug(`[BurnVOD] Segment intercepté: ${url.split('?')[0].split('/').pop()} segStart=${segStart?.toFixed(1)}s`);

    try {
      const buffer = await getBuffer();
      const resp = await fetch(`${API}/transcribe-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (!resp.ok) { console.warn('[BurnVOD] API error', resp.status); return; }
      const data = await resp.json();
      // Priorité : timeline m3u8 (précis) > segStart buffered.end (approximatif) > null
      const start = timeline.get(url) ?? segStart ?? null;
      cache.set(url, { segStart: start, subs: data.segments || [] });
      console.log(`[BurnVOD] ✓ ${url.split('?')[0].split('/').pop()} → ${data.segments?.length} segs | start=${start?.toFixed(1)}s`);
    } catch (e) {
      console.warn('[BurnVOD] Erreur:', e.message);
    }
  }

  // Ajout à la queue (avec dédoublonnage)
  function enqueue(url, segStart, getBuffer) {
    if (cache.has(url)) return;
    if (queue.some(t => t.url === url)) return;
    cache.set(url, null); // réserver la place
    interceptedCount++;
    queue.push({ url, segStart, getBuffer });
    drainQueue();
  }

  // Version sans segStart (pour le hook fetch)
  async function preTranscribe(url, getBuffer) {
    const segStart = timeline.get(url) ?? null;
    enqueue(url, segStart, getBuffer);
  }

  // ── Hook fetch ─────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    const response = await originalFetch.call(this, input, init);

    if (isManifest(url)) {
      response.clone().text().then(t => parseM3u8(t, url)).catch(() => {});
    } else if (isSegment(url)) {
      const clone = response.clone();
      preTranscribe(url, () => clone.arrayBuffer()).catch(() => {});
    }

    return response;
  };

  // ── Hook XMLHttpRequest ────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url      = '';
    let _segStart = null;

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _url = url;
      if (isSegment(url)) {
        const v = findVideo();
        if (v && v.buffered.length > 0) {
          _segStart = v.buffered.end(v.buffered.length - 1);
        } else {
          _segStart = 0;
        }
      }
      return origOpen(method, url, ...rest);
    };

    xhr.addEventListener('load', function () {
      if (!_url) return;
      if (isManifest(_url)) {
        try { parseM3u8(xhr.responseText, _url); } catch {}
      } else if (isSegment(_url)) {
        const url      = _url;
        const segStart = _segStart;
        enqueue(url, segStart, () => originalFetch(url).then(r => r.arrayBuffer()));
      }
    });

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ── Overlay sous-titres ────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'burn-vod-overlay';
  Object.assign(overlay.style, {
    position:      'fixed',
    bottom:        '8%',
    left:          '50%',
    transform:     'translateX(-50%)',
    background:    'rgba(0,0,0,0.82)',
    color:         '#fff',
    fontSize:      '22px',
    lineHeight:    '1.4',
    fontFamily:    'Arial, sans-serif',
    padding:       '10px 24px',
    borderRadius:  '8px',
    zIndex:        '2147483647',
    maxWidth:      '80vw',
    textAlign:     'center',
    pointerEvents: 'none',
    opacity:       '0',
    transition:    'opacity 0.2s',
  });
  document.body.appendChild(overlay);

  let lastText = '';
  function showText(text) {
    if (text === lastText) return;
    lastText = text;
    overlay.textContent = text;
    overlay.style.opacity = text ? '1' : '0';
  }

  // ── Boucle de synchronisation ──────────────────────────────────────────
  let rafId = null;
  let video = null;
  let lastSubText = '';
  let lastSubEnd  = 0;

  function syncLoop() {
    if (!video) video = findVideo();
    if (video) {
      const t = video.currentTime;
      let found = '';

      for (const [, entry] of cache) {
        if (!entry || entry.segStart === null) continue;
        for (const sub of entry.subs) {
          const absStart = entry.segStart + sub.start;
          const absEnd   = entry.segStart + sub.end;
          if (t >= absStart - 0.1 && t <= absEnd + 0.5) {
            found = sub.text;
            lastSubText = found;
            lastSubEnd  = absEnd;
            break;
          }
        }
        if (found) break;
      }
      // Garder le dernier sous-titre visible 0.6s après sa fin
      if (!found && lastSubText && t <= lastSubEnd + 0.6) found = lastSubText;
      showText(found);
    }
    rafId = requestAnimationFrame(syncLoop);
  }
  rafId = requestAnimationFrame(syncLoop);

  // ── Stop ───────────────────────────────────────────────────────────────
  function stop() {
    cancelAnimationFrame(rafId);
    window.fetch = originalFetch;
    window.XMLHttpRequest = OrigXHR;
    overlay.remove();
    cache.clear();
    timeline.clear();
    delete window._burnVod;
    delete window.burnVodStop;
    delete window.burnVodDiag;
    console.log('[BurnVOD] Arrêté.');
  }

  window._burnVod    = { stop };
  window.burnVodStop = stop;

  bootstrapFromPerformance();

  // ── Détection iframes ──────────────────────────────────────────────────
  if (!findVideo()) {
    const iframes = [...document.querySelectorAll('iframe')];
    for (const iframe of iframes) {
      try {
        const iwin = iframe.contentWindow;
        if (!iwin || !iwin.document) continue;
        if (!iwin.document.querySelector('video')) continue;
        const s = iwin.document.createElement('script');
        s.textContent = document.currentScript?.textContent ?? '';
        iwin.document.head.appendChild(s);
        console.log(`%c[BurnVOD] Injecté dans iframe same-origin : ${iframe.src}`, 'color:#27ae60;font-weight:bold');
      } catch {
        console.warn(`[BurnVOD] Iframe cross-origin détectée : ${iframe.src}`);
        console.warn('→ Change le contexte DevTools ou utilise test-vod-mse.js');
      }
    }
    if (iframes.length === 0) console.warn('[BurnVOD] Aucune vidéo ni iframe trouvée sur cette page.');
  }

  console.log('%c[BurnVOD] Actif (fetch + XHR hookés)', 'color:#e67e22;font-weight:bold');
  console.log('→ burnVodDiag() pour voir l\'état');
  console.log('→ burnVodStop() pour arrêter');
  console.log('→ Lance/reprends la vidéo pour déclencher l\'interception');
})();
