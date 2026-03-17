"""
Service de transcription/traduction avec faster-whisper.

- /transcribe  : reçoit un fichier WAV, retourne le texte transcrit/traduit
- /health      : liveness probe
"""
import os
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile
from faster_whisper import WhisperModel

# ── Config ────────────────────────────────────────────────────────────────────

MODEL_SIZE = os.getenv("WHISPER_MODEL", "medium")   # tiny | base | small | medium | large-v3
DEVICE     = os.getenv("WHISPER_DEVICE", "cpu")      # cpu | cuda
COMPUTE    = os.getenv("WHISPER_COMPUTE", "int8")    # int8 | float16 | float32
# "translate" → traduit tout vers l'anglais
# "transcribe" → garde la langue source
TASK       = os.getenv("WHISPER_TASK", "translate")
LANG       = os.getenv("WHISPER_LANG", "en")  # langue source du stream

model: WhisperModel | None = None

# ── Startup ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    print(f"[whisper] Loading model={MODEL_SIZE} device={DEVICE} compute={COMPUTE}")
    cpu_threads = int(os.getenv("WHISPER_THREADS", "0")) or None  # 0 = auto (tous les cores)
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE,
                         cpu_threads=cpu_threads or 0, num_workers=2)
    print("[whisper] Model ready")
    yield
    model = None

app = FastAPI(title="Whisper Service", lifespan=lifespan)

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE}


@app.post("/transcribe-segment")
async def transcribe_segment(audio: UploadFile = File(...)):
    """
    Comme /transcribe mais retourne les segments avec timestamps.
    Utilisé pour le mode VOD (pré-chargement de segments HLS/DASH).
    Retourne : { segments: [{text, start, end}], language }
    """
    raw = await audio.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            task=TASK,
            language=LANG,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 100},
            word_timestamps=True,
        )

        result_segments = [
            {"text": seg.text.strip(), "start": round(seg.start, 3), "end": round(seg.end, 3)}
            for seg in segments
            if seg.text.strip()
        ]

        return {"segments": result_segments, "language": info.language}
    except ValueError:
        return {"segments": [], "language": None}
    finally:
        os.unlink(tmp_path)


