function extension(filename) {
  const match = String(filename || "").toLowerCase().match(/\\.([a-z0-9]+)(?:$|\\?)/);
  return match?.[1] || "";
}

function kindFromUrl(url, fallback = "document") {
  const ext = extension(url);
  if (["jpg","jpeg","png","webp"].includes(ext)) return "photo";
  if (["mp4","mov","m4v","webm"].includes(ext)) return "video";
  if (ext === "gif") return "animation";
  return fallback;
}

async function telegram(token, method, body) {
  const isForm = body instanceof FormData;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function sendByUrl(token, chatId, media, caption) {
  const kind = media.type || kindFromUrl(media.url);
  if (kind === "photo") return telegram(token, "sendPhoto", { chat_id: chatId, photo: media.url, caption });
  if (kind === "video") return telegram(token, "sendVideo", { chat_id: chatId, video: media.url, caption, supports_streaming: true });
  if (kind === "animation") return telegram(token, "sendAnimation", { chat_id: chatId, animation: media.url, caption });
  return telegram(token, "sendDocument", { chat_id: chatId, document: media.url, caption });
}

export async function sendSocialMedia(env, chatId, resolved) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  if (resolved.kind === "single") {
    await sendByUrl(token, chatId, {
      url: resolved.url,
      filename: resolved.filename,
      type: kindFromUrl(resolved.filename, resolved.type === "mp4" ? "video" : "document")
    }, "✅ Downloaded");
    return 1;
  }

  let sent = 0;
  for (const item of resolved.items) {
    await sendByUrl(token, chatId, item, item.type === "video" ? "🎬 Video" : "📸 Photo");
    sent++;
  }
  if (resolved.audio) await telegram(token, "sendAudio", { chat_id: chatId, audio: resolved.audio, caption: "🎵 Original audio" });
  return sent;
}
