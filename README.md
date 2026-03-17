# burn-streaming

Sous-titres automatiques en temps réel pour les sites de streaming VOD (Netflix, Prime, Disney+, etc.).

Le script intercepte les segments vidéo HLS au fur et à mesure qu'ils sont téléchargés par le player, les transcrit/traduit via Whisper, et affiche les sous-titres synchronisés avec la vidéo.

---

## Architecture

```
Navigateur (console)          Serveur local (Docker)
─────────────────────         ──────────────────────────────────────
                              ┌─────────────────┐   ┌──────────────────────┐
 Site de streaming            │   API Rust       │   │  Whisper Service     │
 ┌──────────────┐   segments  │   :3000          │   │  (Python)  :8000     │
 │ HLS Player   │ ──hook──►  │                  │   │                      │
 │  fetch / XHR │            │ POST /transcribe │   │ POST /transcribe-    │
 └──────────────┘            │      -segment    ├──►│      segment         │
         ▲                   │                  │   │                      │
         │ sous-titres       │ ffmpeg: .ts/.m4s │   │ faster-whisper       │
 ┌──────────────┐            │ → WAV 16kHz mono │   │ → segments+timestamps│
 │   Overlay    │◄──────────-│                  │◄──│                      │
 │   (div fixe) │            └─────────────────-┘   └──────────────────────┘
 └──────────────┘
```

### Flux complet

1. **Interception** — `test-vod.js` hook les appels `fetch` et `XMLHttpRequest` du navigateur. Quand un segment `.ts` ou `.m4s` est téléchargé par le player HLS, le script le capture.

2. **Bootstrap rétroactif** — au démarrage, le script scanne `performance.getEntriesByType('resource')` pour récupérer les segments et manifestes `.m3u8` déjà chargés avant l'injection.

3. **Timeline HLS** — les manifestes `.m3u8` sont parsés pour connaître le timestamp absolu (en secondes depuis le début du film) de chaque segment.

4. **Queue priorisée** — les segments sont mis en queue et traités par ordre de proximité au `currentTime` de la vidéo. Max 3 requêtes simultanées vers l'API.

5. **API Rust** — reçoit le segment brut (`.ts`/`.m4s`), utilise `ffmpeg` pour en extraire l'audio en WAV 16kHz mono, puis envoie au service Whisper.

6. **Whisper** — transcrit/traduit l'audio et retourne une liste de segments avec timestamps relatifs `[{ text, start, end }]`.

7. **Synchronisation** — une boucle `requestAnimationFrame` compare `video.currentTime` aux timestamps absolus (`segStart + sub.start/end`) pour afficher le bon sous-titre au bon moment.

---

## Prérequis

- Docker + Docker Compose
- Un navigateur avec accès à la console développeur

---

## Installation et démarrage

```bash
make install   # build les images Docker
make start     # lance les services en arrière-plan
make stop      # arrête les services
make logs      # suit les logs en temps réel
```

Au premier démarrage, Whisper télécharge le modèle (~500 MB pour `medium`). Le service est prêt quand le healthcheck passe (jusqu'à 2 minutes).

---

## Utilisation

1. Lance les services : `make start`
2. Ouvre un site de streaming VOD dans le navigateur
3. Lance la vidéo
4. Ouvre la console développeur (F12) et colle le contenu de `test-vod.js`
5. Les sous-titres apparaissent automatiquement

**Commandes disponibles dans la console :**
```js
burnVodDiag()   // état du cache, segments interceptés, timeline
burnVodStop()   // arrêter et nettoyer
```

---

## Configuration

Toutes les options sont dans `docker-compose.yml` :

| Variable | Valeur par défaut | Description |
|---|---|---|
| `WHISPER_MODEL` | `medium` | Modèle Whisper : `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu` ou `cuda` (GPU NVIDIA) |
| `WHISPER_COMPUTE` | `int8` | `int8` (CPU), `float16` (GPU) |
| `WHISPER_TASK` | `transcribe` | `transcribe` = garde la langue source, `translate` = traduit en anglais |
| `WHISPER_LANG` | `en` | Langue source du contenu (`en`, `fr`, `es`, `ja`…) |

Après tout changement de config : `make stop && docker compose build whisper && make start`

---

## Performance (CPU uniquement)

| Modèle | Temps de traitement (~6s de segment) | Qualité |
|---|---|---|
| `tiny` | ~0.5s | passable |
| `base` | ~1s | correcte |
| `small` | ~2-3s | bonne |
| `medium` | ~5-8s | très bonne |

Avec un **GPU NVIDIA**, passer `WHISPER_DEVICE: cuda` et `WHISPER_COMPUTE: float16` donne un gain x10-20 et permet d'utiliser `large-v3`.

---

## Structure du projet

```
burn-streaming/
├── api/                    # API Rust (Axum)
│   ├── src/main.rs         # Route /transcribe-segment + appel ffmpeg
│   ├── Cargo.toml
│   └── Dockerfile
├── whisper-service/        # Service Python (faster-whisper)
│   ├── app.py              # Route /transcribe-segment + /health
│   ├── requirements.txt
│   └── Dockerfile
├── test-vod.js             # Script navigateur à injecter en console
├── docker-compose.yml
└── Makefile
```

---

## Limitations connues

- **Segments DRM** — les sites utilisant le chiffrement Widevine/PlayReady ne sont pas supportés. Les segments AES-128 simples fonctionnent si la clé est dans le manifeste.
- **Injection tardive** — si le script est injecté après le début de la vidéo, le bootstrap rétroactif récupère les segments déjà chargés, mais uniquement si l'URL du manifeste `.m3u8` est encore accessible (pas de token expiré).
- **iframes** — certains players sont dans des iframes cross-origin : le script doit être injecté dans le contexte de l'iframe concernée.
# burn-streaming
