import { writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaults, profiles, settings, compileRule } from "./engine.js";

const catalogFile = fileURLToPath(new URL("./page/catalog.js", import.meta.url));
let refreshing;

// The page sandbox has no catalog read API; publish only the gateway's public model list.
export async function refreshCatalog(options = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let models = [], error = "", validation = "";
    try {
      const address = process.env.MAGPIE_ADDR || "127.0.0.1:3425";
      const response = await fetch(`http://${address.replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:")}/v1/models`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      models = (data.data || []).filter(model => typeof model.id === "string").map(model => ({
        id: model.id, name: model.display_name || model.id,
        provider: /^(auto|group)\//.test(model.id) ? "路由组" : model.owned_by || model.id.split("/")[0],
      }));
    } catch (cause) { error = `模型列表读取失败：${cause.message}`; }
    try {
      const config = settings(options);
      for (const rule of config.rules) if (rule.enabled && (rule.customEnabled || rule.profile === "custom")) compileRule(rule);
    } catch (cause) { validation = cause.message; }
    const data = { models, error, validation, revision: options.revision, updatedAt: new Date().toISOString(), defaults, profiles };
    const js = `window.MagpieReviewCatalog = ${JSON.stringify(data).replaceAll("<", "\\u003c")};\nwindow.dispatchEvent(new Event("review-catalog"));\n`;
    const temporary = `${catalogFile}.${process.pid}.tmp`;
    await writeFile(temporary, js, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, catalogFile);
    return data;
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

let timer;
export default {
  id: "magpie-review-rules",
  async server(_input, options = {}) {
    await refreshCatalog(options);
    if (!timer) {
      timer = setInterval(() => refreshCatalog(options).catch(error => console.warn(`Review rules: ${error.message}`)), 15000);
      timer.unref();
    }
    return {};
  },
};
