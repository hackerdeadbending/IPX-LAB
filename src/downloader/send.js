import { sendTelegram } from "./telegram.js";
function extension(value) {
  const match = String(value || "").toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/);
  return match?.[1] || "";
}
function kindFromUrl(value, fallback = "document") {
  const ext = extension(value);
  if (["jpg","jpeg","png","webp"].includes(ext)) return "photo";
  if (["mp4","mov","m4v","webm"].includes(ext)) return "video";
  if (ext === "gif") return "animation";
  return fallback;
}
async function fetchMedia(media) {
  const response = await fetch(media.url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0", accept: media.type === "video" ? "video/*,*/*;q=0.8" : "image/*,*/*;q=0.8" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Media CDN returned HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Media CDN returned an empty file");
  return { bytes, contentType: response.headers.get("content-type") || (media.type === "video" ? "video/mp4" : "image/jpeg") };
}
async function sendMultipart(token, method, chatId, media, caption, fetched) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const field = method === "sendPhoto" ? "photo" : method === "sendVideo" ? "video" : method === "sendAnimation" ? "animation" : "document";
  const fallbackExt = method === "sendVideo" ? "mp4" : method === "sendAnimation" ? "gif" : "jpg";
  form.append(field, new File([fetched.bytes], media.filename || `ipx-lab-download.${fallbackExt}`, { type: fetched.contentType }));
  if (caption) form.append("caption", caption);
  return sendTelegram(token, method, form);
}
async function sendByUrl(token, chatId, media, caption) {
  const kind = media.type === "image" ? "photo" : media.type === "movie" ? "video" : (media.type || kindFromUrl(media.filename || media.url));
  const fetched = await fetchMedia({ ...media, type: kind });
  if (kind === "photo") {
    try { return await sendMultipart(token, "sendPhoto", chatId, media, caption, fetched); }
    catch { return await sendMultipart(token, "sendDocument", chatId, media, caption, fetched); }
  }
  if (kind === "video") {
    try { return await sendMultipart(token, "sendVideo", chatId, media, caption, fetched); }
    catch { return await sendMultipart(token, "sendDocument", chatId, media, caption, fetched); }
  }
  if (kind === "gif" || kind === "animation") {
    try { return await sendMultipart(token, "sendAnimation", chatId, media, caption, fetched); }
    catch { return await sendMultipart(token, "sendDocument", chatId, media, caption, fetched); }
  }
  return await sendMultipart(token, "sendDocument", chatId, media, caption, fetched);
}
export async function sendSocialMedia(env, chatId, resolved) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  let sent = 0;
  for (const item of resolved.items || []) {
    await sendByUrl(token, chatId, item, item.type === "video" ? "🎬 Video" : "📸 Photo");
    sent++;
  }
  if (resolved.audio) {
    try { await sendTelegram(token, "sendAudio", { chat_id: chatId, audio: resolved.audio, caption: "🎵 Original audio" }); }
    catch (error) { console.warn("IPX LAB audio send failed", error); }
  }
  return sent;
}
