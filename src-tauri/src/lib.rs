// ── File helpers ─────────────────────────────────────────────

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "svg"  => "image/svg+xml",
        "gif"  => "image/gif",
        "png"  => "image/png",
        "webp" => "image/webp",
        _      => "image/jpeg",
    };
    Ok(format!("data:{};base64,{}", mime, b64(&buf)))
}

fn b64(data: &[u8]) -> String {
    const C: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i+1 < data.len() { data[i+1] as u32 } else { 0 };
        let b2 = if i+2 < data.len() { data[i+2] as u32 } else { 0 };
        o.push(C[((b0>>2)&63) as usize] as char);
        o.push(C[(((b0<<4)|(b1>>4))&63) as usize] as char);
        o.push(if i+1<data.len() { C[(((b1<<2)|(b2>>6))&63) as usize] as char } else { '=' });
        o.push(if i+2<data.len() { C[(b2&63) as usize] as char } else { '=' });
        i += 3;
    }
    o
}

// ── AI / Ollama — routed through Rust to bypass WebView2 localhost restrictions ──

fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())
}

/// Returns true if Ollama is reachable (tries localhost + 127.0.0.1)
#[tauri::command]
async fn ollama_check(base_url: String) -> bool {
    let client = match build_client(3) { Ok(c) => c, Err(_) => return false };
    let aliases = [base_url.clone(), base_url.replace("localhost", "127.0.0.1")];
    for alias in &aliases {
        let url = format!("{}/api/tags", alias);
        if let Ok(r) = client.get(&url).send().await {
            if r.status().is_success() { return true; }
        }
    }
    false
}

/// List installed Ollama model names
#[tauri::command]
async fn ollama_models(base_url: String) -> Vec<String> {
    let client = match build_client(3) { Ok(c) => c, Err(_) => return vec![] };
    let aliases = [base_url.clone(), base_url.replace("localhost", "127.0.0.1")];
    for alias in &aliases {
        let url = format!("{}/api/tags", alias);
        if let Ok(r) = client.get(&url).send().await {
            if let Ok(json) = r.json::<serde_json::Value>().await {
                if let Some(arr) = json["models"].as_array() {
                    return arr.iter()
                        .filter_map(|m| m["name"].as_str().map(String::from))
                        .collect();
                }
            }
        }
    }
    vec![]
}

/// Call Ollama /api/generate and return response text
#[tauri::command]
async fn ollama_generate(base_url: String, model: String, prompt: String) -> Result<String, String> {
    let client = build_client(180)?;
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": { "temperature": 0.65, "num_predict": 2048, "top_p": 0.9 }
    });
    let aliases = [base_url.clone(), base_url.replace("localhost", "127.0.0.1")];
    let mut last_err = String::from("Could not connect to Ollama");
    for alias in &aliases {
        let url = format!("{}/api/generate", alias);
        match client.post(&url).json(&body).send().await {
            Ok(r) if r.status().is_success() => {
                let json: serde_json::Value = r.json().await.map_err(|e| format!("Parse: {}", e))?;
                return json["response"].as_str().map(String::from)
                    .ok_or_else(|| "No response field in Ollama output".to_string());
            }
            Ok(r)  => last_err = format!("Ollama HTTP {}", r.status()),
            Err(e) => last_err = format!("Connection: {}", e),
        }
    }
    Err(last_err)
}

/// Call OpenAI chat completions as fallback
#[tauri::command]
async fn openai_generate(api_key: String, prompt: String) -> Result<String, String> {
    let client = build_client(60)?;
    let body = serde_json::json!({
        "model": "gpt-3.5-turbo",
        "messages": [{"role":"user","content": prompt}],
        "max_tokens": 2048,
        "temperature": 0.65
    });
    let r = client.post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body).send().await
        .map_err(|e| format!("OpenAI request failed: {}", e))?;
    if !r.status().is_success() {
        return Err(format!("OpenAI returned HTTP {}", r.status()));
    }
    let json: serde_json::Value = r.json().await.map_err(|e| format!("Parse: {}", e))?;
    json["choices"][0]["message"]["content"].as_str().map(String::from)
        .ok_or_else(|| "No content in OpenAI response".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            write_file, read_file, read_file_b64,
            ollama_check, ollama_models, ollama_generate, openai_generate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pagedotcom");
}
