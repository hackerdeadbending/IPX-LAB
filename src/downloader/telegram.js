export async function sendTelegram(token, method, body) {
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;
  const init = { method: "POST" };
  if (isMultipart) init.body = body;
  else { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram ${method} failed (HTTP ${response.status})`);
  return data.result;
}