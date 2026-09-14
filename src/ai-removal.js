const AI_ACTIONS = new Set(["ai:watermark", "ai:text"]);

function telegramUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegram(token, method, body) {
  const response = await fetch(telegramUrl(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `${method} failed`);
  return data.result;
}

function getFileId(message) {
  if (message?.photo?.length) return message.photo.at(-1).file_id;
  if (message?.document?.mime_type?.toLowerCase?.().startsWith("image/")) return message.document.file_id;
  return null;
}

export function isAiAction(action) {
  return AI_ACTIONS.has(action);
}

export function addAiButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return replyMarkup;
  const rows = replyMarkup.inline_keyboard.map((row) => [...row]);
  const hasWatermark = rows.some((row) => row.some((button) => button.callback_data === "ai:watermark"));
  const hasText = rows.some((row) => row.some((button) => button.callback_data === "ai:text"));
  if (!hasWatermark || !hasText) {
    rows.push([
      { text: "🧹 Delete Watermark", callback_data: "ai:watermark" },
      { text: "📝 Delete Text", callback_data: "ai:text" },
    ]);
  }
  return { ...replyMarkup, inline_keyboard: rows };
}

export async function handleAiAction(env, callbackQuery) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = callbackQuery?.message?.chat?.id;
  const action = callbackQuery?.data;
  if (!token || !chatId || !isAiAction(action)) return false;

  const apiUrl = String(env.AI_REMOVAL_API_URL || "").replace(/\/$/, "");
  const apiKey = String(env.AI_REMOVAL_API_KEY || "");
  if (!apiUrl) {
    await telegram(token, "sendMessage", { chat_id: chatId, text: "⚠️ AI removal service is not configured yet." });
    return true;
  }

  const fileId = getFileId(callbackQuery.message);
  if (!fileId) {
    await telegram(token, "sendMessage", { chat_id: chatId, text: "📸 Please send an image first." });
    return true;
  }

  await telegram(token, "answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text: "⏳ Processing image…",
  });
  const status = await telegram(token, "sendMessage", {
    chat_id: chatId,
    text: action === "ai:watermark" ? "🧹 Removing watermark…" : "📝 Removing text…",
  });

  try {
    const file = await telegram(token, "getFile", { file_id: fileId });
    const sourceResponse = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!sourceResponse.ok) throw new Error("Unable to download the source image from Telegram");
    const sourceBytes = await sourceResponse.arrayBuffer();

    const form = new FormData();
    form.append("image", new File([sourceBytes], "source.jpg", { type: "image/jpeg" }));
    form.append("mode", action === "ai:watermark" ? "watermark" : "text");

    const apiResponse = await fetch(`${apiUrl}/v1/remove`, {
      method: "POST",
      headers: apiKey ? { "X-API-Key": apiKey } : {},
      body: form,
    });

    if (!apiResponse.ok) {
      const detail = await apiResponse.text();
      throw new Error(`AI service returned ${apiResponse.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    const output = await apiResponse.arrayBuffer();
    const resultForm = new FormData();
    resultForm.append("chat_id", String(chatId));
    resultForm.append("document", new File([output], action === "ai:watermark" ? "ipx-no-watermark.png" : "ipx-no-text.png", { type: "image/png" }));
    resultForm.append("caption", action === "ai:watermark" ? "🧹 Watermark removed." : "📝 Text removed.");
    resultForm.append("reply_markup", JSON.stringify({
      inline_keyboard: [[
        { text: "🧹 Delete Watermark", callback_data: "ai:watermark" },
        { text: "📝 Delete Text", callback_data: "ai:text" },
      ]],
    }));

    const sendResponse = await fetch(telegramUrl(token, "sendDocument"), { method: "POST", body: resultForm });
    const sendData = await sendResponse.json();
    if (!sendData.ok) throw new Error(sendData.description || "Unable to send processed image");
  } catch (error) {
    await telegram(token, "sendMessage", {
      chat_id: chatId,
      text: `❌ AI processing failed.\n\n${error?.message || "Unknown error"}`,
    });
  } finally {
    try { await telegram(token, "deleteMessage", { chat_id: chatId, message_id: status.message_id }); } catch (_) {}
  }
  return true;
}
