function cleanBase(value) {
  return String(value || "").trim().replace(/\/$/, "");
}
function providerHeaders(env) {
  const headers = { "accept": "application/json", "content-type": "application/json" };
  if (env.SOCIAL_DOWNLOADER_API_KEY) headers.authorization = `Api-Key ${env.SOCIAL_DOWNLOADER_API_KEY}`;
  return headers;
}
const RETRYABLE = new Set([502, 503, 504]);
async function requestProvider(env, url) {
  const endpoint = cleanBase(env.SOCIAL_DOWNLOADER_API_URL);
  if (!endpoint) throw new Error("Social downloader is not configured");
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: providerHeaders(env),
        body: JSON.stringify({ url, videoQuality: "1080", downloadMode: "auto", filenameStyle: "pretty", disableMetadata: true, alwaysProxy: true, tiktokH265: false, tiktokFullAudio: true })
      });
      if (response.ok) {
        const data = await response.json();
        if (!data || typeof data !== "object") throw new Error("Downloader provider returned invalid JSON");
        return data;
      }
      const body = await response.text().catch(() => "");
      lastError = new Error(`Downloader provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw lastError || new Error("Downloader provider request failed");
}
function extensionFromUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    const match = path.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v|webm)(?:$|\?)/);
    return match?.[1] || null;
  } catch { return null; }
}
function mediaFromItem(item, index) {
  const type = item?.type === "photo" || item?.type === "video" || item?.type === "gif" ? item.type : null;
  if (!type || !item?.url) return null;
  const ext = extensionFromUrl(item.url) || (type === "photo" ? "jpg" : type === "gif" ? "gif" : "mp4");
  return { type, url: item.url, filename: `ipx-lab-${type}-${index + 1}.${ext}` };
}
export async function resolveSocialMedia(env, social) {
  const data = await requestProvider(env, social.url);
  if (data.status === "picker" && Array.isArray(data.picker)) {
    const items = data.picker.map(mediaFromItem).filter(Boolean);
    if (!items.length) throw new Error("Downloader returned no media");
    return { kind: "picker", items, audio: data.audio || null, audioFilename: data.audioFilename || null };
  }
  if ((data.status === "redirect" || data.status === "tunnel") && data.url) {
    const ext = extensionFromUrl(data.filename || data.url);
    return { kind: "single", url: data.url, filename: data.filename || `ipx-lab-download${ext ? `.${ext}` : ""}`, type: ext };
  }
  const code = data?.error?.code || "unknown";
  throw new Error(`Downloader provider could not extract this post (${code})`);
}