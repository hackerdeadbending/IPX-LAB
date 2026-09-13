import currentWorker from "./fixed-entry.js";
import { consumeAiOperation } from "./db.js";
import { handleAiCallback } from "./ai-tools.js";

const MAIN_ACTIONS = new Set(["resize", "exact-size", "compress", "convert", "crop", "safe-share", "metadata", "info"]);
function addAiButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  const isMain = replyMarkup.inline_keyboard.some(row => row.some(button => MAIN_ACTIONS.has(button.callback_data)));
  if (!isMain) return replyMarkup;
  const rows = replyMarkup.inline_keyboard.map(row => [...row]);
  if (!rows.some(row => row.some(button => button.callback_data === "ai:remove-watermark"))) {
    rows.push([{ text: "🧹 Remove Watermark", callback_data: "ai:remove-watermark" }, { text: "📝 Remove Text", callback_data: "ai:remove-text" }]);
  }
  return { ...replyMarkup, inline_keyboard: rows };
}
function patchOutgoing(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();
  if (!["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return init;
  try {
    if (init.body instanceof FormData) {
      const form = init.body;
      const markupText = form.get("reply_markup");
      if (typeof markupText === "string") form.set("reply_markup", JSON.stringify(addAiButtons(JSON.parse(markupText))));
      return { ...init, body: form };
    }
    const body = JSON.parse(init.body);
    if (!body.reply_markup) return init;
    const markup = typeof body.reply_markup === "string" ? JSON.parse(body.reply_markup) : body.reply_markup;
    body.reply_markup = addAiButtons(markup);
    return { ...init, body: JSON.stringify(body) };
  } catch { return init; }
}

export default {
  async fetch(request, env, ctx) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => originalFetch(input, patchOutgoing(input, init));
    try {
      if (request.method === "POST") {
        let update = null;
        try { update = await request.clone().json(); } catch {}
        const callback = update?.callback_query;
        const token = env.TELEGRAM_BOT_TOKEN;
        const chatId = callback?.message?.chat?.id;
        const action = callback?.data;
        if (token && chatId && (action === "ai:remove-watermark" || action === "ai:remove-text")) {
          try { await handleAiCallback(env, token, chatId, action, consumeAiOperation); }
          catch (error) {
            await originalFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: `❌ AI image processing error:\n\n${error?.message || "Unknown error"}` })
            });
          }
          return new Response("OK", { status: 200 });
        }
      }
      return await currentWorker.fetch(request, env, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
