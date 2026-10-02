import { sendPhoto } from "./photo.js";
import { sendVideo } from "./video.js";
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
async function sendByUrl(token, chatId, media, caption) {
  const kind = media.type || kindFromUrl(media.filename || media.url);
  if (kind === "photo") return sendPhoto(token, chatId, media, caption);
  if (kind === "video") return sendVideo(token, chatId, media, caption);
  if (kind === "animation") return sendTelegram(token, "sendAnimation", { chat_id: chatId, animation: media.url, caption });
  return sendTelegram(token, "sendDocument", { chat_id: chatId, document: media.url, caption });
}
export async function sendSocialMedia(env, chatId, resolved) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  if (resolved.kind === "single") {
    await sendByUrl(token, chatId, resolved, "✅ Downloaded");
    return 1;
  }
  let sent = 0;
  for (const item of resolved.items) {
    await sendByUrl(token, chatId, item, item.type === "video" ? "🎬 Video" : "📸 Photo");
    sent++;
  }
  if (resolved.audio) await sendTelegram(token, "sendAudio", { chat_id: chatId, audio: resolved.audio, caption: "🎵 Original audio" });
  return sent;
}