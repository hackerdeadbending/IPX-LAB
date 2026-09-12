import baseWorker from "./index.js";
import { consumeOperation, registerUser } from "./db.js";

const OPERATION_ACTIONS = new Set([
  "metadata",
  "info",
  "safe-share:metadata",
  "safe-share:size",
  "safe-share:both",
]);

const chatLanguages = new Map();

const RU_BUTTONS = new Map([
  ["📐 Resize", "📐 Изменить размер"],
  ["🗜️ Compress", "🗜️ Сжать"],
  ["🔄 Convert", "🔄 Конвертировать"],
  ["✂️ Crop", "✂️ Обрезать"],
  ["🛡️ Safe Share", "🛡️ Безопасный обмен"],
  ["🧹 Remove Metadata", "🧹 Удалить метаданные"],
  ["ℹ️ Image Info", "ℹ️ Информация об изображении"],
  ["✏️ Custom size", "✏️ Свой размер"],
  ["↩️ Back", "↩️ Назад"],
  ["High quality", "Высокое качество"],
  ["Balanced", "Баланс"],
  ["Small size", "Маленький размер"],
  ["🧹 Remove hidden metadata", "🧹 Удалить скрытые метаданные"],
  ["📐 Limit long edge to 2000 px", "📐 Ограничить длинную сторону до 2000 px"],
  ["🛡️ Apply both", "🛡️ Применить оба"],
]);

const RU_TEXT = [
  ["Choose what you want to do:", "Выберите действие:"],
  ["📸 Photo received\n\nChoose an operation:", "📸 Фото получено\n\nВыберите действие:"],
  ["👋 Welcome to IPX LAB Photo!\n\nSend me a photo and choose an operation.", "👋 Добро пожаловать в IPX LAB Photo!\n\nОтправьте мне фото и выберите действие."],
  ["Ready for another operation:", "Готово. Выберите следующее действие:"],
  ["❌ Invalid size.\n\nUse for example:\n• 1920x1080 — exact width × height\n• 1500 — custom width, height keeps the original proportion\n\nEnter a size from 50 to 10000 px.", "❌ Неверный размер.\n\nНапример:\n• 1920x1080 — точная ширина × высота\n• 1500 — своя ширина, высота сохраняет исходные пропорции\n\nВведите размер от 50 до 10000 px."],
  ["Metadata removed", "Метаданные удалены"],
  ["Image Info", "Информация об изображении"],
  ["Resolution:", "Разрешение:"],
  ["Format:", "Формат:"],
  ["Size:", "Размер:"],
  ["Megapixels:", "Мегапикселей:"],
  ["Safe Share ready", "Безопасная копия готова"],
  ["Safe Share copy ready", "Безопасная копия готова"],
  ["✓ Hidden metadata removed", "✓ Скрытые метаданные удалены"],
  ["✓ GPS/EXIF removed", "✓ GPS/EXIF удалены"],
  ["✓ Long edge limited to 2000 px", "✓ Длинная сторона ограничена 2000 px"],
  ["✓ Visible faces, plates, QR codes and text were left untouched", "✓ Лица, номера, QR-коды и видимый текст не изменялись"],
  ["✓ No visible privacy items were changed", "✓ Видимые элементы приватности не изменялись"],
  ["✓ Hidden metadata was not intentionally removed", "✓ Скрытые метаданные намеренно не удалялись"],
  ["Your original photo was not modified.", "Ваше исходное фото не изменялось."],
  ["⏳ Resizing to ", "⏳ Изменение размера до "],
  [" px wide...", " px по ширине..."],
  [" complete", " завершено"],
];

function normalizeLanguage(language) {
  const code = String(language || "en").toLowerCase().split(/[-_]/)[0];
  return code === "ru" ? "ru" : "en";
}

function languageForUpdate(update) {
  return normalizeLanguage(update?.message?.from?.language_code || update?.callback_query?.from?.language_code);
}

function translateText(text, language) {
  if (language !== "ru" || typeof text !== "string") return text;
  let result = text;
  for (const [from, to] of RU_TEXT) result = result.split(from).join(to);
  return result;
}

function translateReplyMarkup(replyMarkup, language) {
  if (language !== "ru" || !replyMarkup?.inline_keyboard) return replyMarkup;
  return {
    ...replyMarkup,
    inline_keyboard: replyMarkup.inline_keyboard.map((row) => row.map((button) => ({
      ...button,
      text: RU_BUTTONS.get(button.text) || button.text,
    }))),
  };
}

