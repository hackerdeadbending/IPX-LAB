const INPAINT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const DETECT_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

function telegramUrl(token, method) { return `https://api.telegram.org/bot${token}/${method}`; }
async function tg(token, method, body) { const response = await fetch(telegramUrl(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!data.ok) throw new Error(data.description || `${method} failed`); return data.result; }
async function getSource(env, chatId) { try { const row = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(String(chatId)).first(); return row?.file_id || null; } catch { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS source_images (telegram_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run(); const row = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(String(chatId)).first(); return row?.file_id || null; } }
function toBase64(bytes) { let binary = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, i + chunk))); return btoa(binary); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function normalizeBox(item) { let values = ["x_min", "y_min", "x_max", "y_max"].map((key) => Number(item?.[key])); if (values.some((value) => !Number.isFinite(value))) return null; if (values.every((value) => value > 1 && value <= 100)) values = values.map((value) => value / 100); const [x_min, y_min, x_max, y_max] = values.map((value) => clamp(value, 0, 1)); if (x_max <= x_min || y_max <= y_min) return null; return { x_min, y_min, x_max, y_max }; }
function validObjects(objects) { return Array.isArray(objects) ? objects.map(normalizeBox).filter(Boolean) : []; }
function mergeObjects(groups) { const result = []; for (const group of groups) for (const object of validObjects(group)) { const duplicate = result.some((existing) => { const xOverlap = Math.max(0, Math.min(existing.x_max, object.x_max) - Math.max(existing.x_min, object.x_min)); const yOverlap = Math.max(0, Math.min(existing.y_max, object.y_max) - Math.max(existing.y_min, object.y_min)); const overlap = xOverlap * yOverlap; const area = Math.max(0.000001, Math.min((existing.x_max - existing.x_min) * (existing.y_max - existing.y_min), (object.x_max - object.x_min) * (object.y_max - object.y_min))); return overlap / area > 0.65; }); if (!duplicate) result.push(object); } return result.slice(0, 150); }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const typeBytes = new TextEncoder().encode(type); const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer); view.setUint32(0, data.length); out.set(typeBytes, 4); out.set(data, 8); view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out; }
async function makeMask(width, height, objects) {
  const channels = 3;
  const rows = new Uint8Array(height * (width * channels + 1));
  const boxes = validObjects(objects);
  let marked = 0;
  for (const object of boxes) {
    const x1 = clamp(Math.floor(object.x_min * width), 0, width - 1);
    const y1 = clamp(Math.floor(object.y_min * height), 0, height - 1);
    const x2 = clamp(Math.ceil(object.x_max * width), x1 + 1, width);
    const y2 = clamp(Math.ceil(object.y_max * height), y1 + 1, height);
    const padX = Math.max(6, Math.floor((x2 - x1) * 0.16));
    const padY = Math.max(6, Math.floor((y2 - y1) * 0.16));
    const left = clamp(x1 - padX, 0, width - 1);
    const right = clamp(x2 + padX, left + 1, width);
    const top = clamp(y1 - padY, 0, height - 1);
    const bottom = clamp(y2 + padY, top + 1, height);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { const index = y * (width * channels + 1) + 1 + x * channels; rows[index] = 255; rows[index + 1] = 255; rows[index + 2] = 255; marked++; }
  }
  const total = width * height;
  if (!total || marked / total > 0.5) throw new Error("AI detector returned an unsafe mask; please try a clearer image");
  const compressed = new Uint8Array(await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const header = new Uint8Array(13); const view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const chunks = [signature, pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())];
  const size = chunks.reduce((sum, part) => sum + part.length, 0); const png = new Uint8Array(size); let offset = 0; for (const part of chunks) { png.set(part, offset); offset += part.length; } return png;
}
function extractAiText(result) { const value = result?.response ?? result?.choices?.[0]?.message?.content ?? result?.result?.response ?? ""; if (typeof value === "string") return value; if (Array.isArray(value)) return value.map((part) => part?.text || part?.content || "").join(" "); return ""; }
function extractJson(text) { const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim(); try { return JSON.parse(cleaned); } catch {} const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}"); if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {} } return null; }
async function detectWithVision(env, imageDataUrl, mode) {
  const target = mode === "text" ? "visible text, words, letters, numbers, captions, subtitles, signs, labels, usernames and text overlays" : "watermark, logo, signature, brand mark, stamp or semi-transparent text logo";
  try {
    const result = await env.AI.run(DETECT_MODEL, { task: "detect", image: imageDataUrl, target, max_objects: 150, temperature: 0.1 });
    const objects = validObjects(result?.objects);
    if (objects.length) return objects;
  } catch (error) {
    console.error("Moondream detection failed", error);
  }
  const prompt = mode === "text"
    ? "Inspect this image for ANY visible written text. Return JSON with one bounding box for every visible text region. Do not return an empty list if any text is visible. Coordinates must be normalized 0..1."
    : "Inspect this image for ANY visible watermark, logo, signature, brand mark or semi-transparent text/logo overlay. Return JSON with one bounding box for every visible target. Coordinates must be normalized 0..1.";
  const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: `${prompt} Return ONLY {\"objects\":[{\"x_min\":0,\"y_min\":0,\"x_max\":0,\"y_max\":0}]} with no explanation.` }] }];
  try {
    const result = await env.AI.run(VISION_MODEL, { messages, max_tokens: 2500, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    const parsed = extractJson(extractAiText(result));
    return validObjects(parsed?.objects);
  } catch (error) {
    console.error("Gemma fallback detection failed", error);
    return [];
  }
}
async function detectWithFallback(env, imageDataUrl, mode) { try { return await detectWithVision(env, imageDataUrl, mode); } catch (error) { console.error("Vision detection failed", error); return []; } }
async function downloadSource(env, token, chatId) { const fileId = await getSource(env, chatId); if (!fileId) return null; const file = await tg(token, "getFile", { file_id: fileId }); if (!file?.file_path) throw new Error("Telegram did not return the source file path"); const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`); if (!response.ok) throw new Error("Unable to download source image"); const originalBytes = new Uint8Array(await response.arrayBuffer()); if (!originalBytes.length) throw new Error("Source image is empty"); const resized = await env.IMAGES.input(originalBytes).transform({ width: 1600, height: 1600, fit: "scale-down" }).output({ format: "image/jpeg", quality: 96 }); const result = resized.response(); if (!result.ok) throw new Error("Unable to prepare image for AI"); const bytes = new Uint8Array(await result.arrayBuffer()); const info = await env.IMAGES.info(bytes); return { bytes, width: Number(info.width), height: Number(info.height) }; }
export async function handleAiCallback(env, token, chatId, action, consumeAiOperation, languageCode = "en") { if (!env.AI || !env.DB) throw new Error("AI is not configured for this Worker yet"); const mode = action === "ai:remove-watermark" ? "watermark" : action === "ai:remove-text" ? "text" : null; if (!mode) return false; const ru = String(languageCode || "").toLowerCase().startsWith("ru"); const usage = await consumeAiOperation(env, chatId, mode); if (!usage.allowed) { await tg(token, "sendMessage", { chat_id: chatId, text: usage.premium ? (ru ? "🔒 Вы достигли лимита Premium AI: 3000 операций сегодня." : "🔒 You have reached the Premium AI limit of 3000 operations today.") : (ru ? "🔒 Вы использовали 5 бесплатных AI-операций за последние 7 дней. Premium — до 3000 AI-операций в день." : "🔒 You have used your 5 free AI operations in the last 7 days. Premium gives up to 3000 AI operations per day.") }); return true; }
  await tg(token, "sendMessage", { chat_id: chatId, text: mode === "text" ? (ru ? "🔎 Ищу текст на изображении…" : "🔎 Detecting text in the image…") : (ru ? "🔎 Ищу водяной знак или логотип…" : "🔎 Detecting watermark or logo…") });
  const prepared = await downloadSource(env, token, chatId); if (!prepared) { await tg(token, "sendMessage", { chat_id: chatId, text: ru ? "📸 Сначала отправьте фото." : "📸 Send a photo first." }); return true; }
  const rawBase64 = toBase64(prepared.bytes); const dataUrl = `data:image/jpeg;base64,${rawBase64}`; const objects = await detectWithFallback(env, dataUrl, mode);
  if (!objects.length) { await tg(token, "sendMessage", { chat_id: chatId, text: mode === "watermark" ? (ru ? "🔎 Не удалось найти водяной знак или логотип. Попробуйте изображение, где он хорошо виден." : "🔎 I couldn't find a watermark or logo. Try an image where it is clearly visible.") : (ru ? "🔎 Не удалось найти видимый текст. Если текст крупный и хорошо виден, попробуйте отправить фото ещё раз как изображение или файл." : "🔎 I couldn't find visible text. If the text is large and clear, try sending the image again as an image or file.") }); return true; }
  const objectsToMask = mergeObjects([objects]); const mask = await makeMask(prepared.width, prepared.height, objectsToMask);
  const output = await env.AI.run(INPAINT_MODEL, { prompt: mode === "watermark" ? "Remove every detected watermark, logo, signature or branded mark. Reconstruct only the hidden background and preserve the real person, hair, face, clothing, lighting, texture and composition. Do not add new objects or text." : "Remove every detected written word, letter, caption, subtitle, sign and text overlay. Reconstruct only the hidden background and preserve the real person, hair, face, clothing, lighting, texture and composition. Do not add new objects or text.", negative_prompt: "text, letters, words, watermark, logo, signature, artifacts, distortion, duplicated objects, blurry details", width: prepared.width, height: prepared.height, image: Array.from(prepared.bytes), mask: Array.from(mask), num_steps: 20, strength: 0.8, guidance: 7.5 });
  const outputBytes = new Uint8Array(await new Response(output).arrayBuffer()); if (outputBytes.length < 1000) throw new Error("AI returned an invalid or empty image"); const filename = mode === "watermark" ? "ipx-lab-watermark-removed.png" : "ipx-lab-text-removed.png"; const caption = mode === "watermark" ? (ru ? "🧹 Водяной знак удалён с помощью AI.\n\nИспользуйте функцию только для изображений, которыми вы владеете или которые вам разрешено редактировать." : "🧹 Watermark removed with AI.\n\nUse this only on images you own or are authorized to edit.") : (ru ? "📝 Текст удалён с помощью AI.\n\nИспользуйте функцию только для изображений, которыми вы владеете или которые вам разрешено редактировать." : "📝 Text removed with AI.\n\nUse this only on images you own or are authorized to edit.");
  const form = new FormData(); form.append("chat_id", String(chatId)); form.append("document", new File([outputBytes], filename, { type: "image/png" })); form.append("caption", caption); form.append("disable_content_type_detection", "true"); const sent = await fetch(telegramUrl(token, "sendDocument"), { method: "POST", body: form }); const data = await sent.json(); if (!data.ok) throw new Error(data.description || "Unable to send AI result");
  const newId = data.result?.document?.file_id; if (newId) await env.DB.prepare("INSERT INTO source_images (telegram_id,file_id,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id,updated_at=CURRENT_TIMESTAMP").bind(String(chatId), newId).run(); return true;
}
