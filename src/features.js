import currentWorker from "./entry.js";
import { consumePhoto, registerUser, grantPremium, getAdminStats, isAdmin } from "./db.js";

const FILTERS = {
  "filter:cinema": { name: "Cinema", transform: { saturation: 0.82, contrast: 1.18, brightness: 0.96, gamma: 1.04, sharpen: 1 }, filename: "ipx-lab-cinema.jpg" },
  "filter:dark-cinema": { name: "Dark Cinema", transform: { saturation: 0.72, contrast: 1.28, brightness: 0.86, gamma: 1.08, sharpen: 1 }, filename: "ipx-lab-dark-cinema.jpg" },
  "filter:golden": { name: "Golden Hour", transform: { saturation: 1.12, contrast: 1.08, brightness: 1.05, gamma: 0.96 }, filename: "ipx-lab-golden-hour.jpg" },
  "filter:night": { name: "Night Film", transform: { saturation: 0.72, contrast: 1.22, brightness: 0.78, gamma: 1.12, sharpen: 1 }, filename: "ipx-lab-night-film.jpg" },
  "filter:warm": { name: "Warm Film", transform: { saturation: 1.06, contrast: 1.04, brightness: 1.02, gamma: 0.98 }, filename: "ipx-lab-warm-film.jpg" },
  "filter:cold": { name: "Cold Film", transform: { saturation: 0.86, contrast: 1.1, brightness: 1.01, gamma: 1.02 }, filename: "ipx-lab-cold-film.jpg" },
  "filter:vintage": { name: "Vintage Film", transform: { saturation: 0.76, contrast: 0.94, brightness: 1.02, gamma: 0.94 }, filename: "ipx-lab-vintage.jpg" },
  "filter:35mm": { name: "35mm", transform: { saturation: 0.9, contrast: 1.12, brightness: 0.98, gamma: 1.03, sharpen: 1 }, filename: "ipx-lab-35mm.jpg" },
  "filter:noir": { name: "Noir", transform: { saturation: 0, contrast: 1.32, brightness: 0.94, gamma: 1.05, sharpen: 1.5 }, filename: "ipx-lab-noir.jpg" },
  "filter:moody": { name: "Moody", transform: { saturation: 0.68, contrast: 1.2, brightness: 0.9, gamma: 1.08 }, filename: "ipx-lab-moody.jpg" },
  "filter:bw": { name: "Black & White", transform: { saturation: 0, contrast: 1.08, sharpen: 1 }, filename: "ipx-lab-black-white.jpg" },
  "filter:dramatic-bw": { name: "Dramatic B&W", transform: { saturation: 0, contrast: 1.38, brightness: 0.92, gamma: 1.08, sharpen: 1.5 }, filename: "ipx-lab-dramatic-bw.jpg" }
};

