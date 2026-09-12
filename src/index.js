const MENU = {
  inline_keyboard: [
    [
      { text: "📐 Resize", callback_data: "resize" },
      { text: "🗜️ Compress", callback_data: "compress" },
    ],
    [
      { text: "🔄 Convert", callback_data: "convert" },
      { text: "✂️ Crop", callback_data: "crop" },
    ],
    [{ text: "ℹ️ Image Info", callback_data: "info" }],
  ],
};

async function telegram(method, token, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function response(text) {
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return response("IPX LAB Photo is online.");
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return response("Missing TELEGRAM_BOT_TOKEN");

    let update;
    try {
      update = await request.json();
    } catch {
      return response("Invalid JSON");
    }

    if (update.message) {
      const chatId = update.message.chat?.id;
      if (!chatId) return response("OK");

      if (update.message.photo || update.message.document) {
        await telegram("sendMessage", token, {
          chat_id: chatId,
          text: "📸 Photo received!\n\nChoose what you want to do:",
          reply_markup: MENU,
        });
      } else {
        await telegram("sendMessage", token, {
          chat_id: chatId,
          text: "👋 Welcome to IPX LAB Photo!\n\nSend me a photo and I'll help you resize, compress, convert, crop, or inspect it.",
          reply_markup: MENU,
        });
      }
    }

    if (update.callback_query) {
      const query = update.callback_query;
      const chatId = query.message?.chat?.id;
      const action = query.data;

      await telegram("answerCallbackQuery", token, {
        callback_query_id: query.id,
      });

      const labels = {
        resize: "📐 Resize — choose a target size or custom dimensions.",
        compress: "🗜️ Compress — reduce the file size while keeping good quality.",
        convert: "🔄 Convert — JPG, PNG and WEBP conversion.",
        crop: "✂️ Crop — square, 16:9, 9:16, 4:5 or custom crop.",
        info: "ℹ️ Image Info — resolution, format, file size and megapixels.",
      };

      if (chatId && labels[action]) {
        await telegram("sendMessage", token, {
          chat_id: chatId,
          text: labels[action] + "\n\n🚧 This tool is being connected now.",
          reply_markup: MENU,
        });
      }
    }

    return response("OK");
  },
};
