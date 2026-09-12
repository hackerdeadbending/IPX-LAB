const FREE_DAILY_LIMIT = 10;
const PREMIUM_DAILY_LIMIT = 1000;

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function isAdmin(chatId, env) {
  const adminId = String(env.ADMIN_TELEGRAM_ID || "");
  return Boolean(adminId && String(chatId) === adminId);
}

async function ensureUser(db, chatId, user = {}) {
  const id = String(chatId);
  await db.prepare(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = COALESCE(excluded.username, users.username),
       first_name = COALESCE(excluded.first_name, users.first_name),
       updated_at = CURRENT_TIMESTAMP`
  ).bind(id, user.username || null, user.first_name || null).run();
}

async function getUser(db, chatId) {
  return db.prepare(
    "SELECT telegram_id, username, first_name, plan, premium_until FROM users WHERE telegram_id = ?"
  ).bind(String(chatId)).first();
}

function hasPremium(user) {
  if (!user) return false;
  if (user.plan === "premium") {
    if (!user.premium_until) return true;
    return new Date(user.premium_until).getTime() > Date.now();
  }
  return false;
}

export async function registerUser(env, chatId, user = {}) {
  if (!env.DB) return;
  await ensureUser(env.DB, chatId, user);
}

export async function consumeOperation(env, chatId, action, user = {}) {
  if (!env.DB) return { allowed: true, skipped: true };

  const id = String(chatId);
  await ensureUser(env.DB, id, user);

  if (isAdmin(id, env)) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY, used: 0, premium: false, admin: true };
  }

  const currentUser = await getUser(env.DB, id);
  const premium = hasPremium(currentUser);
  const limit = premium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const date = utcDate();

  const row = await env.DB.prepare(
    "SELECT id FROM usage WHERE telegram_id = ? AND action = ? AND created_at >= ?"
  ).bind(id, action, `${date}T00:00:00.000Z`).all();
  const used = Number(row?.results?.length || 0);

  if (used >= limit) {
    return { allowed: false, remaining: 0, limit, used, premium, admin: false };
  }

  await env.DB.prepare(
    "INSERT INTO usage (telegram_id, action) VALUES (?, ?)"
  ).bind(id, action).run();

  return { allowed: true, remaining: limit - used - 1, limit, used: used + 1, premium, admin: false };
}

export async function getUsage(env, chatId) {
  if (!env.DB) return { used: 0, remaining: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY, premium: false, admin: false };

  const id = String(chatId);
  await ensureUser(env.DB, id);

  if (isAdmin(id, env)) {
    return { used: 0, remaining: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY, premium: false, admin: true };
  }

  const user = await getUser(env.DB, id);
  const premium = hasPremium(user);
  const limit = premium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const date = utcDate();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM usage WHERE telegram_id = ? AND created_at >= ?"
  ).bind(id, `${date}T00:00:00.000Z`).first();
  const used = Number(row?.count || 0);

  return { used, remaining: Math.max(0, limit - used), limit, premium, admin: false };
}

export { FREE_DAILY_LIMIT, PREMIUM_DAILY_LIMIT };
