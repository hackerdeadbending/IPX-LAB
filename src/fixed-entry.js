import currentWorker from "./features.js";

export default {
  async fetch(request, env, ctx) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (init?.body instanceof FormData) {
        const form = init.body;
        if (form.has("document")) form.set("disable_content_type_detection", "true");
      }
      return originalFetch(input, init);
    };
    try {
      return await currentWorker.fetch(request, env, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
};
