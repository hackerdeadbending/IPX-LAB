import currentWorker from "./features.js";

function addMenuButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  const rows = replyMarkup.inline_keyboard.map((row) => [...row]);
  const hasFilters = rows.some((row) => row.some((button) => button.callback_data === "filters"));
  const hasPremium = rows.some((row) => row.some((button) => button.callback_data === "premium"));
  if (!hasFilters || !hasPremium) {
    rows.push([
      { text: "🎬 Filters", callback_data: "filters" },
      { text: "⭐ Buy Premium", callback_data: "premium" }
    ]);
  }
  return { ...replyMarkup, inline_keyboard: rows };
}

function patchTelegramRequest(input, init) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return init;
  const method = url.split("/").pop();
  if (!["sendMessage", "sendPhoto", "sendDocument"].includes(method)) return init;

  try {
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
    console.error("IPX LAB Telegram menu patch error", error);
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
      return await currentWorker.fetch(request, env, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