async function localizedFetch(input, init, originalFetch) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot")) {
    return originalFetch(input, init);
  }

  const method = url.split("/").pop();
  const language = chatLanguages.get("__last__") || "en";
  let nextInit = init;

  if (init?.body && method === "sendMessage") {
    try {
      const body = JSON.parse(init.body);
      const chatId = String(body.chat_id);
      const userLanguage = chatLanguages.get(chatId) || language;
      body.text = translateText(body.text, userLanguage);
      body.reply_markup = translateReplyMarkup(body.reply_markup, userLanguage);
      nextInit = { ...init, body: JSON.stringify(body) };
    } catch {
      nextInit = init;
    }
  } else if (init?.body && method === "sendPhoto") {
    try {
      const body = JSON.parse(init.body);
      const chatId = String(body.chat_id);
      const userLanguage = chatLanguages.get(chatId) || language;
      body.caption = translateText(body.caption, userLanguage);
      body.reply_markup = translateReplyMarkup(body.reply_markup, userLanguage);
      nextInit = { ...init, body: JSON.stringify(body) };
    } catch {
      nextInit = init;
    }
  } else if (init?.body instanceof FormData && method === "sendDocument") {
    const chatId = String(init.body.get("chat_id") || "");
    const userLanguage = chatLanguages.get(chatId) || language;
    const form = new FormData();
    for (const [key, value] of init.body.entries()) {
      form.append(key, key === "caption" ? translateText(value, userLanguage) : value);
    }
    nextInit = { ...init, body: form };
  }

  return originalFetch(input, nextInit);
}

function isImageOperation(action) {
  if (OPERATION_ACTIONS.has(action)) return true;
  return /^(resize|compress|convert|crop):/.test(action);
}

function isCustomResizeText(text) {
  return /^(\d{2,5})(?:x(\d{2,5}))?$/.test(String(text || "").trim().toLowerCase().replace(/\s+/g, ""));
}

function getSourceFileId(message) {
  if (message?.photo?.length) return message.photo[message.photo.length - 1].file_id;
  if (message?.document?.mime_type?.startsWith("image/")) return message.document.file_id;
  return null;
}

async function ensureSourceTable(env) {
  if (!env.DB) return false;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS source_images (
      telegram_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
  return true;
}

async function rememberSourceImage(env, update) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const fileId = getSourceFileId(message);
  if (!chatId || !fileId || !(await ensureSourceTable(env))) return;

  await env.DB.prepare(
    `INSERT INTO source_images (telegram_id, file_id, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       file_id = excluded.file_id,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(String(chatId), fileId).run();
}

async function getRememberedSource(env, chatId) {
  if (!chatId || !(await ensureSourceTable(env))) return null;
  const row = await env.DB.prepare(
    "SELECT file_id FROM source_images WHERE telegram_id = ?"
  ).bind(String(chatId)).first();
  return row?.file_id || null;
}

async function hydrateCallbackSource(env, update) {
  const callback = update?.callback_query;
  const chatId = callback?.message?.chat?.id;
  if (!chatId) return;

  const existing = getSourceFileId(callback.message);
  if (existing) return;

  const fileId = await getRememberedSource(env, chatId);
  if (!fileId) return;

  update.callback_query.message = {
    ...callback.message,
    photo: [{ file_id: fileId }],
  };
}

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

async function enforceOperationLimit(request, env, update) {
  const message = update?.message;
  const callback = update?.callback_query;
  const chatId = message?.chat?.id || callback?.message?.chat?.id;
  const from = message?.from || callback?.from;

  if (!chatId) return true;

  const language = normalizeLanguage(from?.language_code);
  const chatKey = String(chatId);
  chatLanguages.set(chatKey, language);
  chatLanguages.set("__last__", language);

  try {
    await registerUser(env, chatId, {
      username: from?.username,
      first_name: from?.first_name,
      language,
    });

    let action = null;
    if (callback?.data && isImageOperation(callback.data)) {
      action = callback.data;
    } else if (message?.text && isCustomResizeText(message.text)) {
      action = "resize:custom";
    }

    if (!action) return true;

    const result = await consumeOperation(env, chatId, action, {
      username: from?.username,
      first_name: from?.first_name,
      language,
    });

    if (result.allowed) return true;

    const token = env.TELEGRAM_BOT_TOKEN;
    if (token) {
      const text = language === "ru"
        ? `🚫 Дневной лимит исчерпан.\n\nБесплатный план: ${result.limit} операций с изображениями в день.\nИспользовано: ${result.used}/${result.limit}.\n\nPremium даёт до 1000 операций в день.`
        : `🚫 Daily limit reached.\n\nFree plan: ${result.limit} image operations per day.\nYou have used ${result.used}/${result.limit}.\n\nPremium gives you 1000 operations per day.`;
      await telegram("sendMessage", token, { chat_id: chatId, text });
    }
    return false;
  } catch (error) {
    console.error("IPX LAB D1 error", error);
    return true;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return baseWorker.fetch(request, env, ctx);

    const cloned = request.clone();
    let update;
    try {
      update = await cloned.json();
    } catch {
      return baseWorker.fetch(request, env, ctx);
    }

    try {
      await rememberSourceImage(env, update);
      await hydrateCallbackSource(env, update);
    } catch (error) {
      console.error("IPX LAB source image D1 error", error);
    }

    const allowed = await enforceOperationLimit(request, env, update);
    if (!allowed) return new Response("OK", { status: 200 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => localizedFetch(input, init, originalFetch);
    try {
      return await baseWorker.fetch(
        new Request(request, { body: JSON.stringify(update) }),
        env,
        ctx,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
