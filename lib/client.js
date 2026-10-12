/**
 * dsh-turn-metrics — Browser Client half
 *
 * 在每轮会话底部（conversation.chat.turnTail）显示：
 *   1. TTFT（首字时间：首步 / 均值 / 累计）
 *   2. 预读取（Prefill / PP：输入 Token、预读取速度 tok/s、耗时、缓存命中率）
 *   3. 解码（Decode / TG：输出 Token、思考 Token、解码速度 tok/s、耗时）
 *   4. 本地 llama-server 硬件级 timings（真实增量 prompt eval、eval、MTP/DFlash 草稿接受率）
 *   5. 点击一键展开本轮逐步骤（Step #1, #2...）详细拆解表
 */
window.__ModuleLoader__.load({
  id: "dsh-turn-metrics",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useSyncExternalStore = React.useSyncExternalStore;

    var STYLE_ID = "dsh-turn-metrics-styles";
    var CSS_TEXT = [
      ".tm-wrap{display:flex;flex-direction:column;gap:6px;margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;user-select:text}",
      ".tm-bar{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;max-width:100%}",
      ".tm-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.08));border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.15));color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:12px;line-height:22px;transition:background .15s,border-color .15s}",
      ".tm-pill-btn{cursor:pointer;user-select:none}",
      ".tm-pill-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.14));color:var(--dsw-alias-label-primary)}",
      ".tm-tag{font-weight:600;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:0.01em}",
      ".tm-val{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".tm-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".tm-sep{color:var(--dsw-alias-separator-primary,rgba(127,127,127,0.35));margin:0 1px}",
      ".tm-badge-cache{display:inline-flex;align-items:center;padding:0 5px;height:16px;border-radius:4px;font-size:10.5px;line-height:16px;background:rgba(16,185,129,0.12);color:#10b981;font-weight:600}",
      ".tm-badge-hw{display:inline-flex;align-items:center;padding:0 5px;height:16px;border-radius:4px;font-size:10.5px;line-height:16px;background:rgba(56,189,248,0.13);color:#38bdf8;font-weight:600}",
      ".tm-badge-spec{display:inline-flex;align-items:center;padding:0 5px;height:16px;border-radius:4px;font-size:10.5px;line-height:16px;background:rgba(168,85,247,0.13);color:#a855f7;font-weight:600}",
      ".tm-panel{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.06));border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.18));display:flex;flex-direction:column;gap:8px;max-width:100%;overflow-x:auto}",
      ".tm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:6px 14px}",
      ".tm-kv{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 0;border-bottom:0.5px dashed var(--dsw-alias-border-l2,rgba(127,127,127,0.12))}",
      ".tm-kv-k{color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".tm-kv-v{color:var(--dsw-alias-label-primary);font-weight:500;text-align:right}",
      ".tm-table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:2px}",
      ".tm-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.18));white-space:nowrap}",
      ".tm-table td{padding:4px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.1));white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
      ".tm-table tr:last-child td{border-bottom:none}",
      ".tm-settings{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.06));border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.16));font-size:12.5px;color:var(--dsw-alias-label-primary)}",
      ".tm-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".tm-settings-title{font-weight:600;font-size:13px}",
      ".tm-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".tm-select,.tm-input{padding:4px 8px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.25));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:12px}"
    ].join("\n");

    // ---------- 插件配置状态（localStorage 持久化 + 订阅） ----------
    var CFG_KEY = "dsh-turn-metrics:config";
    var defaultConfig = {
      enabled: true,
      ppMode: "uncached",       // "uncached" = 按实际计算未缓存 Token | "total" = 按总输入 Prompt Token
      autoExpandSteps: false,   // 是否默认展开多步详情
      llamaHwEnabled: true,     // 是否匹配本地 llama-server 硬件日志
      llamaLogDir: "F:\\LocalLLM\\logs"
    };

    function loadConfig() {
      try {
        var raw = localStorage.getItem(CFG_KEY);
        if (!raw) return defaultConfig;
        var parsed = JSON.parse(raw);
        return Object.assign({}, defaultConfig, parsed || {});
      } catch (e) {
        return defaultConfig;
      }
    }

    var currentConfig = loadConfig();
    var cfgListeners = new Set();
    function subscribeConfig(fn) {
      cfgListeners.add(fn);
      return function () { cfgListeners.delete(fn); };
    }
    function getConfigSnapshot() { return currentConfig; }
    function updateConfig(patch) {
      currentConfig = Object.assign({}, currentConfig, patch);
      try { localStorage.setItem(CFG_KEY, JSON.stringify(currentConfig)); } catch (e) {}
      cfgListeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }

    // ---------- 格式化工具 ----------
    function fmtDuration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
      if (ms < 1000) return Math.round(ms) + " ms";
      var s = ms / 1000;
      if (s < 60) return s.toFixed(2) + " s";
      var m = Math.floor(s / 60);
      var rem = (s - m * 60).toFixed(1);
      return m + "m " + rem + "s";
    }

    function fmtTokCompact(n) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
      if (n < 1000) return String(Math.round(n));
      if (n < 1000000) {
        var k = n / 1000;
        return (k >= 100 ? Math.round(k) : k.toFixed(1)) + "K";
      }
      var m = n / 1000000;
      return m.toFixed(2) + "M";
    }

    function fmtTokExact(n) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
      return Math.round(n).toLocaleString();
    }

    function fmtTps(tps) {
      if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) return "—";
      return (tps >= 100 ? tps.toFixed(1) : tps.toFixed(2)) + " t/s";
    }

    function fmtPercent(p) {
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return null;
      if (p === 0) return "0%";
      if (p >= 99.95 && p < 100) return "99.9%";
      return (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + "%";
    }

    function shortModelName(model, provider) {
      var m = String(model || "");
      if (!m) return provider || "—";
      var parts = m.split(/[\\/]/);
      var last = parts[parts.length - 1] || m;
      return last.replace(/\.gguf$/i, "");
    }

    // ---------- 从前端 turn.steps 提取实时兜底数据 ----------
    function deriveFromClientTurn(turnLoc) {
      if (!turnLoc || !Array.isArray(turnLoc.steps)) return null;
      var steps = [];
      for (var i = 0; i < turnLoc.steps.length; i++) {
        var stepLoc = turnLoc.steps[i];
        var aStep = stepLoc && stepLoc.data && typeof stepLoc.data.get === "function" ? stepLoc.data.get("assistant-step") : null;
        if (!aStep) continue;
        var fn = aStep.finalNode;
        var usage = (fn && fn.usage) || aStep.usage || {};
        var timing = (fn && fn.timing) || {};
        var startT = typeof timing.stepStartTime === "number" ? timing.stepStartTime : (stepLoc.start && typeof stepLoc.start.time === "number" ? stepLoc.start.time : null);
        var firstT = typeof timing.firstTokenTime === "number" ? timing.firstTokenTime : null;
        var endT = typeof timing.completedTime === "number" ? timing.completedTime : (fn && typeof fn.time === "number" ? fn.time : null);
        var ttftMs = (startT !== null && firstT !== null) ? Math.max(0, firstT - startT) : null;
        var decodeMs = (firstT !== null && endT !== null) ? Math.max(0, endT - firstT) : null;
        var llmMs = (startT !== null && endT !== null) ? Math.max(0, endT - startT) : null;
        var inTok = Number(usage.inputTokens || 0);
        var crTok = Number(usage.cacheReadTokens || 0);
        var cwTok = Number(usage.cacheWriteTokens || 0);
        var outTok = Number(usage.outputTokens || 0);
        var rTok = Number(usage.reasoningTokens || 0);
        var totTok = Number(usage.totalTokens || 0);
        var promptTok = totTok > outTok ? Math.max(inTok + crTok + cwTok, totTok - outTok) : (inTok + crTok + cwTok);
        var prefillTok = inTok + cwTok;
        steps.push({
          step: aStep.step || (i + 1),
          ttftMs: ttftMs,
          decodeMs: decodeMs,
          llmMs: llmMs,
          inputTokens: inTok,
          cacheReadTokens: crTok,
          cacheWriteTokens: cwTok,
          promptTokens: promptTok,
          prefillTokens: prefillTok,
          outputTokens: outTok,
          reasoningTokens: rTok,
          totalTokens: totTok || (promptTok + outTok),
          ppTpsUncached: (ttftMs && ttftMs > 0 && prefillTok > 0) ? (prefillTok / (ttftMs / 1000)) : null,
          ppTpsTotal: (ttftMs && ttftMs > 0 && promptTok > 0) ? (promptTok / (ttftMs / 1000)) : null,
          tgTps: (decodeMs && decodeMs > 0 && outTok > 0) ? (outTok / (decodeMs / 1000)) : null,
          cacheHitPercent: promptTok > 0 ? (crTok / promptTok) * 100 : null,
          provider: "",
          model: ""
        });
      }
      if (!steps.length) return null;
      var firstStepTtftMs = null, totalTtftMs = 0, ttftSteps = 0, decodeMs = 0, llmMs = 0;
      var inTokSum = 0, crTokSum = 0, cwTokSum = 0, promptTokSum = 0, prefillTokSum = 0, outTokSum = 0, rTokSum = 0;
      for (var j = 0; j < steps.length; j++) {
        var s = steps[j];
        if (typeof s.ttftMs === "number") {
          if (firstStepTtftMs === null) firstStepTtftMs = s.ttftMs;
          totalTtftMs += s.ttftMs;
          ttftSteps += 1;
        }
        if (typeof s.decodeMs === "number") decodeMs += s.decodeMs;
        if (typeof s.llmMs === "number") llmMs += s.llmMs;
        inTokSum += s.inputTokens; crTokSum += s.cacheReadTokens; cwTokSum += s.cacheWriteTokens;
        promptTokSum += s.promptTokens; prefillTokSum += s.prefillTokens;
        outTokSum += s.outputTokens; rTokSum += s.reasoningTokens;
      }
      var startMs = turnLoc.start && typeof turnLoc.start.time === "number" ? turnLoc.start.time : null;
      var endMs = turnLoc.end && typeof turnLoc.end.time === "number" ? turnLoc.end.time : null;
      return {
        turn: turnLoc.turn,
        stepsCount: steps.length,
        firstStepTtftMs: firstStepTtftMs,
        totalTtftMs: totalTtftMs,
        avgTtftMs: ttftSteps > 0 ? totalTtftMs / ttftSteps : null,
        ttftSteps: ttftSteps,
        prefillMs: totalTtftMs,
        inputTokens: inTokSum,
        cacheReadTokens: crTokSum,
        cacheWriteTokens: cwTokSum,
        promptTokens: promptTokSum,
        prefillTokens: prefillTokSum,
        ppTpsUncached: (totalTtftMs > 0 && prefillTokSum > 0) ? (prefillTokSum / (totalTtftMs / 1000)) : null,
        ppTpsTotal: (totalTtftMs > 0 && promptTokSum > 0) ? (promptTokSum / (totalTtftMs / 1000)) : null,
        cacheHitPercent: promptTokSum > 0 ? (crTokSum / promptTokSum) * 100 : null,
        decodeMs: decodeMs,
        outputTokens: outTokSum,
        reasoningTokens: rTokSum,
        tgTps: (decodeMs > 0 && outTokSum > 0) ? (outTokSum / (decodeMs / 1000)) : null,
        llmMs: llmMs,
        toolMs: 0,
        toolCalls: 0,
        wallMs: (startMs !== null && endMs !== null && endMs >= startMs) ? (endMs - startMs) : llmMs,
        provider: "",
        model: "",
        steps: steps
      };
    }

    // ---------- Host RPC 缓存（补齐历史 jsonl.zstd 的 firstTokenTime 与 llama-server 硬件日志） ----------
    var hostSessionCache = new Map();
    function fetchHostSessionMetrics(sessionId, llamaLogDir) {
      if (!sessionId) return Promise.resolve(null);
      var now = Date.now();
      var cached = hostSessionCache.get(sessionId);
      if (cached && cached.promise && (now - cached.at < 2500)) return cached.promise;
      var p = fetch("/turn-metrics/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, llamaLogDir: llamaLogDir || "" })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok && d.turns) {
          hostSessionCache.set(sessionId, { at: Date.now(), data: d.turns, promise: Promise.resolve(d.turns) });
          return d.turns;
        }
        return null;
      }).catch(function () { return null; });
      hostSessionCache.set(sessionId, { at: now, data: cached ? cached.data : null, promise: p });
      return p;
    }

    // ---------- 每轮会话底部视图（conversation.chat.turnTail） ----------
    function TurnMetricsTailView(props) {
      var cfg = useSyncExternalStore(subscribeConfig, getConfigSnapshot);
      var turnObj = props.turn;
      var turnNum = typeof turnObj === "number" ? turnObj : (turnObj && typeof turnObj.turn === "number" ? turnObj.turn : null);
      var sessionId = props.sessionId || "";

      var proj = typeof props.useProjection === "function" ? props.useProjection("turnMetrics") : null;
      var projTurn = (proj && proj.turns && turnNum !== null) ? proj.turns[String(turnNum)] : null;
      var clientTurn = useMemo(function () {
        return typeof turnObj === "object" && turnObj !== null ? deriveFromClientTurn(turnObj) : null;
      }, [turnObj, props.seq]);

      var _hostState = useState(function () {
        var c = hostSessionCache.get(sessionId);
        return (c && c.data && turnNum !== null) ? c.data[String(turnNum)] : null;
      });
      var hostTurn = _hostState[0];
      var setHostTurn = _hostState[1];

      var _openState = useState(false);
      var manualOpen = _openState[0];
      var setManualOpen = _openState[1];

      useEffect(function () {
        var alive = true;
        if (!cfg.enabled || !sessionId || turnNum === null) return;
        fetchHostSessionMetrics(sessionId, cfg.llamaLogDir).then(function (turns) {
          if (alive && turns && turns[String(turnNum)]) {
            setHostTurn(turns[String(turnNum)]);
          }
        });
        return function () { alive = false; };
      }, [sessionId, turnNum, props.seq, projTurn && projTurn.stepsCount, cfg.enabled, cfg.llamaHwEnabled, cfg.llamaLogDir]);

      if (!cfg.enabled || turnNum === null) return null;

      var data = hostTurn || projTurn || clientTurn;
      if (!data && projTurn) data = projTurn;
      if (projTurn && hostTurn && (projTurn.stepsCount > (hostTurn.stepsCount || 0))) {
        data = Object.assign({}, projTurn, { llamaHw: hostTurn.llamaHw });
      }
      if (!data || (!data.stepsCount && !data.outputTokens && !data.promptTokens)) return null;

      var isMultiStep = (data.stepsCount || 0) > 1;
      var isOpen = manualOpen || (cfg.autoExpandSteps && isMultiStep);

      var useTotalPp = cfg.ppMode === "total";
      var ppTok = useTotalPp ? data.promptTokens : data.prefillTokens;
      var ppTps = useTotalPp ? data.ppTpsTotal : data.ppTpsUncached;
      var cachePct = fmtPercent(data.cacheHitPercent);
      var hw = cfg.llamaHwEnabled ? data.llamaHw : null;

      // 1) TTFT 胶囊
      var ttftEl = h("span", {
        className: "tm-pill",
        title: "首字延迟 (TTFT)：从发出请求 (step/start) 到收到首个输出 Token 的耗时"
      },
        h("span", { className: "tm-tag" }, "TTFT"),
        h("span", { className: "tm-val" }, fmtDuration(data.firstStepTtftMs)),
        isMultiStep && data.avgTtftMs !== null ? h("span", { className: "tm-sub" }, "均 " + fmtDuration(data.avgTtftMs) + " · 累 " + fmtDuration(data.totalTtftMs)) : null
      );

      // 2) 预读取 (Prefill / PP) 胶囊
      var ppTitle = "预读取 (Prefill)：未缓存计算 " + fmtTokExact(data.prefillTokens) + " tok / 总输入 " + fmtTokExact(data.promptTokens) + " tok" +
        (data.cacheReadTokens > 0 ? "（缓存命中 " + fmtTokExact(data.cacheReadTokens) + " tok）" : "");
      var prefillEl = h("span", {
        className: "tm-pill",
        title: ppTitle
      },
        h("span", { className: "tm-tag" }, "预读取"),
        h("span", { className: "tm-val" }, fmtTokCompact(ppTok) + " tok"),
        ppTps !== null ? h(React.Fragment, null,
          h("span", { className: "tm-sep" }, "·"),
          h("span", { className: "tm-val" }, fmtTps(ppTps))
        ) : null,
        data.prefillMs > 0 ? h("span", { className: "tm-sub" }, "(" + fmtDuration(data.prefillMs) + ")") : null,
        data.cacheReadTokens > 0 && cachePct ? h("span", { className: "tm-badge-cache", title: "KV 缓存命中 " + fmtTokExact(data.cacheReadTokens) + " / " + fmtTokExact(data.promptTokens) + " tok" }, "缓存 " + cachePct) : null,
        hw && hw.promptTps ? h("span", { className: "tm-badge-hw", title: "llama-server 硬件实测增量 Prefill：" + fmtTokExact(hw.promptTokens) + " tok / " + fmtDuration(hw.promptMs) }, "硬件PP " + fmtTokCompact(hw.promptTokens) + " @ " + fmtTps(hw.promptTps)) : null
      );

      // 3) 解码 (Decode / TG) 胶囊
      var tgTitle = "解码 (Decode)：输出 " + fmtTokExact(data.outputTokens) + " tok" +
        (data.reasoningTokens > 0 ? "（含思考 " + fmtTokExact(data.reasoningTokens) + " tok）" : "") +
        "，耗时 " + fmtDuration(data.decodeMs);
      var decodeEl = h("span", {
        className: "tm-pill",
        title: tgTitle
      },
        h("span", { className: "tm-tag" }, "解码"),
        h("span", { className: "tm-val" }, fmtTokCompact(data.outputTokens) + " tok"),
        data.reasoningTokens > 0 ? h("span", { className: "tm-sub" }, "(思 " + fmtTokCompact(data.reasoningTokens) + ")") : null,
        data.tgTps !== null ? h(React.Fragment, null,
          h("span", { className: "tm-sep" }, "·"),
          h("span", { className: "tm-val" }, fmtTps(data.tgTps))
        ) : null,
        data.decodeMs > 0 ? h("span", { className: "tm-sub" }, "(" + fmtDuration(data.decodeMs) + ")") : null,
        hw && hw.evalTps ? h("span", { className: "tm-badge-hw", title: "llama-server 硬件实测 Decode：" + fmtTokExact(hw.evalTokens) + " tok / " + fmtDuration(hw.evalMs) }, "硬件TG " + fmtTps(hw.evalTps)) : null,
        hw && hw.draftAcceptance !== null ? h("span", { className: "tm-badge-spec", title: "推测解码草稿接受率：" + hw.draftAccepted + "/" + hw.draftGenerated + (hw.draftMeanLen ? "，平均步长 " + hw.draftMeanLen.toFixed(2) : "") }, "草稿 " + hw.draftAcceptance.toFixed(1) + "%" + (hw.draftMeanLen ? " L" + hw.draftMeanLen.toFixed(2) : "")) : null
      );

      // 4) 展开/收起按钮（步数 + 总耗时）
      var toggleBtn = h("button", {
        type: "button",
        className: "tm-pill tm-pill-btn",
        onClick: function () { setManualOpen(!isOpen); },
        title: "点击展开/收起本轮每步预读取、解码与 TTFT 明细"
      },
        h("span", { className: "tm-sub" }, (data.stepsCount || 1) + " 步"),
        data.wallMs !== null ? h(React.Fragment, null,
          h("span", { className: "tm-sep" }, "·"),
          h("span", { className: "tm-val" }, "总 " + fmtDuration(data.wallMs))
        ) : null,
        h("span", { className: "tm-sub" }, isOpen ? "▴" : "▾")
      );

      // 展开面板
      var detailPanel = null;
      if (isOpen) {
        var kvs = [
          ["首步 TTFT", fmtDuration(data.firstStepTtftMs)],
          ["平均 / 累计 TTFT", fmtDuration(data.avgTtftMs) + " / " + fmtDuration(data.totalTtftMs)],
          ["预读取 (未缓存计算)", fmtTokExact(data.prefillTokens) + " tok · " + fmtTps(data.ppTpsUncached)],
          ["总输入 (含缓存)", fmtTokExact(data.promptTokens) + " tok · " + fmtTps(data.ppTpsTotal)],
          ["KV 缓存命中", fmtTokExact(data.cacheReadTokens) + " tok (" + (cachePct || "0%") + ")"],
          ["解码输出 (含思考)", fmtTokExact(data.outputTokens) + " tok" + (data.reasoningTokens > 0 ? " (思考 " + fmtTokExact(data.reasoningTokens) + ")" : "")],
          ["解码速度 / 耗时", fmtTps(data.tgTps) + " · " + fmtDuration(data.decodeMs)],
          ["模型耗时 / 工具耗时", fmtDuration(data.llmMs) + (data.toolCalls > 0 ? " / 工具 " + fmtDuration(data.toolMs) + " (" + data.toolCalls + "次)" : " / 无工具")],
          ["提供方 / 模型", (data.provider ? data.provider + " / " : "") + shortModelName(data.model, data.provider)]
        ];
        if (hw) {
          kvs.push(["llama-server 硬件 PP", fmtTokExact(hw.promptTokens) + " tok · " + fmtTps(hw.promptTps) + " (" + fmtDuration(hw.promptMs) + ")"]);
          kvs.push(["llama-server 硬件 TG", fmtTokExact(hw.evalTokens) + " tok · " + fmtTps(hw.evalTps) + " (" + fmtDuration(hw.evalMs) + ")"]);
          if (hw.draftAcceptance !== null) {
            kvs.push(["MTP/DFlash 草稿接受率", hw.draftAcceptance.toFixed(1) + "% (" + hw.draftAccepted + "/" + hw.draftGenerated + ")" + (hw.draftMeanLen ? " · mean len " + hw.draftMeanLen.toFixed(2) : "")]);
          }
        }

        var stepRows = (data.steps || []).map(function (s, idx) {
          var sHw = cfg.llamaHwEnabled ? s.llamaHw : null;
          var sCache = fmtPercent(s.cacheHitPercent);
          return h("tr", { key: s.step || idx },
            h("td", null, "#" + (s.step || (idx + 1))),
            h("td", { title: (s.provider ? s.provider + "/" : "") + (s.model || "") }, shortModelName(s.model || data.model, s.provider || data.provider)),
            h("td", null, fmtDuration(s.ttftMs)),
            h("td", null,
              fmtTokExact(s.prefillTokens) + " / " + fmtTokExact(s.promptTokens) + " tok",
              sCache && s.cacheReadTokens > 0 ? " (缓存 " + sCache + ")" : ""
            ),
            h("td", null,
              fmtTps(useTotalPp ? s.ppTpsTotal : s.ppTpsUncached),
              sHw && sHw.promptTps ? " [HW: " + fmtTokCompact(sHw.promptTokens) + "@" + fmtTps(sHw.promptTps) + "]" : ""
            ),
            h("td", null,
              fmtTokExact(s.outputTokens) + " tok",
              s.reasoningTokens > 0 ? " (思 " + fmtTokExact(s.reasoningTokens) + ")" : ""
            ),
            h("td", null,
              fmtTps(s.tgTps) + " (" + fmtDuration(s.decodeMs) + ")",
              sHw && sHw.evalTps ? " [HW: " + fmtTps(sHw.evalTps) + "]" : ""
            ),
            h("td", null, fmtDuration(s.llmMs))
          );
        });

        detailPanel = h("div", { className: "tm-panel" },
          h("div", { className: "tm-grid" },
            kvs.map(function (pair, idx) {
              return h("div", { key: idx, className: "tm-kv" },
                h("span", { className: "tm-kv-k" }, pair[0]),
                h("span", { className: "tm-kv-v" }, pair[1])
              );
            })
          ),
          stepRows.length > 0 ? h("table", { className: "tm-table" },
            h("thead", null,
              h("tr", null,
                h("th", null, "步骤"),
                h("th", null, "模型"),
                h("th", null, "TTFT (预读耗时)"),
                h("th", null, "预读取 (计算/总输入)"),
                h("th", null, "预读取速度"),
                h("th", null, "解码 Token"),
                h("th", null, "解码速度 (耗时)"),
                h("th", null, "单步总耗时")
              )
            ),
            h("tbody", null, stepRows)
          ) : null
        );
      }

      return h("div", { className: "tm-wrap", "data-turn-metrics": turnNum },
        h("div", { className: "tm-bar" }, ttftEl, prefillEl, decodeEl, toggleBtn),
        detailPanel
      );
    }

    // ---------- 插件设置面板（settings.plugin.item） ----------
    function TurnMetricsSettingsCard() {
      var cfg = useSyncExternalStore(subscribeConfig, getConfigSnapshot);
      return h("div", { className: "tm-settings" },
        h("div", { className: "tm-settings-row" },
          h("div", null,
            h("div", { className: "tm-settings-title" }, "显示每轮预读取 / 解码 / TTFT 指标"),
            h("div", { className: "tm-settings-desc" }, "在每轮会话回复底部展示 TTFT、预读取速度与耗时、解码速度与耗时及逐步骤明细。")
          ),
          h("input", {
            type: "checkbox",
            checked: !!cfg.enabled,
            onChange: function (e) { updateConfig({ enabled: !!e.target.checked }); }
          })
        ),
        h("div", { className: "tm-settings-row" },
          h("div", null,
            h("div", { className: "tm-settings-title" }, "预读取 (Prefill) 速度计算口径"),
            h("div", { className: "tm-settings-desc" }, "选择按未缓存实际重算 Token 还是按总输入 Prompt Token 计算 PP 速度。")
          ),
          h("select", {
            className: "tm-select",
            value: cfg.ppMode || "uncached",
            onChange: function (e) { updateConfig({ ppMode: e.target.value }); }
          },
            h("option", { value: "uncached" }, "未缓存实际计算 Token (input + cacheWrite)"),
            h("option", { value: "total" }, "总输入 Prompt Token (含缓存命中)")
          )
        ),
        h("div", { className: "tm-settings-row" },
          h("div", null,
            h("div", { className: "tm-settings-title" }, "多步轮次默认展开步骤明细表"),
            h("div", { className: "tm-settings-desc" }, "当一轮包含多次工具调用（多个 Step）时自动展开逐步骤表格。")
          ),
          h("input", {
            type: "checkbox",
            checked: !!cfg.autoExpandSteps,
            onChange: function (e) { updateConfig({ autoExpandSteps: !!e.target.checked }); }
          })
        ),
        h("div", { className: "tm-settings-row" },
          h("div", null,
            h("div", { className: "tm-settings-title" }, "关联本地 llama-server 硬件日志 (PP / TG / 草稿接受率)"),
            h("div", { className: "tm-settings-desc" }, "从本地日志目录匹配真实增量 prompt eval、eval 速度与 MTP/DFlash 草稿接受率。")
          ),
          h("input", {
            type: "checkbox",
            checked: !!cfg.llamaHwEnabled,
            onChange: function (e) { updateConfig({ llamaHwEnabled: !!e.target.checked }); }
          })
        ),
        cfg.llamaHwEnabled ? h("div", { className: "tm-settings-row" },
          h("div", { className: "tm-settings-desc" }, "llama-server 日志目录"),
          h("input", {
            type: "text",
            className: "tm-input",
            style: { width: "240px" },
            value: cfg.llamaLogDir || "",
            onChange: function (e) { updateConfig({ llamaLogDir: e.target.value }); }
          })
        ) : null
      );
    }

    // ---------- 插件挂载入口 ----------
    function apply(ctx) {
      return ctx.effect(function () {
        var styleTag = null;
        if (typeof document !== "undefined") {
          styleTag = document.getElementById(STYLE_ID);
          if (!styleTag) {
            styleTag = document.createElement("style");
            styleTag.id = STYLE_ID;
            styleTag.textContent = CSS_TEXT;
            document.head.appendChild(styleTag);
          }
        }
        var disposers = [];
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          var d1 = ctx.slots.inject("conversation.chat.turnTail", function () {
            return ctx.slots.register({
              name: "conversation.chat.turnTail",
              id: "dsh-turn-metrics-tail",
              order: 5
            }, TurnMetricsTailView);
          });
          if (typeof d1 === "function") disposers.push(d1);

          var d2 = ctx.slots.inject("settings.plugin.item", function () {
            return ctx.slots.register({
              name: "settings.plugin.item",
              key: "dsh-turn-metrics",
              id: "dsh-turn-metrics-settings",
              order: 25
            }, TurnMetricsSettingsCard);
          });
          if (typeof d2 === "function") disposers.push(d2);
        }
        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (e) {}
          }
          if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
        };
      }, "dsh-turn-metrics: client mount");
    }

    return {
      name: "dsh-turn-metrics",
      inject: ["slots", "sessions", "conversation"],
      apply: apply
    };
  }
});


