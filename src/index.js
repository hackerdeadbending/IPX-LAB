const MAIN_MENU = {
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

const RESIZE_MENU = {
  inline_keyboard: [
    [
      { text: "800 px", callback_data: "resize:800" },
      { text: "1200 px", callback_data: "resize:1200" },
      { text: "1600 px", callback_data: "resize:1600" },
    ],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const COMPRESS_MENU = {
  inline_keyboard: [
    [
      { text: "High quality", callback_data: "compress:85" },
      { text: "Balanced", callback_data: "compress:70" },
    ],
    [{ text: "Small size", callback_data: "compress:50" }],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const CONVERT_MENU = {
  inline_keyboard: [
    [
      { text: "JPG", callback_data: "convert:jpeg" },
      { text: "PNG", callback_data: "convert:png" },
      { text: "WEBP", callback_data: "convert:webp" },
    ],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const CROP_MENU = {
  inline_keyboard: [
    [
      { text: "1:1", callback_data: "crop:1:1" },
      { text: "16:9", callback_data: "crop:16:9" },
    ],
    [
      { text: "9:16", callback_data: "crop:9:16" },
      { text: "4:5", callback_data: "crop:4:5" },
    ],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

async function telegram(method, token, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function getSourceFileId(message) {
  if (message?.photo?.length) {
    return message.photo[message.photo.length - 1].file_id;
  }
  if (message?.document?.mime_type?.startsWith("image/")) {
    return message.document.file_id;
  }
  return null;
}

function getOutputFormat(action) {
  if (action === "convert:jpeg") return "image/jpeg";
  if (action === "convert:png") return "image/png";
  if (action === "convert:webp") return "image/webp";
  return "image/jpeg";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function getTelegramFile(token, fileId) {
  const file = await telegram("getFile", token, { file_id: fileId });
  if (!file?.file_path) throw new Error("Telegram did not return a file path");

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download Telegram file (${response.status})`);
  }
  return response;
}

async function sendMainMenu(token, chatId, text = "Choose what you want to do:") {
  await telegram("sendMessage", token, {
    chat_id: chatId,
    text,
    reply_markup: MAIN_MENU,
  });
}

async function sendPhotoMenu(token, chatId, fileId) {
  // Re-send the original Telegram photo so callback queries contain the photo itself.
  await telegram("sendPhoto", token, {
    chat_id: chatId,
    photo: fileId,
    caption: "📸 Photo received\n\nChoose an operation:",
    reply_markup: MAIN_MENU,
  });
}

async function sendTransformedFile(token, chatId, resultResponse, filename, caption) {
  const bytes = await resultResponse.arrayBuffer();
  const contentType = resultResponse.headers.get("content-type") || "image/jpeg";

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new File([bytes], filename, { type: contentType }));
  form.append("caption", caption);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });

  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram upload failed");
}

async function transformImage(env, token, chatId, fileId, action) {
  const source = await getTelegramFile(token, fileId);

  if (!env.IMAGES) {
    throw new Error("Cloudflare Images binding is not configured yet");
  }

  if (action === "info") {
    const info = await env.IMAGES.info(source.body);
    const width = info?.width ?? "unknown";
    const height = info?.height ?? "unknown";
    const size = info?.fileSize ? formatBytes(info.fileSize) : "unknown";
    const format = info?.format || "unknown";
    const megapixels = Number.isFinite(info?.width) && Number.isFinite(info?.height)
      ? ((info.width * info.height) / 1_000_000).toFixed(2)
      : "unknown";

    await telegram("sendMessage", token, {
      chat_id: chatId,
      text: `ℹ️ Image Info\n\nResolution: ${width} × ${height}\nFormat: ${format}\nSize: ${size}\nMegapixels: ${megapixels} MP`,
      reply_markup: MAIN_MENU,
    });
    return;
  }

  let operation = action;
  let outputFormat = "image/jpeg";
  let quality = 85;
  let transform = { fit: "scale-down" };

  if (action.startsWith("resize:")) {
    const width = Number(action.split(":")[1]);
    if (!Number.isInteger(width) || width < 50 || width > 10000) throw new Error("Invalid resize width");
    transform = { width, fit: "scale-down" };
    outputFormat = "image/jpeg";
    quality = 88;
  } else if (action.startsWith("compress:")) {
    quality = Number(action.split(":")[1]);
    if (![50, 70, 85].includes(quality)) throw new Error("Invalid compression quality");
    transform = { fit: "scale-down" };
    outputFormat = "image/jpeg";
  } else if (action.startsWith("convert:")) {
    outputFormat = getOutputFormat(action);
    transform = { fit: "scale-down" };
    quality = outputFormat === "image/png" ? undefined : 88;
  } else if (action.startsWith("crop:")) {
    const [, ratioW, ratioH] = action.split(":");
    const w = Number(ratioW);
    const h = Number(ratioH);
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error("Invalid crop ratio");

    // A practical preset crop: use a fixed long edge and cover the requested ratio.
    const base = 1200;
    const width = w >= h ? base : Math.round(base * (w / h));
    const height = w >= h ? Math.round(base * (h / w)) : base;
    transform = { width, height, fit: "cover" };
    outputFormat = "image/jpeg";
    quality = 88;
  } else {
    throw new Error(`Unknown image action: ${operation}`);
  }

  let image = env.IMAGES.input(source.body).transform(transform);
  const outputOptions = { format: outputFormat };
  if (quality !== undefined) outputOptions.quality = quality;

  const transformed = await image.output(outputOptions);
  const response = transformed.response();
  if (!response.ok) throw new Error(`Image transformation failed (${response.status})`);

  const extension = outputFormat === "image/png" ? "png" : outputFormat === "image/webp" ? "webp" : "jpg";
  const label = operation.split(":")[0];
  await sendTransformedFile(
    token,
    chatId,
    response,
    `ipx-lab-${label}.${extension}`,
    `✅ ${label.charAt(0).toUpperCase() + label.slice(1)} complete`,
  );

  await sendMainMenu(token, chatId, "Ready for another operation:");
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return textResponse("IPX LAB Photo is online.");
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return textResponse("Missing TELEGRAM_BOT_TOKEN", 500);

    let update;
    try {
      update = await request.json();
    } catch {
      return textResponse("Invalid JSON", 400);
    }

    try {
      if (update.message) {
        const chatId = update.message.chat?.id;
        if (!chatId) return textResponse("OK");

        const fileId = getSourceFileId(update.message);
        if (fileId) {
          await sendPhotoMenu(token, chatId, fileId);
        } else {
          await telegram("sendMessage", token, {
            chat_id: chatId,
            text: "👋 Welcome to IPX LAB Photo!\n\nSend me a photo and choose an operation.",
            reply_markup: MAIN_MENU,
          });
        }
      }

      if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message?.chat?.id;
        const action = query.data || "";
        const fileId = getSourceFileId(query.message);

        await telegram("answerCallbackQuery", token, { callback_query_id: query.id });
        if (!chatId) return textResponse("OK");

        if (action === "back") {
          await telegram("sendMessage", token, {
            chat_id: chatId,
            text: "Choose an operation:",
            reply_markup: MAIN_MENU,
          });
          return textResponse("OK");
        }

        if (action === "resize") {
          await telegram("sendMessage", token, { chat_id: chatId, text: "📐 Choose the maximum width:", reply_markup: RESIZE_MENU });
        } else if (action === "compress") {
          await telegram("sendMessage", token, { chat_id: chatId, text: "🗜️ Choose compression strength:", reply_markup: COMPRESS_MENU });
        } else if (action === "convert") {
          await telegram("sendMessage", token, { chat_id: chatId, text: "🔄 Choose the output format:", reply_markup: CONVERT_MENU });
        } else if (action === "crop") {
          await telegram("sendMessage", token, { chat_id: chatId, text: "✂️ Choose a crop ratio:", reply_markup: CROP_MENU });
        } else if (action === "info") {
          if (!fileId) throw new Error("The source image is no longer available in this menu");
          await transformImage(env, token, chatId, fileId, "info");
        } else if (/^(resize|compress|convert|crop):/.test(action)) {
          if (!fileId) throw new Error("The source image is no longer available in this menu");
          await telegram("sendMessage", token, { chat_id: chatId, text: "⏳ Processing your image..." });
          await transformImage(env, token, chatId, fileId, action);
        }
      }
    } catch (error) {
      console.error("IPX LAB error", error);
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) {
        await telegram("sendMessage", token, {
          chat_id: chatId,
          text: `⚠️ I couldn't process that image.\n\n${error instanceof Error ? error.message : "Unknown error"}`,
          reply_markup: MAIN_MENU,
        }).catch(() => {});
      }
    }

    return textResponse("OK");
  },
};
