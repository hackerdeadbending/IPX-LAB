import currentWorker from "./features.js";
import baseWorker from "./entry.js";

const MAIN_ACTIONS = new Set(["resize", "exact-size", "compress", "convert", "crop", "safe-share", "metadata", "info"]);
const FILTER_ACTIONS = new Set(["filter:cinema", "filter:dark-cinema", "filter:golden", "filter:night", "filter:warm", "filter:cold", "filter:vintage", "filter:35mm", "filter:noir", "filter:moody", "filter:bw", "filter:dramatic-bw"]);
const documentSourceChats = new Set();

function patchTelegramRequest(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();
  try {
    if (method === "sendInvoice") { const body = JSON.parse(init.body); delete body.subscription_period; return { ...init, body: JSON.stringify(body) }; }
    if (!["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return init;
    if (init.body instanceof FormData) {
      const form = init.body;
      if (form.has("document")) form.set("disable_content_type_detection", "true");
      return { ...init, body: form };
    }
  } catch (error) { console.error("IPX LAB Telegram patch error", error); }
  return init;
}

async function prepareFilterSource(env, chatId, action) {
  if (!env.DB || !chatId) return;
  const id = String(chatId);
  const baseId = `${id}:filter-base`;
  try {
    if (action === "filters") {
      const current = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(id).first();
      if (current?.file_id) await env.DB.prepare("INSERT INTO source_images (telegram_id,file_id,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id,updated_at=CURRENT_TIMESTAMP").bind(baseId, current.file_id).run();
    } else if (FILTER_ACTIONS.has(action)) {
      const base = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(baseId).first();
      if (base?.file_id) await env.DB.prepare("UPDATE source_images SET file_id=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").bind(base.file_id, id).run();
    } else if (MAIN_ACTIONS.has(action)) {
      await env.DB.prepare("DELETE FROM source_images WHERE telegram_id=?").bind(baseId).run();
    }
  } catch (error) { console.error("IPX LAB filter source error", error); }
}

export default {
  async fetch(request, env, ctx) {
    const originalFetch = globalThis.fetch;
    if (request.method === "POST") {
      try {
        const update = await request.clone().json();
        const text = update?.message?.text?.trim();
        const chatId = update?.message?.chat?.id;
        const callbackAction = update?.callback_query?.data;
        const isImage = Boolean(update?.message?.photo?.length) || update?.message?.document?.mime_type?.toLowerCase?.().startsWith("image/");
        const isImageDocument = update?.message?.document?.mime_type?.toLowerCase?.().startsWith("image/");
        if (chatId && isImage && env.DB) await env.DB.prepare("DELETE FROM source_images WHERE telegram_id=?").bind(`${chatId}:filter-base`).run();
        if (chatId && isImageDocument) documentSourceChats.add(String(chatId));
        if (chatId && callbackAction) await prepareFilterSource(env, chatId, callbackAction);
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
