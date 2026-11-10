import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, settings, onRequest, onProvider, isReview, applyClaude, compileRule } from "../engine.js";

const ctx = options => ({ agent: "claude-desktop", protocol: "anthropic", options });
const review = () => ({
  model: "original/model", max_tokens: 64, temperature: 0, thinking: { type: "disabled" },
  system: [{ type: "text", text: "You are a security monitor. Reply <block>yes</block> or <block>no</block>." }],
  messages: [{ role: "user", content: [{ type: "text", text: "<transcript>Read README.md.</transcript>" }] }],
});
const rule = {
  name: "Example Sonnet", enabled: true, models: ["example/sonnet"],
  profile: "sonnet-5.5", customEnabled: false, code: "return body;",
};
const configured = {
  reviewerEnabled: true, reviewer: "example/sonnet",
  rules: ["sonnet", "opus", "haiku"].map(family => ({
    ...rule, name: `Example ${family}`, models: [`example/${family}`], profile: `${family}-5.5`,
  })),
};
const provider = (model = "sonnet", options = configured) => ({ ...ctx(options), provider: { id: "example", model } });

test("a fresh install does not reroute or rewrite requests", () => {
  assert.deepEqual(settings(), { enabled: true, reviewerEnabled: false, reviewer: "", rules: [] });
  assert.deepEqual(defaults, settings());
  const body = review(), before = structuredClone(body);
  assert.equal(onRequest(body, ctx()), undefined);
  assert.equal(onProvider(body, provider("sonnet", {})), undefined);
  assert.deepEqual(body, before);
});

test("saved options override neutral defaults without changing the saved rules", () => {
  const before = structuredClone(configured);
  assert.deepEqual(settings(configured), { enabled: true, ...configured });
  assert.equal(onRequest(review(), ctx(configured)).model, configured.reviewer);
  assert.deepEqual(configured, before);
});

test("reviewer selection is independent of the session model and preserves the review", () => {
  for (const reviewer of ["provider-a/reviewer", "provider-b/other-reviewer"]) {
    const body = review(), before = structuredClone(body);
    onRequest(body, ctx({ reviewerEnabled: true, reviewer }));
    assert.equal(body.model, reviewer);
    assert.deepEqual(body.messages, before.messages);
    assert.deepEqual(body.system, before.system);
  }
});

test("ordinary tool turns, titles, other agents and disabled rules stay intact", () => {
  for (const body of [
    { ...review(), tools: [{ name: "Bash" }] },
    { ...review(), system: "Summarize the transcript." },
    { ...review(), messages: [{ role: "user", content: "A normal question." }] },
  ]) {
    const before = structuredClone(body);
    assert.equal(isReview(body), false);
    assert.equal(onRequest(body, ctx()), undefined);
    assert.deepEqual(body, before);
  }
  const body = review();
  assert.equal(onRequest(body, { ...ctx(), agent: "codex" }), undefined);
  assert.equal(onRequest(body, ctx({ enabled: false })), undefined);
  assert.equal(onRequest(body, ctx({ reviewerEnabled: false })), undefined);
  assert.equal(body.model, "original/model");
});

test("a third-party name follows an explicitly selected Claude profile", () => {
  const options = { rules: [{ ...rule, models: ["another/opaque-model-id"] }] };
  const body = review();
  assert.equal(onProvider(body, { ...ctx(options), provider: { id: "another", model: "opaque-model-id" } }).thinking.type, "between_tools");
  assert.equal(onProvider(review(), provider("deepseek-v4.1-flash")), undefined);
});

test("new Claude thinking modes preserve effort and fit the model's off mode", () => {
  for (const [budget, effort] of [[1024, "low"], [8000, "medium"], [16000, "high"], [32000, "max"]]) {
    const result = applyClaude({ thinking: { type: "enabled", budget_tokens: budget } }, "sonnet-5.5");
    assert.deepEqual(result.thinking, { type: "adaptive" });
    assert.equal(result.output_config.effort, effort);
  }
  const sonnet = onProvider({ ...review(), output_config: { effort: "max", format: { type: "json_schema" } } }, provider());
  assert.equal(sonnet.thinking.type, "between_tools");
  assert.equal(sonnet.output_config.effort, "high");
  assert.ok(sonnet.output_config.format);
  assert.equal(sonnet.temperature, undefined);
  const opus = onProvider(review(), provider("opus"));
  assert.equal(opus.thinking.type, "adaptive");
  assert.equal(opus.max_tokens, 2112);
  assert.equal(opus.output_config.effort, "low");
  assert.equal(onProvider(review(), provider("haiku")).thinking.type, "disabled");
});

