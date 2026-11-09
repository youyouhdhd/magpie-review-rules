import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const magpie = value("--magpie");
if (!magpie || !process.env.npm_execpath) throw new Error("Usage: npm run test:install -- --magpie <executable> [--package <tgz>]. Run npm pack first.");
const archive = resolve(value("--package") || join(root, `${metadata.name}-${metadata.version}.tgz`));
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "magpie review release-")));
const configDir = join(sandbox, "config");
const registry = join(configDir, "magpie", "plugins.json");
const report = { package: `${metadata.name}@${metadata.version}`, platform: process.platform, node: process.version, checks: [] };
const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
let gateway, logs = "", env;

async function run(command, argv, extra = {}) {
  const child = spawn(command, argv, { env, cwd: sandbox, windowsHide: true, ...extra });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, `${command} ${argv[0]} failed: ${output}`);
    return output;
  } finally { clearTimeout(timeout); }
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(fn, message) {
  const deadline = Date.now() + 60000;
  let failure;
  while (Date.now() < deadline) {
    if (gateway && gateway.exitCode !== null) throw new Error(`Magpie stopped: ${logs.slice(-3000)}`);
    try { const result = await fn(); if (result) return result; }
    catch (error) { failure = error; }
    await delay(250);
  }
  throw new Error(`${message}: ${failure?.message || "timed out"}`);
}

