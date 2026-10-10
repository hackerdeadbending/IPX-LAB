import currentWorker from "./features.js";
import baseWorker from "./entry.js";

const MAIN_ACTIONS = new Set(["resize", "exact-size", "compress", "convert", "crop", "safe-share", "metadata", "info"]);
const FILTER_ACTIONS = new Set(["filter:cinema", "filter:dark-cinema", "filter:golden", "filter:night", "filter:warm", "filter:cold", "filter:vintage", "filter:35mm", "filter:noir", "filter:moody", "filter:bw", "filter:dramatic-bw"]);

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

function patchTelegramRequest(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();
  try {
    if (method === "sendInvoice" && typeof init.body === "string") {
      const body = JSON.parse(init.body);
      delete body.subscription_period;
      return { ...init, body: JSON.stringify(body) };
    }
    if (method === "sendDocument" && init.body instanceof FormData) {
      const form = init.body;
      if (form.has("document")) form.set("disable_content_type_detection", "true");
      return { ...init, body: form };
    }
  } catch (error) { console.error("IPX LAB Telegram patch error", error); }
  return init;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const update = await request.clone().json();
        const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
        const callbackAction = update?.callback_query?.data;
        const documentName = String(update?.message?.document?.file_name || "").toLowerCase();
        const documentMime = String(update?.message?.document?.mime_type || "").toLowerCase();
        const isImage = Boolean(update?.message?.photo?.length) || documentMime.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)$/.test(documentName);
        if (chatId && isImage && env.DB) await env.DB.prepare("DELETE FROM source_images WHERE telegram_id=?").bind(`${chatId}:filter-base`).run();
        if (chatId && callbackAction) await prepareFilterSource(env, chatId, callbackAction);
        const replyText = update?.message?.reply_to_message?.text || update?.message?.reply_to_message?.caption || "";
        if (update?.message?.text && /Enter the maximum width|Enter exact dimensions/i.test(replyText)) return await baseWorker.fetch(request, env, ctx);
      } catch (error) { console.error("IPX LAB filter wrapper error", error); }
    }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const nextInit = patchTelegramRequest(input, init);
      return originalFetch(input, nextInit);
    };
    try {
      return await currentWorker.fetch(request, env, ctx);
    } catch (error) {
      console.error("IPX LAB worker error", error);
      return new Response("OK", { status: 200 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
