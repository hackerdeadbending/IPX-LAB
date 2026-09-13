const INPAINT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const VISION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
function telegramUrl(token, method) { return `https://api.telegram.org/bot${token}/${method}`; }
async function tg(token, method, body) {
  const response = await fetch(telegramUrl(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `${method} failed`);
  return data.result;
}
async function getSource(env, chatId) {
  const row = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(String(chatId)).first();
  return row?.file_id || null;
}
function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function makeMask(width, height, objects) {
  const mask = new Uint8Array(width * height);
  for (const object of objects) {
    const x1 = clamp(Math.floor(Number(object.x_min) * width), 0, width - 1);
    const y1 = clamp(Math.floor(Number(object.y_min) * height), 0, height - 1);
    const x2 = clamp(Math.ceil(Number(object.x_max) * width), x1 + 1, width);
    const y2 = clamp(Math.ceil(Number(object.y_max) * height), y1 + 1, height);
    const padX = Math.max(2, Math.floor((x2 - x1) * 0.08));
    const padY = Math.max(2, Math.floor((y2 - y1) * 0.08));
    const left = clamp(x1 - padX, 0, width - 1);
    const right = clamp(x2 + padX, left + 1, width);
    const top = clamp(y1 - padY, 0, height - 1);
    const bottom = clamp(y2 + padY, top + 1, height);
    for (let y = top; y < bottom; y++) mask.fill(255, y * width + left, y * width + right);
  }
  return Array.from(mask);
}
async function detect(env, imageDataUrl, target) {
  const result = await env.AI.run(VISION_MODEL, { task: "detect", image: imageDataUrl, target, max_objects: 20 });
  return Array.isArray(result?.objects) ? result.objects.filter((item) => Number.isFinite(Number(item?.x_min)) && Number.isFinite(Number(item?.y_min)) && Number.isFinite(Number(item?.x_max)) && Number.isFinite(Number(item?.y_max))) : [];
}
async function downloadSource(env, token, chatId) {
  const fileId = await getSource(env, chatId);
  if (!fileId) return null;
  const file = await tg(token, "getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error("Unable to download source image");
  const originalBytes = new Uint8Array(await response.arrayBuffer());
  const resized = await env.IMAGES.input(originalBytes).transform({ width: 768, height: 768, fit: "scale-down" }).output({ format: "image/jpeg", quality: 92 });
  const result = resized.response();
  if (!result.ok) throw new Error("Unable to prepare image for AI");
  const bytes = new Uint8Array(await result.arrayBuffer());
  const info = await env.IMAGES.info(bytes);
  return { bytes, width: Number(info.width), height: Number(info.height) };
}
export async function handleAiCallback(env, token, chatId, action, consumeAiOperation) {
  if (!env.AI || !env.DB) throw new Error("AI is not configured for this Worker yet");
  const mode = action === "ai:remove-watermark" ? "watermark" : action === "ai:remove-text" ? "text" : null;
  if (!mode) return false;
  const usage = await consumeAiOperation(env, chatId, mode);
  if (!usage.allowed) {
    await tg(token, "sendMessage", { chat_id: chatId, text: usage.premium ? "🔒 You have reached the Premium AI limit of 3000 operations today." : "🔒 You have used your 5 free AI operations this week. Upgrade to Premium for up to 3000 AI operations per day." });
    return true;
  }
  const prepared = await downloadSource(env, token, chatId);
  if (!prepared) { await tg(token, "sendMessage", { chat_id: chatId, text: "📸 Send a photo first." }); return true; }
  const rawBase64 = toBase64(prepared.bytes);
  const dataUrl = `data:image/jpeg;base64,${rawBase64}`;
  const objects = await detect(env, dataUrl, mode === "watermark" ? "watermark" : "text");
  if (!objects.length) {
    await tg(token, "sendMessage", { chat_id: chatId, text: mode === "watermark" ? "🔎 I couldn't confidently detect a watermark in this image." : "🔎 I couldn't confidently detect text in this image." });
    return true;
  }
  const mask = makeMask(prepared.width, prepared.height, objects);
  const output = await env.AI.run(INPAINT_MODEL, {
    prompt: mode === "watermark" ? "Restore the natural background and image details. Remove the detected watermark cleanly. Preserve the original subject, lighting, colors and composition. Do not add any new text or watermark." : "Restore the natural background and image details. Remove the detected text cleanly. Preserve the original subject, lighting, colors and composition. Do not add any new text.",
    negative_prompt: "text, letters, words, watermark, logo, artifacts, distortion, duplicated objects",
    width: prepared.width, height: prepared.height, image_b64: rawBase64, mask, num_steps: 20, strength: 1, guidance: 7.5
  });
  const outputBytes = new Uint8Array(await new Response(output).arrayBuffer());
  const filename = mode === "watermark" ? "ipx-lab-watermark-removed.jpg" : "ipx-lab-text-removed.jpg";
  const caption = mode === "watermark" ? "🧹 Watermark removed with AI.\n\nUse this only on images you own or are authorized to edit." : "📝 Text removed with AI.\n\nUse this only on images you own or are authorized to edit.";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new File([outputBytes], filename, { type: "image/jpeg" }));
  form.append("caption", caption);
  form.append("disable_content_type_detection", "true");
  const sent = await fetch(telegramUrl(token, "sendDocument"), { method: "POST", body: form });
  const data = await sent.json();
  if (!data.ok) throw new Error(data.description || "Unable to send AI result");
  const newId = data.result?.document?.file_id;
  if (newId) await env.DB.prepare("INSERT INTO source_images (telegram_id,file_id,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id,updated_at=CURRENT_TIMESTAMP").bind(String(chatId), newId).run();
  return true;
}
