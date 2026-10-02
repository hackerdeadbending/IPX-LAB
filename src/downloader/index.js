import { detectSocialUrl, extractSocialUrl } from "./url.js";
import { resolveSocialMedia } from "./provider.js";
import { sendSocialMedia } from "./send.js";

export function findSocialUrl(text) {
  return extractSocialUrl(text);
}

export async function handleSocialDownload(env, chatId, text) {
  const social = detectSocialUrl(text) || extractSocialUrl(text);
  if (!social) return false;

  if (!env.SOCIAL_DOWNLOADER_API_URL) {
    throw new Error("Social downloader backend is not configured yet");
  }

  const resolved = await resolveSocialMedia(env, social);
  await sendSocialMedia(env, chatId, resolved);
  return true;
}
