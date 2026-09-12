const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "📐 Resize", callback_data: "resize" }, { text: "🗜️ Compress", callback_data: "compress" }],
    [{ text: "🔄 Convert", callback_data: "convert" }, { text: "✂️ Crop", callback_data: "crop" }],
    [{ text: "🛡️ Safe Share", callback_data: "safe-share" }],
    [{ text: "🧹 Remove Metadata", callback_data: "metadata" }],
    [{ text: "ℹ️ Image Info", callback_data: "info" }],
  ],
};

const RESIZE_MENU = {
  inline_keyboard: [
    [{ text: "800 px", callback_data: "resize:800" }, { text: "1200 px", callback_data: "resize:1200" }, { text: "1600 px", callback_data: "resize:1600" }],
    [{ text: "✏️ Custom size", callback_data: "resize:custom" }],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const COMPRESS_MENU = {
  inline_keyboard: [
    [{ text: "High quality", callback_data: "compress:85" }, { text: "Balanced", callback_data: "compress:70" }],
    [{ text: "Small size", callback_data: "compress:50" }],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const CONVERT_MENU = {
  inline_keyboard: [
    [{ text: "JPG", callback_data: "convert:jpeg" }, { text: "PNG", callback_data: "convert:png" }],
    [{ text: "WEBP", callback_data: "convert:webp" }, { text: "AVIF", callback_data: "convert:avif" }],
    [{ text: "GIF", callback_data: "convert:gif" }],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const CROP_MENU = {
  inline_keyboard: [
    [{ text: "1:1", callback_data: "crop:1:1" }, { text: "16:9", callback_data: "crop:16:9" }],
    [{ text: "9:16", callback_data: "crop:9:16" }, { text: "4:5", callback_data: "crop:4:5" }],
    [{ text: "↩️ Back", callback_data: "back" }],
  ],
};

const SAFE_SHARE_MENU = {
  inline_keyboard: [
    [{ text: "🧹 Remove hidden metadata", callback_data: "safe-share:metadata" }],
    [{ text: "📐 Limit long edge to 2000 px", callback_data: "safe-share:size" }],
    [{ text: "🛡️ Apply both", callback_data: "safe-share:both" }],
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
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function getSourceFileId(message) {
  if (message?.photo?.length) return message.photo[message.photo.length - 1].file_id;
  if (message?.document?.mime_type?.startsWith("image/")) return message.document.file_id;
  return null;
}

async function ensureSourceTable(env) {
  if (!env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS source_images (
    telegram_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function rememberSource(env, chatId, fileId) {
  if (!env.DB || !chatId || !fileId) return;
  await ensureSourceTable(env);
  await env.DB.prepare(`INSERT INTO source_images (telegram_id, file_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id, updated_at=CURRENT_TIMESTAMP`)
    .bind(String(chatId), fileId).run();
}

async function getRememberedSource(env, chatId) {
  if (!env.DB || !chatId) return null;
  await ensureSourceTable(env);
  const row = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id = ?")
    .bind(String(chatId)).first();
  return row?.file_id || null;
}

async function resolveSourceFileId(env, chatId, message) {
  return getSourceFileId(message) || await getRememberedSource(env, chatId);
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
  if (!response.ok || !response.body) throw new Error(`Unable to download Telegram file (${response.status})`);
  return response;
}

async function sendMainMenu(token, chatId, text = "Choose what you want to do:") {
  await telegram("sendMessage", token, { chat_id: chatId, text, reply_markup: MAIN_MENU });
}

async function sendPhotoMenu(token, chatId, fileId) {
  await telegram("sendPhoto", token, {
    chat_id: chatId,
    photo: fileId,
    caption: "📸 Photo received\n\nChoose an operation:",
    reply_markup: MAIN_MENU,
  });
}

async function sendTransformedFile(token, chatId, response, filename, caption) {
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new File([bytes], filename, { type: contentType }));
  form.append("caption", caption);
  const result = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  const data = await result.json();
  if (!data.ok) throw new Error(data.description || "Telegram upload failed");
  return data.result;
}

function conversion(action) {
  const formats = {
    "convert:jpeg": ["image/jpeg", "jpg"],
    "convert:png": ["image/png", "png"],
    "convert:webp": ["image/webp", "webp"],
    "convert:avif": ["image/avif", "avif"],
    "convert:gif": ["image/gif", "gif"],
  };
  return formats[action] || null;
}

async function transformImage(env, token, chatId, fileId, action) {
  const source = await getTelegramFile(token, fileId);
  if (!env.IMAGES) throw new Error("Cloudflare Images binding is not configured");

  if (action === "info") {
    const info = await env.IMAGES.info(source.body);
    const width = info?.width ?? "unknown";
    const height = info?.height ?? "unknown";
    const size = info?.fileSize ? formatBytes(info.fileSize) : "unknown";
    const format = info?.format || "unknown";
    const mp = Number.isFinite(info?.width) && Number.isFinite(info?.height)
      ? ((info.width * info.height) / 1000000).toFixed(2) : "unknown";
    await telegram("sendMessage", token, {
      chat_id: chatId,
      text: `ℹ️ Image Info\n\nResolution: ${width} × ${height}\nFormat: ${format}\nSize: ${size}\nMegapixels: ${mp} MP`,
      reply_markup: MAIN_MENU,
    });
    return;
  }

  let transform = { fit: "scale-down" };
  let outputFormat = "image/jpeg";
  let quality = 88;
  let filename = null;
  let caption = null;

  if (action === "metadata") {
    transform = { fit: "scale-down", metadata: "none" };
    quality = 100;
    filename = "ipx-lab-metadata-removed.jpg";
    caption = "✅ Metadata removed";
  } else if (action === "safe-share:metadata") {
    transform = { fit: "scale-down", metadata: "none" };
    quality = 100;
    filename = "ipx-lab-safe-share-metadata.jpg";
    caption = "🛡️ Safe Share ready\n\n✓ Hidden metadata removed\n✓ GPS/EXIF removed\n✓ Visible content was not blurred or hidden.";
  } else if (action === "safe-share:size") {
    transform = { width: 2000, fit: "scale-down" };
    quality = 90;
    filename = "ipx-lab-safe-share-2000px.jpg";
    caption = "🛡️ Safe Share copy ready\n\n✓ Long edge limited to 2000 px";
  } else if (action === "safe-share:both") {
    transform = { width: 2000, fit: "scale-down", metadata: "none" };
    quality = 90;
    filename = "ipx-lab-safe-share.jpg";
    caption = "🛡️ Safe Share ready\n\n✓ Hidden metadata removed\n✓ Long edge limited to 2000 px";
  } else if (action.startsWith("resize:")) {
    const parts = action.split(":");
    const width = Number(parts[1]);
    const height = parts[2] ? Number(parts[2]) : null;
    if (!Number.isInteger(width) || width < 50 || width > 10000) throw new Error("Invalid resize width");
    if (height !== null && (!Number.isInteger(height) || height < 50 || height > 10000)) throw new Error("Invalid resize height");
    transform = height === null ? { width, fit: "scale-down" } : { width, height, fit: "fill" };
    filename = height ? `ipx-lab-resize-${width}x${height}.jpg` : `ipx-lab-resize-${width}.jpg`;
    caption = `📐 Resize complete\n\n${width}${height ? ` × ${height}` : " px wide"}`;
  } else if (action.startsWith("compress:")) {
    quality = Number(action.split(":")[1]);
    if (![50, 70, 85].includes(quality)) throw new Error("Invalid compression quality");
    filename = `ipx-lab-compressed-${quality}.jpg`;
    caption = `🗜️ Compression complete\n\nQuality: ${quality}%`;
  } else if (conversion(action)) {
    [outputFormat] = conversion(action);
    const [, ext] = conversion(action);
    quality = outputFormat === "image/png" || outputFormat === "image/gif" ? undefined : 88;
    filename = `ipx-lab-converted.${ext}`;
    caption = `🔄 Conversion complete\n\nFormat: ${ext.toUpperCase()}`;
  } else if (action.startsWith("crop:")) {
    const [, ratioW, ratioH] = action.split(":");
    const w = Number(ratioW); const h = Number(ratioH);
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error("Invalid crop ratio");
    const base = 1200;
    const width = w >= h ? base : Math.round(base * w / h);
    const height = w >= h ? Math.round(base * h / w) : base;
    transform = { width, height, fit: "cover" };
    filename = `ipx-lab-crop-${ratioW}x${ratioH}.jpg`;
    caption = `✂️ Crop complete\n\nRatio: ${ratioW}:${ratioH}`;
  } else {
    throw new Error("Unknown image action");
  }

  const pipeline = env.IMAGES.input(source.body).transform(transform);
  const output = await pipeline.output({ format: outputFormat, ...(quality !== undefined ? { quality } : {}) });
  const response = output.response();
  if (!response.ok) throw new Error(`Image transformation failed (${response.status})`);

  const sent = await sendTransformedFile(token, chatId, response, filename, caption);
  const nextFileId = sent?.document?.file_id || sent?.photo?.[sent.photo.length - 1]?.file_id;
  if (!nextFileId) throw new Error("Telegram did not return the transformed file_id");
  await rememberSource(env, chatId, nextFileId);
  await sendMainMenu(token, chatId, "Ready for another operation:");
}

function parseCustomResize(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/,/g, ".").replace(/[×]/g, "x");
  const match = raw.match(/^(\d{2,5})(?:\s*(?:x|\s)\s*(\d{2,5}))?$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = match[2] ? Number(match[2]) : null;
  if (width < 50 || width > 10000 || (height !== null && (height < 50 || height > 10000))) return null;
  return { width, height };
}

async function handleCustomResize(env, token, chatId, text, replyToMessage = null) {
  const size = parseCustomResize(text);
  if (!size) return false;
  const fileId = getSourceFileId(replyToMessage) || await getRememberedSource(env, chatId);
  if (!fileId) throw new Error("Current photo is no longer available. Please send the photo again.");
  const action = size.height === null ? `resize:${size.width}` : `resize:${size.width}:${size.height}`;
  await telegram("sendMessage", token, { chat_id: chatId, text: `⏳ Resizing to ${size.width}${size.height ? ` × ${size.height}` : " px wide"}...` });
  await transformImage(env, token, chatId, fileId, action);
  return true;
}

async function showMenu(token, chatId, message, replyMarkup, fallbackText) {
  if (message?.message_id) {
    try {
      await telegram("editMessageReplyMarkup", token, {
        chat_id: chatId,
        message_id: message.message_id,
        reply_markup: replyMarkup,
      });
      return;
    } catch (error) {
      console.error("IPX LAB menu edit error", error);
    }
  }
  await telegram("sendMessage", token, { chat_id: chatId, text: fallbackText, reply_markup: replyMarkup });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return textResponse("IPX LAB Photo is online.");
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return textResponse("Missing TELEGRAM_BOT_TOKEN", 500);

    let update;
    try { update = await request.json(); } catch { return textResponse("Invalid JSON", 400); }

    try {
      if (update.message) {
        const chatId = update.message.chat?.id;
        if (!chatId) return textResponse("OK");
        const fileId = getSourceFileId(update.message);

        if (fileId) {
          await rememberSource(env, chatId, fileId);
          await sendPhotoMenu(token, chatId, fileId);
        } else if (typeof update.message.text === "string") {
          const text = update.message.text.trim();
          if (text === "/start" || text === "/help") {
            await telegram("sendMessage", token, { chat_id: chatId, text: "👋 Welcome to IPX LAB Photo!\n\n📸 Send me a photo and your editing tools will appear automatically." });
          } else if (parseCustomResize(text)) {
            const handled = await handleCustomResize(env, token, chatId, text, update.message.reply_to_message);
            if (!handled) await telegram("sendMessage", token, { chat_id: chatId, text: "📸 Send me a photo first." });
          } else {
            await telegram("sendMessage", token, { chat_id: chatId, text: "📸 Send me a photo first. Your editing tools will appear after you upload it." });
          }
        }
      }

      if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message?.chat?.id;
        const action = query.data || "";
        await telegram("answerCallbackQuery", token, { callback_query_id: query.id });
        if (!chatId) return textResponse("OK");

        const fileId = await resolveSourceFileId(env, chatId, query.message);

        if (action === "back") {
          await showMenu(token, chatId, query.message, MAIN_MENU, "Choose an operation:");
        } else if (action === "resize") {
          await showMenu(token, chatId, query.message, RESIZE_MENU, "📐 Choose the maximum width or custom size:");
        } else if (action === "resize:custom") {
          if (!fileId) throw new Error("Please send a photo first");
          await telegram("sendMessage", token, {
            chat_id: chatId,
            text: "✏️ Enter the size.\n\nExamples: 1920x1080, 1080x1920, 1500x1500 or 1500\n\nYou can also enter: 50 50 or 50 x 50\n\nMinimum: 50 px · Maximum: 10000 px",
            reply_parameters: { message_id: query.message.message_id },
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "50x50 or 1500",
            },
          });
        } else if (action === "compress") {
          await showMenu(token, chatId, query.message, COMPRESS_MENU, "🗜️ Choose compression strength:");
        } else if (action === "convert") {
          await showMenu(token, chatId, query.message, CONVERT_MENU, "🔄 Choose the output format:");
        } else if (action === "crop") {
          await showMenu(token, chatId, query.message, CROP_MENU, "✂️ Choose a crop ratio:");
        } else if (action === "safe-share") {
          if (!fileId) throw new Error("Please send a photo first");
          await showMenu(token, chatId, query.message, SAFE_SHARE_MENU, "🛡️ Safe Share");
        } else if (action === "metadata") {
          if (!fileId) throw new Error("Please send a photo first");
          await transformImage(env, token, chatId, fileId, action);
        } else if (["safe-share:metadata", "safe-share:size", "safe-share:both", "info"].includes(action)) {
          if (!fileId) throw new Error("Please send a photo first");
          await transformImage(env, token, chatId, fileId, action);
        } else if (action.startsWith("resize:") || action.startsWith("compress:") || action.startsWith("convert:") || action.startsWith("crop:")) {
          if (!fileId) throw new Error("Please send a photo first");
          await transformImage(env, token, chatId, fileId, action);
        }
      }

      return textResponse("OK");
    } catch (error) {
      console.error("IPX LAB error", error);
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) await telegram("sendMessage", token, { chat_id: chatId, text: `⚠️ I couldn't process that image.\n\n${error.message || "Something went wrong."}` });
      return textResponse("OK");
    }
  },
};