const received = [];
const upstream = createServer(async (request, response) => {
  try {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ object: "list", data: ["opaque-reviewer", "opaque-session"].map(id => ({ id, object: "model" })) }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    received.push(body);
    response.end(JSON.stringify({
      id: "msg_smoke", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "<block>no</block>" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
});

try {
  await access(archive);
  env = { ...process.env, MAGPIE_NO_ACCOUNTS: "1", MAGPIE_PLUGIN_MARKET: "off", MAGPIE_WEB_KEY: randomBytes(24).toString("hex") };
  for (const [name, folder] of Object.entries({
    XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data",
    XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
  })) {
    env[name] = join(sandbox, folder);
    await mkdir(env[name], { recursive: true });
  }
  env.NPM_CONFIG_USERCONFIG = join(sandbox, "npmrc");
  env.NPM_CONFIG_GLOBALCONFIG = join(sandbox, "npmrc-global");
  env.NPM_CONFIG_CACHE = join(sandbox, "npm-cache");
  await writeFile(env.NPM_CONFIG_USERCONFIG, "");
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "");
  delete env.MAGPIE_WEB_URL;
  delete env.MAGPIE_TLS_CERT;
  delete env.MAGPIE_TLS_KEY;
  const files = (await run("tar", ["-tzf", archive])).trim().split(/\r?\n/);
  const expected = new Set(["package.json", "README.md", "LICENSE", ...metadata.files].map(file => `package/${file}`));
  assert.deepEqual(new Set(files), expected, "release archive contains unexpected or missing files");
  const npmPrefix = join(sandbox, "fresh-npm");
  await run(process.execPath, [process.env.npm_execpath, "install", "--prefix", npmPrefix, archive, "--ignore-scripts", "--no-audit", "--no-fund", "--offline"]);
  const installed = join(npmPrefix, "node_modules", metadata.name);
  for (const file of files) {
    const text = await readFile(join(installed, file.slice("package/".length)), "utf8");
    assert.doesNotMatch(text, /[a-z]:\\Users\\|[a-z]:\\software\\|\.before-review-rules-\d/i);
  }
  check("offline npm installation succeeds; packed files match the public allowlist without a generated catalog or personal defaults");

  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-File", join(installed, "install.ps1"), "-Magpie", magpie]);
  } else await run(magpie, ["plugin", "add", installed]);
  let entries = JSON.parse(await readFile(registry, "utf8")).plugins;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].spec, installed);
  assert.deepEqual(entries[0].options || {}, {});
  check("fresh Magpie install registers the npm-installed package with empty options");

  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  await run(magpie, ["provider", "add", "Release smoke", "id=release-smoke", `anthropic=${upstreamURL}`, "key=smoke-test-only", "models=opaque-reviewer,opaque-session", "list=off"]);
  const gatewayPort = await freePort(), webPort = await freePort();
  env.MAGPIE_ADDR = `127.0.0.1:${gatewayPort}`;
  const base = `http://127.0.0.1:${webPort}`;
  gateway = spawn(magpie, ["serve", `--web=127.0.0.1:${webPort}`], { env, cwd: sandbox, windowsHide: true, detached: process.platform !== "win32" });
  gateway.on("error", error => { logs += error.message; });
  gateway.stdout.on("data", data => { logs += data; });
  gateway.stderr.on("data", data => { logs += data; });
  async function api(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
      headers: { cookie: `magpie_web_${webPort}=${env.MAGPIE_WEB_KEY}`, origin: base, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  }
  const page = await until(async () => (await api("/api/plugin-pages")).find(page => page.spec === installed), "plugin page registration");
  for (const asset of ["index.html", "app.js", "style.css", "icon.svg", "_magpie/bridge.js"]) {
    const url = new URL(asset, base + page.url);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `${asset} was not served`);
  }
  const catalogURL = new URL("catalog.js", base + page.url);
  const catalog = await until(async () => {
    const response = await fetch(catalogURL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const source = await response.text();
    const match = source.match(/^window\.MagpieReviewCatalog = (.*);\n/);
    if (!match) return;
    const data = JSON.parse(match[1]);
    return data.models.some(model => model.id === "release-smoke/opaque-reviewer") && data;
  }, "fresh catalog generation");
  assert.deepEqual(catalog.defaults, { enabled: true, reviewerEnabled: false, reviewer: "", rules: [] });
  assert.equal(catalog.validation, "");
  assert.equal(catalog.error, "");
  check("real plugin host generates the local catalog; native page and all assets are served");

  async function send(review = true) {
    const body = {
      model: "release-smoke/opaque-session", max_tokens: 64, thinking: { type: "disabled" }, temperature: 0,
      system: review ? "Judge this action. Reply <block>yes</block> or <block>no</block>." : "Answer briefly.",
      messages: [{ role: "user", content: review ? "<transcript>Read README.md.</transcript>" : "Hello" }],
    };
    const response = await fetch(`http://${env.MAGPIE_ADDR}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", "x-api-key": "magpie-claude-desktop", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
    return received.at(-1);
  }
  const original = await send();
  assert.equal(original.model, "opaque-session");
  assert.equal(original.thinking.type, "disabled");
  check("fresh defaults preserve the requested model and thinking mode through the real gateway");

  const options = {
    enabled: true, reviewerEnabled: true, reviewer: "release-smoke/opaque-reviewer", revision: 1,
    rules: [{ name: "Smoke rule", enabled: true, models: ["release-smoke/opaque-reviewer"], profile: "sonnet-5.5", customEnabled: true, code: 'body.max_tokens = 321; body.metadata = { user_id: "smoke-custom-rule" }; return body;' }],
  };
  assert.deepEqual(await api("/api/plugin-pages/options", { spec: installed, options }), options);
  const routed = await until(async () => {
    const request = await send();
    assert.equal(request.model, "opaque-reviewer", "reviewer route");
    assert.equal(request.metadata?.user_id, "smoke-custom-rule", "custom rule output");
    return request;
  }, "saved rules in gateway");
  assert.equal(routed.thinking.type, "between_tools");
  assert.equal(routed.temperature, undefined);
  assert.ok(routed.max_tokens >= 321); // Magpie may add thinking-token headroom after the hook.
  const state = (await api("/api/plugins")).plugins.find(plugin => plugin.spec === installed);
  assert.equal(state.middleware.failures, 0);
  assert.equal((await send(false)).model, "opaque-session");
  check("native options API persists settings; real moejs pins only reviews and executes preset plus custom code");

  await run(magpie, ["plugin", "add", installed]);
  entries = JSON.parse(await readFile(registry, "utf8")).plugins;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].options, options);
  check("reinstallation preserves saved model and rules without duplicating the plugin");
  await run(magpie, ["plugin", "rm", installed]);
  entries = JSON.parse(await readFile(registry, "utf8")).plugins || [];
  assert.equal(entries.length, 0);
  check("uninstall removes the plugin from the isolated registry");
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (gateway?.pid && gateway.exitCode === null) {
    if (process.platform === "win32") await run("taskkill", ["/pid", String(gateway.pid), "/T", "/F"]).catch(() => gateway.kill());
    else { try { process.kill(-gateway.pid, "SIGTERM"); } catch { gateway.kill(); } }
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(join(sandbox, "test-report.json"), JSON.stringify(report, null, 2) + "\n");
  // The web key is specific to this throwaway sandbox; keep it out of saved logs.
  await writeFile(join(sandbox, "magpie.log"), logs.replaceAll(env?.MAGPIE_WEB_KEY || "unused-web-key", "[redacted]"));
  console.log(`Sandbox and report: ${sandbox}`);
}
