const INSTAGRAM_HOSTS = new Set(["instagram.com","www.instagram.com","m.instagram.com"]); 
const TIKTOK_HOSTS = new Set(["tiktok.com","www.tiktok.com","m.tiktok.com","vm.tiktok.com","vt.tiktok.com"]);

export function normalizeSocialUrl(value) {
  try {
    const url = new URL(String(value).trim());
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function detectSocialUrl(value) {
  const url = normalizeSocialUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (INSTAGRAM_HOSTS.has(host) || host.endsWith(".instagram.com")) return { platform: "instagram", url };
  if (TIKTOK_HOSTS.has(host) || host.endsWith(".tiktok.com")) return { platform: "tiktok", url };
  return null;
}

export function extractSocialUrl(text) {
  const match = String(text || "").match(/https?:\\/\\/[^\\s<>]+/i);
  if (!match) return null;
  return detectSocialUrl(match[0].replace(/[),.!?]+$/, ""));
}
