import currentWorker from "./features.js";
import baseWorker from "./entry.js";
import { handleAiAction, isAiAction, addAiButtons } from "./ai-removal.js";

const MAIN_ACTIONS = new Set(["resize", "exact-size", "compress", "convert", "crop", "safe-share", "metadata", "info"]);
const documentSourceChats = new Set();

function addMainButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  const isMainMenu = replyMarkup.inline_keyboard.some((row) => row.some((button) => MAIN_ACTIONS.has(button.callback_data)));
  return isMainMenu ? addAiButtons(replyMarkup) : replyMarkup;
}

function patchTelegramRequest(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();
  try {
    if (method === "sendInvoice") { const body = JSON.parse(init.body); delete body.subscription_period; return { ...init, body: JSON.stringify(body) }; }
    if (!["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return init;
    if (init.body instanceof FormData) {
      const form = init.body; const markupText = form.get("reply_markup");
      if (typeof markupText === "string") form.set("reply_markup", JSON.stringify(addMainButtons(JSON.parse(markupText))));
      if (form.has("document")) form.set("disable_content_type_detection", "true");
      return { ...init, body: form };
    }
    const body = JSON.parse(init.body);
    if (body.reply_markup) { const markup = typeof body.reply_markup === "string" ? JSON.parse(body.reply_markup) : body.reply_markup; body.reply_markup = addMainButtons(markup); return { ...init, body: JSON.stringify(body) }; }
  } catch (error) { console.error("IPX LAB Telegram patch error", error); }
  return init;
}

async function sendPatchedFetch(originalFetch, input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  const method = url.split("/").pop();
  if (method !== "sendPhoto" || !init?.body || documentSourceChats.size === 0) return originalFetch(input, patchTelegramRequest(input, init));
  try {
    const body = init.body instanceof FormData ? null : JSON.parse(init.body);
    const chatId = body ? String(body.chat_id || "") : "";
    if (body?.photo && documentSourceChats.has(chatId)) {
      const documentBody = { ...body, document: body.photo };
      delete documentBody.photo;
      const documentUrl = url.replace(/\/sendPhoto$/, "/sendDocument");
      documentSourceChats.delete(chatId);
      return originalFetch(documentUrl, { ...patchTelegramRequest(documentUrl, { ...init, body: JSON.stringify(documentBody) }) });
    }
  } catch (error) { console.error("IPX LAB document-photo compatibility error", error); }
  return originalFetch(input, patchTelegramRequest(input, init));
}

export default {
  async fetch(request, env, ctx) {
    const originalFetch = globalThis.fetch;
    if (request.method === "POST") {
      try {
        const update = await request.clone().json();
        const text = update?.message?.text?.trim();
        const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
        const isImageDocument = update?.message?.document?.mime_type?.toLowerCase?.().startsWith("image/");
        if (chatId && isImageDocument) documentSourceChats.add(String(chatId));
        if (chatId && update?.callback_query?.data && isAiAction(update.callback_query.data)) {
          const handled = await handleAiAction(env, update.callback_query);
          if (handled) return new Response("OK", { status: 200 });
        }
        if (chatId && (text === "/start" || text === "/help") && env.TELEGRAM_BOT_TOKEN) {
          const ru = String(update?.message?.from?.language_code || "").toLowerCase().startsWith("ru");
          await originalFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: ru ? "👋 Добро пожаловать в IPX LAB Photo!\n\n📸 Отправьте мне фото, и инструменты редактирования появятся автоматически." : "👋 Welcome to IPX LAB Photo!\n\n📸 Send me a photo and your editing tools will appear automatically." }) });
          return new Response("OK", { status: 200 });
        }
        const replyText = update?.message?.reply_to_message?.text || update?.message?.reply_to_message?.caption || "";
        if (update?.message?.text && /Enter the maximum width|Enter exact dimensions/i.test(replyText)) return await baseWorker.fetch(request, env, ctx);
      } catch (error) { console.error("IPX LAB fast command handling error", error); }
    }
    globalThis.fetch = (input, init) => sendPatchedFetch(originalFetch, input, init);
    try { return await currentWorker.fetch(request, env, ctx); }
    catch (error) { console.error("IPX LAB worker error", error); return new Response("OK", { status: 200 }); }
    finally { globalThis.fetch = originalFetch; documentSourceChats.clear(); }
  }
};
