const FREE_DAILY_LIMIT = 10;
const PREMIUM_DAILY_LIMIT = 1000;

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function getLimit(chatId, env) {
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  if (adminId && String(chatId) === adminId) return Number.POSITIVE_INFINITY;
  return PREMIUM_DAILY_LIMIT;
}

async function ensureUser(db, chatId) {
  await db.prepare(
    "INSERT INTO users (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING",
  ).bind(String(chatId)).run();
}

export async function consumeOperation(env, chatId) {
  if (!env.DB) throw new Error("Daily limits require the Cloudflare D1 DB binding");

  const id = String(chatId);
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  if (adminId && id === adminId) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY, premium: false, admin: true };
  }

  await ensureUser(env.DB, id);
  const user = await env.DB.prepare("SELECT premium FROM users WHERE chat_id = ?").bind(id).first();
  const premium = Number(user?.premium) === 1;
  const limit = premium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const date = utcDate();

  const row = await env.DB.prepare(
    "SELECT operations FROM daily_usage WHERE chat_id = ? AND usage_date = ?",
  ).bind(id, date).first();
  const used = Number(row?.operations || 0);

  if (used >= limit) {
    return { allowed: false, remaining: 0, limit, used, premium, admin: false };
  }

  await env.DB.prepare(
    "INSERT INTO daily_usage (chat_id, usage_date, operations) VALUES (?, ?, 1) ON CONFLICT(chat_id, usage_date) DO UPDATE SET operations = operations + 1",
  ).bind(id, date).run();

  return { allowed: true, remaining: limit - used - 1, limit, used: used + 1, premium, admin: false };
}

export async function getUsage(env, chatId) {
  if (!env.DB) throw new Error("Daily limits require the Cloudflare D1 DB binding");
  const id = String(chatId);
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  if (adminId && id === adminId) return { used: 0, remaining: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY, premium: false, admin: true };

  await ensureUser(env.DB, id);
  const user = await env.DB.prepare("SELECT premium FROM users WHERE chat_id = ?").bind(id).first();
  const premium = Number(user?.premium) === 1;
  const limit = premium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const row = await env.DB.prepare(
    "SELECT operations FROM daily_usage WHERE chat_id = ? AND usage_date = ?",
  ).bind(id, utcDate()).first();
  const used = Number(row?.operations || 0);
  return { used, remaining: Math.max(0, limit - used), limit, premium, admin: false };
}

export { FREE_DAILY_LIMIT, PREMIUM_DAILY_LIMIT };
