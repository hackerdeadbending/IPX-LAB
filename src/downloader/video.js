import { sendTelegram } from "./telegram.js";

export async function sendVideo(token, chatId, media, caption) {
  return sendTelegram(token, "sendVideo", {
    chat_id: chatId,
    video: media.url,
    caption,
    supports_streaming: true
  });
}
