import baseWorker from "./index.js";
import { consumeOperation, registerUser } from "./db.js";

const OPERATION_ACTIONS = new Set([
  "metadata",
  "info",
  "safe-share:metadata",
  "safe-share:size",
  "safe-share:both",
]);

function isImageOperation(action) {
  if (OPERATION_ACTIONS.has(action)) return true;
  return /^(resize|compress|convert|crop):/.test(action);
}

function isCustomResizeText(text) {
  return /^(\d{2,5})(?:x(\d{2,5}))?$/.test(String(text || "").trim().toLowerCase().replace(/\s+/g, ""));
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

  try {
    await registerUser(env, chatId, {
      username: from?.username,
      first_name: from?.first_name,
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
    });

    if (result.allowed) return true;

    const token = env.TELEGRAM_BOT_TOKEN;
    if (token) {
      await telegram("sendMessage", token, {
        chat_id: chatId,
        text: `🚫 Daily limit reached.\n\nFree plan: ${result.limit} image operations per day.\nYou have used ${result.used}/${result.limit}.\n\nPremium gives you ${1000} operations per day.`,
      });
    }
    return false;
  } catch (error) {
    // A database problem must not take the image bot offline.
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

    const allowed = await enforceOperationLimit(request, env, update);
    if (!allowed) return new Response("OK", { status: 200 });

    return baseWorker.fetch(request, env, ctx);
  },
};
