use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tempfile::NamedTempFile;
use tokio::process::Command;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    whisper_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct SubtitleSegment {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Serialize, Deserialize, Debug)]
struct SegmentResult {
    segments: Vec<SubtitleSegment>,
    language: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()),
        )
        .init();

    let whisper_url = std::env::var("WHISPER_URL")
        .unwrap_or_else(|_| "http://whisper:8000".to_string());

    let state = Arc::new(AppState { whisper_url });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/transcribe-segment", post(transcribe_segment_handler)
            .layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/health", get(health_handler))
        .layer(cors)
        .with_state(state);

    let addr = "0.0.0.0:3000";
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    info!("API listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

async fn transcribe_segment_handler(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> impl IntoResponse {
    match process_video_segment(body, &state).await {
        Ok(result) => (StatusCode::OK, serde_json::to_string(&result).unwrap()),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::to_string(&ErrorResponse { error: e.to_string() }).unwrap(),
        ),
    }
}

async fn process_video_segment(
    data: Bytes,
    state: &AppState,
) -> Result<SegmentResult, Box<dyn std::error::Error + Send + Sync>> {
    let input_file = NamedTempFile::new()?;
    let input_path = input_file.path().to_str().unwrap().to_string();
    tokio::fs::write(&input_path, &data).await?;

    let output_file = tempfile::Builder::new().suffix(".wav").tempfile()?;
    let output_path = output_file.path().to_str().unwrap().to_string();

    let ffmpeg = Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &input_path,
            "-vn",
            "-ar", "16000",
            "-ac", "1",
            "-f", "wav",
            &output_path,
        ])
        .output()
        .await?;

    if !ffmpeg.status.success() {
        // Segment non décodable (init fMP4, DRM, format inconnu) → résultat vide
        let stderr = String::from_utf8_lossy(&ffmpeg.stderr);
        error!("ffmpeg failed (skipping): {}", stderr.lines().last().unwrap_or(""));
        return Ok(SegmentResult { segments: vec![], language: None });
    }

    let wav_data = tokio::fs::read(&output_path).await?;

    let client = reqwest::Client::new();
    let form = reqwest::multipart::Form::new().part(
        "audio",
        reqwest::multipart::Part::bytes(wav_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")?,
    );

    let resp = client
        .post(format!("{}/transcribe-segment", state.whisper_url))
        .multipart(form)
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await?;
        return Err(format!("Whisper service error: {}", text).into());
    }

    let result: SegmentResult = resp.json().await?;
    Ok(result)
}
