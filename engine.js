export const profiles = {
  "sonnet-5.5": "Claude Sonnet 5.5",
  "opus-5.5": "Claude Opus 5.5",
  "haiku-5.5": "Claude Haiku 5.5",
  adaptive: "Claude Adaptive（通用）",
  custom: "仅运行自定义 JavaScript",
};

export const defaults = {
  enabled: true,
  reviewerEnabled: false,
  reviewer: "",
  rules: [],
};

export function settings(options = {}) {
  const config = { ...defaults, ...options };
  if (typeof config.enabled !== "boolean" || typeof config.reviewerEnabled !== "boolean") throw new Error("启用开关必须是布尔值。");
  if (config.reviewerEnabled && !validModel(config.reviewer)) throw new Error("请选择有效的审核模型。");
  if (!Array.isArray(config.rules) || config.rules.length > 30) throw new Error("规则最多 30 条。");
  if (encodeURIComponent(JSON.stringify(config)).replace(/%[0-9A-F]{2}/g, "_").length > 50000) throw new Error("配置过大，请将总大小控制在 50 KB 内。");
  for (const [i, rule] of config.rules.entries()) {
    if (!rule || typeof rule !== "object" || typeof rule.enabled !== "boolean") throw new Error(`规则 ${i + 1} 格式无效。`);
    if (typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 100) throw new Error(`规则 ${i + 1} 需要名称（最多 100 字符）。`);
    if (!Object.hasOwn(profiles, rule.profile)) throw new Error(`规则「${rule.name}」的 Claude 规则类型无效。`);
    if (!Array.isArray(rule.models) || rule.models.length < 1 || rule.models.length > 100 || !rule.models.every(validModel)) throw new Error(`规则「${rule.name}」至少选择一个模型。`);
    if (typeof rule.customEnabled !== "boolean" || typeof rule.code !== "string" || rule.code.length > 16000) throw new Error(`规则「${rule.name}」的代码格式无效或超过 16,000 字符。`);
    if (rule.enabled && (rule.customEnabled || rule.profile === "custom") && !rule.code.trim()) throw new Error(`规则「${rule.name}」需要 JavaScript 代码。`);
  }
  return config;
}

function validModel(value) {
  return typeof value === "string" && value.length <= 300 && /^[^\s]+\/[^\s]+$/.test(value);
}

function text(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part && part.type === "text").map(part => part.text || "").join("\n") : "";
}

export function isReview(body) {
  if (body.tools && body.tools.length) return false;
  const system = text(body.system);
  return (system.includes("<block>") || system.includes("<severity>")) &&
    (body.messages || []).some(message => message.role === "user" && text(message.content).trimStart().startsWith("<transcript>"));
}

export function applyClaude(body, profile) {
  if (profile === "custom") return body;
  const mode = body.thinking && body.thinking.type;
  if (mode === "enabled" || mode === "adaptive") {
    const budget = body.thinking.budget_tokens;
    if (mode === "enabled" && budget > 0 && !(body.output_config && body.output_config.effort)) {
      const effort = budget <= 4096 ? "low" : budget <= 12000 ? "medium" : budget <= 24000 ? "high" : "max";
      body.output_config = { ...body.output_config, effort };
    }
    body.thinking = { ...body.thinking, type: "adaptive" };
    delete body.thinking.budget_tokens;
  } else if (!mode || mode === "disabled" || mode === "between_tools") {
    if (profile === "sonnet-5.5") body.thinking = { type: "between_tools" };
    else if (profile === "haiku-5.5") body.thinking = { type: "disabled" };
    else {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: "low", ...body.output_config };
      if (body.max_tokens > 0 && body.max_tokens < 2048) body.max_tokens += 2048;
    }
    if ((profile === "sonnet-5.5" || profile === "haiku-5.5") && body.output_config && ["xhigh", "max"].includes(body.output_config.effort)) body.output_config.effort = "high";
  }
  if (profile !== "adaptive") {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }
  return body;
}

export function compileRule(rule) {
  try { return new Function("body", "ctx", `"use strict";\n${rule.code}`); }
  catch (error) { throw new Error(`规则「${rule.name}」语法错误：${error.message}`); }
}

let compiledKey, compiled, compilationError;

// Magpie reuses each sandbox; keep only the current rules, never request data.
export function prepareRules(rules) {
  const key = JSON.stringify(rules);
  if (key !== compiledKey) {
    const next = new Map();
    let failure;
    try {
      for (const rule of rules) {
        if (rule.enabled && (rule.customEnabled || rule.profile === "custom") && !next.has(rule.code)) next.set(rule.code, compileRule(rule));
      }
    } catch (error) { failure = error; }
    compiledKey = key;
    compiled = next;
    compilationError = failure;
  }
  if (compilationError) throw compilationError;
  return compiled;
}

export function onRequest(body, ctx) {
  if (ctx.agent !== "claude-desktop" || ctx.protocol !== "anthropic") return;
  try {
    const config = settings(ctx.options);
    if (!config.enabled) return;
    prepareRules(config.rules);
    if (config.reviewerEnabled && isReview(body)) {
      body.model = config.reviewer;
      return body;
    }
  } catch (error) {
    if (ctx.reject) ctx.reject(400, `Claude Desktop 审核与模型规则：${error.message}`);
    else throw error;
  }
}

export function onProvider(body, ctx) {
  if (ctx.agent !== "claude-desktop" || ctx.protocol !== "anthropic" || !ctx.provider) return;
  const config = settings(ctx.options);
  if (!config.enabled) return;
  const functions = prepareRules(config.rules);
  const model = `${ctx.provider.id}/${ctx.provider.model}`;
  const matches = config.rules.filter(rule => rule.enabled && rule.models.includes(model));
  if (!matches.length) return;
  for (const rule of matches) {
    body = applyClaude(body, rule.profile);
    if (rule.customEnabled || rule.profile === "custom") {
      const result = functions.get(rule.code)(body, {
        agent: ctx.agent, protocol: ctx.protocol, provider: { ...ctx.provider },
        model, review: isReview(body),
      });
      if (result !== undefined) body = result;
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.then === "function") throw new Error(`规则「${rule.name}」必须返回请求对象或不返回值。`);
    }
  }
  return body;
}