function telegramUrl(token, method) { return `https://api.telegram.org/bot${token}/${method}`; }
async function tg(token, method, body) {
  const r = await fetch(telegramUrl(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `${method} failed`);
  return data.result;
}
function sourceId(message) { if (message?.photo?.length) return message.photo.at(-1).file_id; if (message?.document?.mime_type?.startsWith("image/")) return message.document.file_id; return null; }
async function source(env, chatId) {
  if (!env.DB) return null;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS source_images (telegram_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  const row = await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(String(chatId)).first();
  return row?.file_id || null;
}
async function sendPremium(token, chatId, amount) {
  return tg(token, "sendInvoice", { chat_id: chatId, title: "IPX LAB Premium", description: "Unlimited daily photos and access to Pro Filters and future premium tools.", payload: `ipx-premium-30d-${chatId}-${Date.now()}`, currency: "XTR", prices: [{ label: "Premium — 30 days", amount }], subscription_period: 2592000 });
}
async function showFilters(token, chatId) {
  await tg(token, "sendMessage", { chat_id: chatId, text: "🎬 Pro Filters\n\nTurn your photo into a cinematic, film or professional-looking image.", reply_markup: { inline_keyboard: [[{text:"🎬 Cinema",callback_data:"filter:cinema"},{text:"🌑 Dark Cinema",callback_data:"filter:dark-cinema"}],[{text:"🌅 Golden Hour",callback_data:"filter:golden"},{text:"🌃 Night Film",callback_data:"filter:night"}],[{text:"🟠 Warm Film",callback_data:"filter:warm"},{text:"🔵 Cold Film",callback_data:"filter:cold"}],[{text:"🎞 35mm",callback_data:"filter:35mm"},{text:"📽 Vintage Film",callback_data:"filter:vintage"}],[{text:"🖤 Noir",callback_data:"filter:noir"},{text:"🌫 Moody",callback_data:"filter:moody"}],[{text:"⚫ Black & White",callback_data:"filter:bw"},{text:"🎭 Dramatic B&W",callback_data:"filter:dramatic-bw"}],[{text:"↩️ Back",callback_data:"back"}]] } });
}
async function applyFilter(env, token, chatId, action) {
  const preset = FILTERS[action];
  if (!preset) return false;
  const fileId = await source(env, chatId);
  if (!fileId) { await tg(token, "sendMessage", {chat_id: chatId, text: "📸 Send a photo first."}); return true; }
  const file = await tg(token, "getFile", {file_id: fileId});
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok || !response.body) throw new Error("Unable to download current photo");
  const output = await env.IMAGES.input(response.body).transform({fit:"scale-down", ...preset.transform}).output({format:"image/jpeg", quality:92});
  const result = output.response();
  if (!result.ok) throw new Error(`Filter failed (${result.status})`);
  const bytes = await result.arrayBuffer();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new File([bytes], preset.filename, {type:"image/jpeg"}));
  form.append("caption", `🎬 ${preset.name}\n\nFilter applied. You can continue editing this result.`);
  form.append("reply_markup", JSON.stringify({inline_keyboard:[[ {text:"🎬 More Filters",callback_data:"filters"},{text:"⭐ Premium",callback_data:"premium"} ]] }));
  form.append("disable_content_type_detection", "true");
  const sent = await fetch(telegramUrl(token,"sendDocument"), {method:"POST", body:form});
  const data = await sent.json();
  if (!data.ok) throw new Error(data.description || "Unable to send filtered image");
  const newId = data.result?.document?.file_id;
  if (newId && env.DB) await env.DB.prepare("INSERT INTO source_images (telegram_id,file_id,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id,updated_at=CURRENT_TIMESTAMP").bind(String(chatId),newId).run();
  return true;
}
async function adminPanel(env, token, chatId) {
  if (!isAdmin(chatId, env)) return false;
  const stats = await getAdminStats(env);
  const lines = [`👑 IPX LAB ADMIN`, ``, `👥 Users: ${stats?.users ?? 0}`, `⭐ Premium: ${stats?.premium ?? 0}`, `📸 Photos today: ${stats?.todayPhotos ?? 0}`, ``, `Recent users:`];
  for (const u of (stats?.recent || [])) lines.push(`• ${u.first_name || "No name"}${u.username ? ` @${u.username}` : ""} — ${u.plan}${u.premium_until ? ` until ${u.premium_until.slice(0,10)}` : ""} — ID ${u.telegram_id}`);
  await tg(token,"sendMessage",{chat_id:chatId,text:lines.join("\n"),reply_markup:{inline_keyboard:[[ {text:"⭐ Grant Premium 30d",callback_data:"admin:grant"} ]]}});
  return true;
}
async function grantPrompt(token, chatId) { await tg(token,"sendMessage",{chat_id:chatId,text:"👑 Send the Telegram numeric ID of the user who should receive 30 days of Premium.\n\nExample: 123456789",reply_markup:{force_reply:true,input_field_placeholder:"Telegram ID"}}); }
async function interceptOutgoing(input, init, originalFetch, env) {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!url.startsWith("https://api.telegram.org/bot") || !init?.body) return originalFetch(input, init);
  const method = url.split("/").pop();
  if (method !== "sendPhoto" && method !== "sendDocument" && method !== "sendMessage") return originalFetch(input, init);
  try {
    if (init.body instanceof FormData) return originalFetch(input, init);
    const body = JSON.parse(init.body);
    const markup = typeof body.reply_markup === "string" ? JSON.parse(body.reply_markup) : body.reply_markup;
    if (!markup?.inline_keyboard) return originalFetch(input, init);
    const isMain = markup.inline_keyboard.some(row => row.some(b => ["resize","exact-size","compress","convert","crop"].includes(b.callback_data)));
    if (!isMain) return originalFetch(input, init);
    const rows = markup.inline_keyboard.map(r => [...r]);
    rows.push([{text:"🎬 Pro Filters",callback_data:"filters"},{text:"⭐ Premium",callback_data:"premium"}]);
    if (isAdmin(body.chat_id, env)) rows.push([{text:"👑 Admin",callback_data:"admin"}]);
    body.reply_markup = {inline_keyboard:rows};
    return originalFetch(input,{...init,body:JSON.stringify(body)});
  } catch { return originalFetch(input, init); }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return currentWorker.fetch(request, env, ctx);
    const cloned = request.clone();
    let update; try { update = await cloned.json(); } catch { return currentWorker.fetch(request, env, ctx); }
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || update?.pre_checkout_query?.from?.id;
    const from = update?.message?.from || update?.callback_query?.from || update?.pre_checkout_query?.from || update?.message?.chat;
    if (chatId && env.DB) await registerUser(env, chatId, {username:from?.username, first_name:from?.first_name, language:from?.language_code});
    if (update?.pre_checkout_query && token) { await tg(token,"answerPreCheckoutQuery",{pre_checkout_query_id:update.pre_checkout_query.id,ok:true}); return new Response("OK"); }
    const payment = update?.message?.successful_payment;
    if (payment && token) {
      const userId = update.message.from?.id || update.message.chat?.id;
      const until = await grantPremium(env,userId,30,payment.total_amount,payment.telegram_payment_charge_id);
      await tg(token,"sendMessage",{chat_id:userId,text:`👑 Premium activated!\n\nYou now have unlimited daily photos.\nPremium is active until ${until.slice(0,10)}.`});
      return new Response("OK");
    }
    if (update?.message?.text) {
      const text = update.message.text.trim();
      if (text === "/premium" || text === "⭐ Premium") { if (token) await sendPremium(token, chatId, Number(env.PREMIUM_STARS_AMOUNT || 100)); return new Response("OK"); }
      if (text === "/admin") { if (token && await adminPanel(env,token,chatId)) return new Response("OK"); }
      if (update.message.reply_to_message && /^\d{5,15}$/.test(text) && isAdmin(chatId,env)) { await grantPremium(env,text,30,0,"admin-grant"); if(token) await tg(token,"sendMessage",{chat_id:chatId,text:`✅ Premium granted to ${text} for 30 days.`}); return new Response("OK"); }
      const incoming = sourceId(update.message);
      if (incoming) {
        const result = await consumePhoto(env,chatId,incoming,{username:from?.username,first_name:from?.first_name,language:from?.language_code});
        if (!result.allowed) { if(token) await tg(token,"sendMessage",{chat_id:chatId,text:`🚫 Daily limit reached.\n\nFree plan: ${result.limit} different photos per day.\nYou have used ${result.used}/${result.limit}.\n\nYou can still use every editing function on each photo.\n⭐ Premium removes the daily photo limit.`}); return new Response("OK"); }
      }
    }
    if (update?.callback_query) {
      const action = update.callback_query.data || "";
      if (action === "filters") { await showFilters(token,chatId); return new Response("OK"); }
      if (FILTERS[action]) { try { await applyFilter(env,token,chatId,action); } catch(e) { await tg(token,"sendMessage",{chat_id:chatId,text:`❌ ${e.message}`}); } return new Response("OK"); }
      if (action === "premium") { await sendPremium(token,chatId,Number(env.PREMIUM_STARS_AMOUNT || 100)); return new Response("OK"); }
      if (action === "admin") { await adminPanel(env,token,chatId); return new Response("OK"); }
      if (action === "admin:grant" && isAdmin(chatId,env)) { await grantPrompt(token,chatId); return new Response("OK"); }
    }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => interceptOutgoing(input, init, originalFetch, env);
    try { return await currentWorker.fetch(new Request(request,{body:JSON.stringify(update)}),env,ctx); }
    finally { globalThis.fetch = originalFetch; }
  }
};
