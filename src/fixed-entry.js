import currentWorker from "./features.js";
import { consumeAiOperation } from "./db.js";
import { handleAiCallback } from "./ai-tools.js";

const MAIN_ACTIONS = new Set(["resize", "exact-size", "compress", "convert", "crop", "safe-share", "metadata", "info"]);
const AI_ACTIONS = new Set(["ai:remove-watermark", "ai:remove-text"]);

function addMenuButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  const isMainMenu = replyMarkup.inline_keyboard.some((row) =>
    row.some((button) => MAIN_ACTIONS.has(button.callback_data))
  );
  if (!isMainMenu) return replyMarkup;

  const rows = replyMarkup.inline_keyboard.map((row) => [...row]);
  const hasFilters = rows.some((row) => row.some((button) => button.callback_data === "filters"));
  const hasPremium = rows.some((row) => row.some((button) => button.callback_data === "premium"));
  if (!hasFilters || !hasPremium) {
    rows.push([
      { text: "🎬 Filters", callback_data: "filters" },
      { text: "⭐ Buy Premium", callback_data: "premium" }
    ]);
  }
  const hasWatermark = rows.some((row) => row.some((button) => button.callback_data === "ai:remove-watermark"));
  const hasText = rows.some((row) => row.some((button) => button.callback_data === "ai:remove-text"));
  if (!hasWatermark || !hasText) {
    rows.push([
      { text: "🧹 Remove Watermark", callback_data: "ai:remove-watermark" },
      { text: "📝 Remove Text", callback_data: "ai:remove-text" }
    ]);
  }
  return { ...replyMarkup, inline_keyboard: rows };
}

function patchTelegramRequest(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();

  try {
    if (method === "sendInvoice") {
      const body = JSON.parse(init.body);
      delete body.subscription_period;
      return { ...init, body: JSON.stringify(body) };
    }

    if (!["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return init;

    if (init.body instanceof FormData) {
      const form = init.body;
      const markupText = form.get("reply_markup");
      if (typeof markupText === "string") {
        const markup = JSON.parse(markupText);
        form.set("reply_markup", JSON.stringify(addMenuButtons(markup)));
      }
      if (form.has("document")) form.set("disable_content_type_detection", "true");
      return { ...init, body: form };
    }

    const body = JSON.parse(init.body);
    if (body.reply_markup) {
      const markup = typeof body.reply_markup === "string"
        ? JSON.parse(body.reply_markup)
        : body.reply_markup;
      body.reply_markup = addMenuButtons(markup);
      return { ...init, body: JSON.stringify(body) };
    }
  } catch (error) {
    console.error("IPX LAB Telegram menu/payment patch error", error);
  }
  return init;
}

export default {
  async fetch(request, env, ctx) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const nextInit = patchTelegramRequest(input, init);
      return originalFetch(input, nextInit);
    };
    try {
      if (request.method === "POST") {
        try {
          const update = await request.clone().json();
          const callback = update?.callback_query;
          const token = env.TELEGRAM_BOT_TOKEN;
          if (callback?.id && token) {
            try {
              await originalFetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ callback_query_id: callback.id })
              });
            } catch {}

            if (AI_ACTIONS.has(callback?.data)) {
              const chatId = callback?.message?.chat?.id;
              if (chatId) {
                try {
                  await handleAiCallback(env, token, chatId, callback.data, consumeAiOperation);
                } catch (error) {
                  console.error("IPX LAB AI error", error);
                  try {
                    await originalFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        chat_id: chatId,
                        text: `❌ AI image processing error:\n\n${error?.message || "Unknown error"}`
                      })
                    });
                  } catch (reportError) {
                    console.error("IPX LAB AI error report failed", reportError);
                  }
                }
              }
              return new Response("OK", { status: 200 });
            }
          }
        } catch {}
      }
      try {
        return await currentWorker.fetch(request, env, ctx);
      } catch (error) {
        console.error("IPX LAB worker error", error);
        if (request.method === "POST" && env.TELEGRAM_BOT_TOKEN) {
          try {
            const update = await request.clone().json();
            const chatId = update?.callback_query?.message?.chat?.id || update?.message?.chat?.id;
            if (chatId) {
              await originalFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: `❌ Premium/payment error:\n\n${error?.message || "Unknown error"}`
                })
              });
            }
          } catch (reportError) {
            console.error("IPX LAB error report failed", reportError);
          }
        }
        return new Response("OK", { status: 200 });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
