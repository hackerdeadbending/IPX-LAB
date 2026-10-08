function cleanBase(value) {
  return String(value || "").trim().replace(/\/$/, "");
}
function providerHeaders(env) {
  const headers = { accept: "application/json", "content-type": "application/json" };
  if (env.SOCIAL_DOWNLOADER_API_KEY) {
    headers.authorization = `Api-Key ${env.SOCIAL_DOWNLOADER_API_KEY}`;
    headers["x-api-key"] = env.SOCIAL_DOWNLOADER_API_KEY;
  }
  return headers;
}
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
async function requestProvider(env, url) {
  const endpoint = cleanBase(env.SOCIAL_DOWNLOADER_API_URL);
  if (!endpoint) throw new Error("Social downloader backend is not configured yet");
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: providerHeaders(env),
        body: JSON.stringify({ url, videoQuality: "1080", downloadMode: "auto", filenameStyle: "pretty", disableMetadata: true, alwaysProxy: true, tiktokH265: false, tiktokFullAudio: true })
      });
      const bodyText = await response.text();
      let data = null;
      try { data = bodyText ? JSON.parse(bodyText) : null; } catch {}
      if (response.ok && data && typeof data === "object") return data;
      const detail = data?.detail || data?.error || data?.message || bodyText;
      lastError = new Error(`Downloader provider returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError || new Error("Downloader provider request failed");
}
function extensionFromUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    const match = path.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v|webm)(?:$)/i);
    return match?.[1] || null;
  } catch { return null; }
}
function normalizeKind(value, fallback = null) {
  const kind = String(value || "").toLowerCase();
  if (["photo", "image"].includes(kind)) return "photo";
  if (["video", "movie"].includes(kind)) return "video";
  if (["gif", "animation"].includes(kind)) return "gif";
  return fallback;
}
function kindFromUrl(value, fallback = null) {
  const ext = extensionFromUrl(value);
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "photo";
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (ext === "gif") return "gif";
  return fallback;
}
function mediaFromItem(item, index) {
  if (!item?.url) return null;
  const type = normalizeKind(item.type, kindFromUrl(item.url));
  if (!type) return null;
  const ext = extensionFromUrl(item.url) || (type === "photo" ? "jpg" : type === "gif" ? "gif" : "mp4");
  return { type, url: item.url, filename: item.filename || `ipx-lab-${type}-${index + 1}.${ext}` };
}
export async function resolveSocialMedia(env, social) {
  const data = await requestProvider(env, social.url);
  if (data.ok === true && data.file_url) {
    const files = Array.isArray(data.files) && data.files.length ? data.files : [{ file_url: data.file_url, filename: data.filename, mime_type: data.mime_type, kind: data.kind }];
    const items = files.map((item, index) => mediaFromItem({ url: item.file_url || item.url, filename: item.filename, type: item.kind || item.type }, index)).filter(Boolean);
    if (!items.length) throw new Error("Downloader returned no usable media");
    return { kind: "picker", items, audio: data.audio || null, audioFilename: data.audioFilename || null };
  }
  if (data.status === "picker" && Array.isArray(data.picker)) {
    const items = data.picker.map(mediaFromItem).filter(Boolean);
    if (!items.length) throw new Error("Downloader returned no media");
    return { kind: "picker", items, audio: data.audio || null, audioFilename: data.audioFilename || null };
  }
  if ((data.status === "redirect" || data.status === "tunnel") && data.url) {
    const kind = normalizeKind(data.kind, kindFromUrl(data.filename || data.url, "document"));
    return { kind: "picker", items: [{ type: kind, url: data.url, filename: data.filename || `ipx-lab-download.${extensionFromUrl(data.url) || (kind === "photo" ? "jpg" : "mp4")}` }], audio: data.audio || null, audioFilename: data.audioFilename || null };
  }
  const code = data?.error?.code || data?.code || "unknown";
  const detail = data?.detail || data?.error?.message || data?.message || "";
  throw new Error(`Downloader provider could not extract this post (${code})${detail ? `: ${String(detail).slice(0, 500)}` : ""}`);
}
