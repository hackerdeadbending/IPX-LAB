import { sendTelegram } from "./telegram.js";

export async function sendPhoto(token, chatId, media, caption) {
  return sendTelegram(token, "sendPhoto", {
    chat_id: chatId,
    photo: media.url,
    caption
  });
}
