//! Small OCR GGUFs use the auxiliary vision process, leaving chat unchanged.
use super::*;

#[derive(Clone, Serialize)]
pub struct OcrModel {
    pub id: &'static str,
    pub name: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub mmproj_filename: &'static str,
    pub mmproj_url: &'static str,
    pub size: u64,
    pub license: &'static str,
    pub prompt: &'static str,
}

pub const MODELS: &[OcrModel] = &[
    OcrModel {
        id: "glm-ocr", name: "GLM-OCR 0.9B · Q8", filename: "GLM-OCR-Q8_0.gguf",
        url: "https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/GLM-OCR-Q8_0.gguf",
        mmproj_filename: "mmproj-GLM-OCR-Q8_0.gguf",
        mmproj_url: "https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/mmproj-GLM-OCR-Q8_0.gguf",
        size: 1_434_000_000, license: "MIT", prompt: "Text Recognition:",
    },
    OcrModel {
        id: "paddleocr", name: "PaddleOCR-VL 1.6 · 0.9B", filename: "PaddleOCR-VL-1.6-GGUF.gguf",
        url: "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf",
        mmproj_filename: "PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
        mmproj_url: "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
        size: 1_818_000_000, license: "Apache-2.0", prompt: "OCR:",
    },
];

#[tauri::command]
pub fn ocr_models(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    MODELS.iter().map(|m| {
        let mut value = serde_json::to_value(m).unwrap();
        value["installed"] = serde_json::json!(find_model(&app, m.filename).is_some() && find_model(&app, m.mmproj_filename).is_some());
        value
    }).collect()
}

fn ocr_body(model: &OcrModel, image: &str) -> Result<serde_json::Value, String> {
    if image.len() > 12 * 1024 * 1024 || !(image.starts_with("data:image/png;base64,") || image.starts_with("data:image/jpeg;base64,") || image.starts_with("data:image/webp;base64,")) {
        return Err("OCR : image PNG, JPEG ou WebP attendue (12 Mo maximum).".into());
    }
    Ok(serde_json::json!({
        "model": model.filename,
        "messages": [{"role":"user", "content": [
            {"type":"image_url", "image_url":{"url":image}},
            {"type":"text", "text":model.prompt}
        ]}],
        "max_tokens": 4096, "temperature": 0, "stream": false,
        "chat_template_kwargs": {"enable_thinking":false}
    }))
}

#[tauri::command]
pub async fn vision_ocr(app: tauri::AppHandle, state: tauri::State<'_, LlamaState>, model: String, image: String) -> Result<VisionLook, String> {
    let entry = MODELS.iter().find(|m| m.id == model).ok_or("Modèle OCR inconnu.")?;
    let body = ocr_body(entry, &image)?;
    // Screen vision and OCR share the auxiliary slot: never change its model
    // while another request is still using it.
    let _request = state.vision_request.lock().await;
    ensure_vision_server(&app, &state, entry.filename).await?;
    *state.vision_last_use.lock().await = Some(std::time::Instant::now());
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;
    let resp = client.post(format!("http://127.0.0.1:{VISION_PORT}/v1/chat/completions")).json(&body).send().await.map_err(|e| format!("OCR : {e}"))?;
    let status = resp.status();
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("OCR : {e}"))?;
    if !status.is_success() { return Err(format!("OCR : HTTP {status}")); }
    if data["choices"][0]["finish_reason"].as_str() == Some("length") { return Err("Page trop longue pour une transcription complète : découpez-la en plusieurs images.".into()); }
    let text = data["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() { return Err("Aucun texte reconnu sur cette page.".into()); }
    Ok(VisionLook {text, ms:started.elapsed().as_millis() as u64})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kev_variants_use_native_systemone_and_stay_out_of_chat() {
        for id in ["kev-08b", "kev-4b", "kev-9b"] {
            let model = DECISION_MODELS.iter().find(|m| m.id == id).unwrap();
            assert!(model.systemone);
            assert!(model.ollama.is_empty());
            assert!(is_decision_model(model.filename));
        }
    }
    #[test]
    fn image_inputs_are_bounded_and_never_treated_as_remote_urls() {
        assert!(ocr_body(&MODELS[0], "https://example.com/private.png").is_err());
        assert!(ocr_body(&MODELS[0], "data:text/html;base64,AAAA").is_err());
        let body = ocr_body(&MODELS[0], "data:image/png;base64,AAAA").unwrap();
        assert_eq!(body["max_tokens"], 4096);
        assert!(body.get("tools").is_none());
    }
    #[test]
    fn every_ocr_download_has_the_matching_vision_projector() {
        for m in MODELS {
            assert_eq!(mmproj_filename_for_model(m.filename), Some(m.mmproj_filename));
            assert!(m.url.starts_with("https://huggingface.co/"));
            assert!(m.mmproj_url.ends_with(m.mmproj_filename));
        }
    }
}