test("custom JavaScript runs only on selected models, after the preset, in rule order", () => {
  const options = { rules: [
    { ...rule, customEnabled: true, code: 'if (ctx.review && body.thinking.type === "between_tools") body.max_tokens = 128; return body;' },
    { ...rule, profile: "custom", code: "body.max_tokens += 1;" },
  ] };
  assert.equal(onProvider(review(), provider("sonnet", options)).max_tokens, 129);
  assert.equal(onProvider(review(), provider("haiku", options)), undefined);
  options.rules[0].enabled = false;
  assert.equal(onProvider(review(), provider("sonnet", options)).max_tokens, 65);
});

test("invalid config and custom syntax are rejected before a Desktop request is routed", () => {
  assert.throws(() => settings({ rules: [{ ...rule, models: [] }] }), /至少选择/);
  assert.throws(() => settings({ rules: [{ ...rule, profile: "unknown" }] }), /类型无效/);
  assert.throws(() => settings({ reviewerEnabled: true, reviewer: "not-a-model" }), /审核模型/);
  assert.throws(() => settings({ rules: [0, 1].map(() => ({ ...rule, code: "//" + "中".repeat(9000) })) }), /50 KB/);
  const options = { rules: [{ ...rule, profile: "custom", code: "if (" }] };
  let rejection;
  onRequest(review(), { ...ctx(options), reject: (status, message) => { rejection = { status, message }; } });
  assert.equal(rejection.status, 400);
  assert.match(rejection.message, /语法错误/);
  assert.throws(() => compileRule(options.rules[0]), /语法错误/);
});

test("a custom rule must return JSON request data, not an async value or null", () => {
  for (const code of ["return null;", "return [];", "return Promise.resolve(body);"]) {
    const options = { rules: [{ ...rule, profile: "custom", code }] };
    assert.throws(() => onProvider(review(), provider("sonnet", options)), /必须返回/);
  }
});

test("custom code compiles once across requests and refreshes when rules change", async () => {
  const engine = await import("../engine.js?compilation-cache");
  const original = globalThis.Function;
  let compilations = 0;
  globalThis.Function = function (...args) { compilations++; return new original(...args); };
  try {
    const options = { reviewerEnabled: true, reviewer: "example/sonnet", rules: [{ ...rule, profile: "custom", code: "body.max_tokens = 128; return body;" }] };
    for (let i = 0; i < 3; i++) {
      const copy = structuredClone(options);
      engine.onRequest(review(), ctx(copy));
      assert.equal(engine.onProvider(review(), provider("sonnet", copy)).max_tokens, 128);
    }
    assert.equal(compilations, 1);
    options.reviewer = "example/other";
    engine.onRequest(review(), ctx(options));
    assert.equal(compilations, 1);
    options.rules[0].code = "body.max_tokens = 256; return body;";
    engine.onRequest(review(), ctx(options));
    assert.equal(engine.onProvider(review(), provider("sonnet", options)).max_tokens, 256);
    assert.equal(compilations, 2);
    options.rules = [];
    assert.equal(engine.prepareRules(options.rules).size, 0);
    options.rules = [{ ...rule, profile: "custom", code: "body.max_tokens = 128; return body;" }];
    engine.onRequest(review(), ctx(options));
    assert.equal(compilations, 3);
  } finally { globalThis.Function = original; }
});

test("cached syntax failures still reject every request and recover after correction", async () => {
  const engine = await import("../engine.js?syntax-cache");
  const original = globalThis.Function;
  let compilations = 0;
  globalThis.Function = function (...args) { compilations++; return new original(...args); };
  try {
    const options = { rules: [{ ...rule, profile: "custom", code: "if (" }] };
    const errors = [];
    const reject = (status, message) => errors.push({ status, message });
    for (let i = 0; i < 3; i++) engine.onRequest(review(), { ...ctx(structuredClone(options)), reject });
    assert.equal(compilations, 1);
    assert.equal(errors.length, 3);
    assert.ok(errors.every(error => error.status === 400 && error.message.includes("Example Sonnet")));
    options.rules[0].name = "Renamed rule";
    engine.onRequest(review(), { ...ctx(options), reject });
    assert.match(errors.at(-1).message, /Renamed rule/);
    assert.equal(compilations, 2);
    options.rules[0].code = "body.max_tokens = 512; return body;";
    engine.onRequest(review(), { ...ctx(options), reject });
    assert.equal(errors.length, 4);
    assert.equal(engine.onProvider(review(), provider("sonnet", options)).max_tokens, 512);
    assert.equal(compilations, 3);
  } finally { globalThis.Function = original; }
});
