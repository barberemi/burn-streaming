FROM python:3.11-slim

WORKDIR /app

# Dépendances système (ffmpeg pas nécessaire ici, géré par Rust)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Le modèle Whisper est téléchargé au premier démarrage
# et mis en cache dans /root/.cache/huggingface
# → monter un volume pour éviter de re-télécharger à chaque restart

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
