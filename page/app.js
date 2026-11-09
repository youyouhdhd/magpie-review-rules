(() => {
  const $ = id => document.getElementById(id);
  let draft, saved, catalog = window.MagpieReviewCatalog || {}, providerContext = "";
  const pickers = [];
  const status = (message, error = false) => { $("status").textContent = message; $("status").dataset.error = String(error); };
  function changed() { $("dirty").textContent = JSON.stringify(draft) === saved ? "所有修改已保存" : "有未保存的修改"; }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(label, action, title) {
    const node = element("button", label);
    node.type = "button";
    if (title) { node.title = title; node.setAttribute("aria-label", title); }
    node.onclick = action;
    return node;
  }
  function picker(container, label, get, set, multiple = false, initialSearch = "") {
    const root = element("div", undefined, "picker");
    const title = element("label", label);
    const search = element("input", undefined, "picker-search");
    search.type = "search"; search.placeholder = "搜索模型名称、模型 ID 或供应商";
    search.setAttribute("aria-label", `${label}：搜索`); search.value = initialSearch;
    const select = element("select");
    select.setAttribute("aria-label", label);
    const chips = element("div", undefined, "selected-models");
    const hint = element("p", "", "muted small");
    function refresh() {
      const values = multiple ? get() : [get()].filter(Boolean);
      const needle = search.value.trim().toLowerCase();
      select.replaceChildren(new Option(multiple ? "选择模型以添加…" : "选择审核模型…", ""));
      const groups = new Map();
      const available = (catalog.models || []).filter(model => !multiple || !/^(auto|group)\//.test(model.id));
      for (const model of available) {
        if (multiple && values.includes(model.id)) continue;
        if (needle && !`${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(needle)) continue;
        const provider = model.provider || model.id.split("/")[0];
        if (!groups.has(provider)) { const group = element("optgroup"); group.label = provider; groups.set(provider, group); select.append(group); }
        groups.get(provider).append(new Option(model.name === model.id ? model.id : `${model.name} · ${model.id}`, model.id));
      }
      if (!multiple && get()) {
        if (!Array.from(select.options).some(option => option.value === get())) select.append(new Option(`${get()}（当前筛选外或未列出）`, get()));
        select.value = get();
      }
      chips.replaceChildren();
      if (multiple) for (const value of values) chips.append(button(`${value} ×`, () => { set(get().filter(item => item !== value)); refresh(); changed(); }, `移除目标模型 ${value}`));
      const missing = values.filter(value => !(catalog.models || []).some(model => model.id === value));
      hint.textContent = missing.length ? `当前列表未列出：${missing.join("、")}。请确认模型仍在 Magpie 中启用。` : `${available.length} 个模型，来自 Magpie 网关的现有模型列表。`;
    }
    search.oninput = refresh;
    select.onchange = () => { if (!select.value) return; set(multiple ? [...get(), select.value] : select.value); refresh(); changed(); };
    root.append(title, search, select, chips, hint); container.append(root);
    pickers.push(refresh); refresh();
    return { search, select };
  }
  function renderRules() {
    $("rules").replaceChildren(); pickers.length = 1;
    $("empty-rules").hidden = draft.rules.length !== 0;
    draft.rules.forEach((rule, index) => {
      const card = element("article", undefined, "card rule");
      const head = element("div", undefined, "row");
      const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled; enabled.setAttribute("aria-label", `启用规则 ${index + 1}`);
      enabled.onchange = () => { rule.enabled = enabled.checked; changed(); };
      const name = element("input", undefined, "rule-name"); name.value = rule.name; name.maxLength = 100; name.setAttribute("aria-label", `规则 ${index + 1} 名称`);
      name.oninput = () => { rule.name = name.value; changed(); };
      const actions = element("div", undefined, "rule-actions");
      const up = button("↑", () => { [draft.rules[index - 1], draft.rules[index]] = [rule, draft.rules[index - 1]]; renderRules(); changed(); }, `上移规则 ${index + 1}`); up.disabled = index === 0;
      const down = button("↓", () => { [draft.rules[index], draft.rules[index + 1]] = [draft.rules[index + 1], rule]; renderRules(); changed(); }, `下移规则 ${index + 1}`); down.disabled = index === draft.rules.length - 1;
      actions.append(up, down, button("移除", () => { draft.rules.splice(index, 1); renderRules(); changed(); }, `移除规则 ${index + 1}`));
      head.append(enabled, name, actions); card.append(head);
      picker(card, `规则 ${index + 1}：目标模型`, () => rule.models, models => { rule.models = models; }, true, rule.models.length ? "" : providerContext);
      const label = element("label", "按哪种模型规则处理？", "field-label");
      const profile = element("select", undefined, "profile"); profile.setAttribute("aria-label", `规则 ${index + 1}：Claude 规则`);
      for (const [value, text] of Object.entries(catalog.profiles || {})) profile.append(new Option(text, value));
      profile.value = rule.profile;
      const note = element("p", "使用模型的真实能力，与第三方提供的模型名字无关。", "muted small profile-note");
      const customLabel = element("label", undefined, "switch");
      const custom = element("input"); custom.type = "checkbox"; custom.checked = rule.customEnabled;
      customLabel.append(custom, document.createTextNode("追加自定义 JavaScript"));
      const codeBox = element("div");
      const code = element("textarea", undefined, "code"); code.value = rule.code; code.maxLength = 16000; code.spellcheck = false; code.setAttribute("aria-label", `规则 ${index + 1}：自定义 JavaScript`);
      code.oninput = () => { rule.code = code.value; changed(); };
      const examples = element("div", undefined, "examples");
      const put = source => { code.value = rule.code = source; changed(); };
      examples.append(button("示例：Adaptive", () => put('body.thinking = { type: "adaptive" };\nreturn body;')),
        button("示例：删除采样参数", () => put('delete body.temperature;\ndelete body.top_p;\nreturn body;')),
        button("示例：只处理审核请求", () => put('if (ctx.review) {\n  body.max_tokens = Math.max(body.max_tokens || 64, 128);\n}\nreturn body;')));
      codeBox.append(element("p", "先应用上面的 Claude 规则，再运行此代码。可直接修改 body；不需要填写 API 密钥。", "muted small"), code, examples);
      function showCode() { custom.disabled = rule.profile === "custom"; custom.checked = rule.customEnabled || rule.profile === "custom"; codeBox.hidden = !custom.checked; }
      profile.onchange = () => { rule.profile = profile.value; showCode(); changed(); };
      custom.onchange = () => { rule.customEnabled = custom.checked; showCode(); changed(); };
      card.append(label, profile, note, customLabel, codeBox); $("rules").append(card); showCode();
    });
  }
  function render() {
    pickers.length = 0;
    $("enabled").checked = draft.enabled;
    $("reviewer-enabled").checked = draft.reviewerEnabled;
    $("reviewer-picker").replaceChildren();
    const reviewer = picker($("reviewer-picker"), "审核模型", () => draft.reviewer, value => { draft.reviewer = value; });
    function reviewEnabled() { reviewer.search.disabled = reviewer.select.disabled = !draft.reviewerEnabled; }
    $("reviewer-enabled").onchange = () => { draft.reviewerEnabled = $("reviewer-enabled").checked; reviewEnabled(); changed(); };
    $("enabled").onchange = () => { draft.enabled = $("enabled").checked; changed(); };
    renderRules(); reviewEnabled(); changed();
  }
  function validate() {
    if (draft.reviewerEnabled && !draft.reviewer) throw new Error("请选择审核模型，或关闭固定审核模型。");
    for (const rule of draft.rules) {
      if (!rule.name.trim()) throw new Error("请为每条规则填写名称。");
      if (!rule.models.length) throw new Error(`规则「${rule.name}」至少选择一个目标模型。`);
      if ((rule.customEnabled || rule.profile === "custom") && !rule.code.trim()) throw new Error(`规则「${rule.name}」需要自定义代码。`);
    }
    if (draft.rules.length > 30 || new TextEncoder().encode(JSON.stringify(draft)).length > 50000) throw new Error("配置过大：最多 30 条规则，总大小 50 KB。");
  }
  function catalogArrived() {
    catalog = window.MagpieReviewCatalog || {};
    for (const refresh of pickers) refresh();
    $("catalog-status").textContent = catalog.error || (catalog.updatedAt ? `模型列表更新于 ${new Date(catalog.updatedAt).toLocaleString()}。每 15 秒同步一次，供应商变化后可重新读取。` : "模型列表正在准备。");
  }
  window.addEventListener("review-catalog", catalogArrived);
  $("reload-models").onclick = () => {
    const script = document.createElement("script"); script.src = `catalog.js?t=${Date.now()}`;
    script.onload = () => { script.remove(); catalogArrived(); status("已刷新现有模型列表。"); };
    script.onerror = () => { script.remove(); status("模型列表加载失败，请重新打开此页面。", true); };
    document.head.append(script);
  };
  $("add-rule").onclick = () => {
    draft.rules.push({ name: `规则 ${draft.rules.length + 1}`, enabled: true, models: [], profile: "sonnet-5.5", customEnabled: false, code: "return body;" });
    renderRules(); changed(); $("rules").lastElementChild.scrollIntoView({ block: "nearest" });
  };
  $("revert").onclick = () => { draft = JSON.parse(saved); render(); status("已恢复为保存的配置。"); };
  $("save").onclick = async () => {
    $("save").disabled = true;
    try {
      validate();
      const current = await magpie.options.get();
      if (current.revision !== JSON.parse(saved).revision) throw new Error("另一个窗口已修改配置，请重新打开页面后再保存。");
      await magpie.options.set({ ...current, ...draft, revision: Date.now() });
      status("已保存，正在重新载入规则和模型列表…");
      location.reload();
    } catch (error) { status(error.message, true); $("save").disabled = false; }
  };
  (async () => {
    await magpie.ready;
    providerContext = magpie.context && magpie.context.provider ? magpie.context.provider.id : "";
    magpie.onAction(action => { providerContext = action.provider ? action.provider.id : ""; });
    if (!catalog.defaults) throw new Error(catalog.error || "插件的模型列表服务尚未准备好，请重新打开页面。");
    const options = await magpie.options.get();
    draft = { ...structuredClone(catalog.defaults), ...options };
    saved = JSON.stringify(draft);
    render(); catalogArrived(); $("content").hidden = false;
    if (catalog.validation && catalog.revision === options.revision) status(`配置需要修正：${catalog.validation}`, true);
    else status(draft.enabled ? "规则已启用。保存后立即生效，无需重启 Desktop。" : "规则已停用。可修改配置后重新启用。");
  })().catch(error => status(error.message, true));
})();
