/**
 * dsh-turn-metrics — Host half
 *
 * 功能：
 *  1. 注册 `turnMetrics` 会话投影单元（ctx.sessionProjections），对每个会话的
 *     turn/start、step/start、assistant/attempt、assistant/message、tool/call、
 *     tool/result、step/end、turn/end 事件进行纯函数折叠，精确产出每一轮（Turn）
 *     及轮内每一步（Step）的：
 *       - TTFT（首字时间：首步 TTFT、总 TTFT、平均 TTFT、各步 TTFT）
 *       - 预读取（Prefill / PP：未缓存输入 Token、缓存读取/写入 Token、总输入 Token、耗时与 tok/s 速度）
 *       - 解码（Decode / TG：输出 Token、推理 Token、解码耗时与 tok/s 速度）
 *       - 工具耗时与整轮墙钟耗时
 *  2. 注册 HTTP 路由：
 *       - POST /turn-metrics/session ：返回指定会话的按轮指标（支持内存快照与 .jsonl.zstd 离线流式回放），
 *         并在检测到本地 llama-server 模型时自动从 F:\LocalLLM\logs 最新日志关联硬件级 prompt eval /
 *         eval timings 与 MTP/DFlash 草稿接受率（draft acceptance & mean len）。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

export const name = 'dsh-turn-metrics';
export const inject = ['webServer', 'sessions'];

const ZSTD_MAGIC = 0xFD2FB528;
const DEFAULT_LLAMA_LOG_DIR = 'F:\\LocalLLM\\logs';
const PASSTHROUGH_SCHEMA = { parse: (v) => v };

function isTokenDeltaChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== '';
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || chunk.name !== undefined;
    default:
      return false;
  }
}

function runFirstTokenTime(run) {
  if (!run || typeof run !== 'object' || typeof run.time0 !== 'number') return null;
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0;
  const arr = run.type === 'tool-call-chunks' ? run.args : run.texts;
  if (!Array.isArray(arr)) return null;
  const dt = Array.isArray(run.dt) ? run.dt : [];
  let t = run.time0;
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) t += Number(dt[i - 1] || 0);
    if (typeof arr[i] === 'string' && arr[i] !== '') return t;
  }
  return null;
}

export function extractStreamTimingAndUsage(stream) {
  if (!Array.isArray(stream)) return { firstTokenTime: null, lastTokenTime: null, usage: null, hasReasoning: false };
  let firstTokenTime = null;
  let lastTokenTime = null;
  let usage = null;
  let hasReasoning = false;
  for (let i = 0; i < stream.length; i++) {
    const rec = stream[i];
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'chunk') {
      const c = rec.chunk;
      if (c && typeof c === 'object') {
        if (c.type === 'reasoning-delta' || (c.type === 'block-start' && c.blockType === 'reasoning')) hasReasoning = true;
        if (c.type === 'usage' && c.usage) usage = c.usage;
        if (isTokenDeltaChunk(c) && typeof rec.time === 'number') {
          if (firstTokenTime === null) firstTokenTime = rec.time;
          lastTokenTime = rec.time;
        }
      }
    } else if (rec.type === 'text-chunks' || rec.type === 'reasoning-chunks' || rec.type === 'tool-call-chunks') {
      if (rec.type === 'reasoning-chunks') hasReasoning = true;
      if (firstTokenTime === null) {
        const ft = runFirstTokenTime(rec);
        if (ft !== null) firstTokenTime = ft;
      }
      if (typeof rec.time0 === 'number') {
        const dt = Array.isArray(rec.dt) ? rec.dt : [];
        let endT = rec.time0;
        for (let j = 0; j < dt.length; j++) endT += Number(dt[j] || 0);
        lastTokenTime = endT;
      }
    }
  }
  return { firstTokenTime, lastTokenTime, usage, hasReasoning };
}

function normalizeStepUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const inputTokens = num(raw.inputTokens ?? raw.input);
  const outputTokens = num(raw.outputTokens ?? raw.output);
  const cacheReadTokens = num(raw.cacheReadTokens ?? raw.cacheRead);
  const cacheWriteTokens = num(raw.cacheWriteTokens ?? raw.cacheWrite);
  const reasoningTokens = num(raw.reasoningTokens ?? raw.reasoning);
  const rawTotal = num(raw.totalTokens);
  const sumPrompt = inputTokens + cacheReadTokens + cacheWriteTokens;
  const promptTokens = rawTotal > outputTokens ? Math.max(sumPrompt, rawTotal - outputTokens) : sumPrompt;
  const prefillTokens = inputTokens + cacheWriteTokens;
  const totalTokens = rawTotal > 0 ? rawTotal : promptTokens + outputTokens;
  return { inputTokens, cacheReadTokens, cacheWriteTokens, promptTokens, prefillTokens, outputTokens, reasoningTokens, totalTokens };
}

function emptyTurnSummary(turn, startSeq = null, startTime = null) {
  return {
    turn, startSeq, endSeq: null, startTime, endTime: null, status: 'running',
    stepsCount: 0, firstStepTtftMs: null, totalTtftMs: 0, avgTtftMs: null, ttftSteps: 0,
    prefillMs: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0, prefillTokens: 0,
    ppTpsUncached: null, ppTpsTotal: null, cacheHitPercent: null,
    decodeMs: 0, outputTokens: 0, reasoningTokens: 0, tgTps: null,
    llmMs: 0, toolMs: 0, toolCalls: 0, wallMs: null,
    provider: '', model: '', steps: [],
  };
}

function recomputeTurnAggregates(t) {
  let firstStepTtftMs = null, totalTtftMs = 0, ttftSteps = 0, prefillMs = 0;
  let inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, promptTokens = 0, prefillTokens = 0;
  let decodeMs = 0, outputTokens = 0, reasoningTokens = 0, llmMs = 0;
  let provider = t.provider || '', model = t.model || '';
  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i];
    if (s.provider) provider = s.provider;
    if (s.model) model = s.model;
    if (typeof s.ttftMs === 'number' && s.ttftMs >= 0) {
      if (firstStepTtftMs === null) firstStepTtftMs = s.ttftMs;
      totalTtftMs += s.ttftMs;
      prefillMs += s.ttftMs;
      ttftSteps += 1;
    }
    if (typeof s.decodeMs === 'number' && s.decodeMs >= 0) decodeMs += s.decodeMs;
    if (typeof s.llmMs === 'number' && s.llmMs >= 0) llmMs += s.llmMs;
    inputTokens += s.inputTokens || 0;
    cacheReadTokens += s.cacheReadTokens || 0;
    cacheWriteTokens += s.cacheWriteTokens || 0;
    promptTokens += s.promptTokens || 0;
    prefillTokens += s.prefillTokens || 0;
    outputTokens += s.outputTokens || 0;
    reasoningTokens += s.reasoningTokens || 0;
  }
  const avgTtftMs = ttftSteps > 0 ? totalTtftMs / ttftSteps : null;
  const ppTpsUncached = prefillMs > 0 && prefillTokens > 0 ? (prefillTokens / (prefillMs / 1000)) : null;
  const ppTpsTotal = prefillMs > 0 && promptTokens > 0 ? (promptTokens / (prefillMs / 1000)) : null;
  const cacheHitPercent = promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : null;
  const tgTps = decodeMs > 0 && outputTokens > 0 ? (outputTokens / (decodeMs / 1000)) : null;
  const wallMs = (typeof t.startTime === 'number' && typeof t.endTime === 'number' && t.endTime >= t.startTime)
    ? (t.endTime - t.startTime)
    : (llmMs + (t.toolMs || 0));
  return {
    ...t, stepsCount: t.steps.length, firstStepTtftMs, totalTtftMs, avgTtftMs, ttftSteps,
    prefillMs, inputTokens, cacheReadTokens, cacheWriteTokens, promptTokens, prefillTokens,
    ppTpsUncached, ppTpsTotal, cacheHitPercent, decodeMs, outputTokens, reasoningTokens, tgTps,
    llmMs, wallMs, provider, model,
  };
}

export const turnMetricsProjectionDefinition = {
  key: 'turnMetrics',
  stateVersion: 1,
  stateSchema: PASSTHROUGH_SCHEMA,
  init: () => ({
    turns: {},
    activeTurn: null,
    openStep: null,
    pendingCalls: {},
    lastHeader: { provider: '', model: '' },
  }),
  apply: (state, event) => {
    if (!event || typeof event !== 'object') return state;
    const data = event.data ?? {};
    switch (event.type) {
      case 'request/header': {
        const cfg = data.header?.config ?? {};
        const provider = typeof cfg.provider === 'string' ? cfg.provider : state.lastHeader.provider;
        const model = typeof cfg.model === 'string' ? cfg.model : state.lastHeader.model;
        if (provider === state.lastHeader.provider && model === state.lastHeader.model) return state;
        return { ...state, lastHeader: { provider, model } };
      }
      case 'turn/start': {
        const turn = data.turn;
        if (!Number.isSafeInteger(turn) || turn < 0) return state;
        const key = String(turn);
        const existing = state.turns[key] ?? emptyTurnSummary(turn, event.seq ?? null, event.time ?? null);
        const updated = {
          ...existing,
          startSeq: existing.startSeq ?? event.seq ?? null,
          startTime: existing.startTime ?? event.time ?? null,
          status: 'running',
        };
        return { ...state, activeTurn: turn, turns: { ...state.turns, [key]: updated } };
      }
      case 'step/start': {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : state.activeTurn;
        const step = data.step;
        if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;
        const key = String(turn);
        const tObj = state.turns[key] ?? emptyTurnSummary(turn, event.seq ?? null, event.time ?? null);
        return {
          ...state,
          activeTurn: turn,
          openStep: { turn, step, startSeq: event.seq ?? null, startTime: typeof event.time === 'number' ? event.time : null, firstTokenTime: null, usage: null, hasReasoning: false },
          turns: state.turns[key] ? state.turns : { ...state.turns, [key]: tObj },
        };
      }
      case 'llm/retry-started': {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : state.activeTurn;
        const step = data.step;
        if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;
        const prevFirst = (state.openStep && state.openStep.turn === turn && state.openStep.step === step) ? state.openStep.firstTokenTime : null;
        return {
          ...state,
          openStep: { turn, step, startSeq: event.seq ?? null, startTime: typeof event.time === 'number' ? event.time : null, firstTokenTime: prevFirst, usage: null, hasReasoning: false },
        };
      }
      case 'assistant/attempt': {
        const open = state.openStep;
        if (!open || open.turn !== data.turn || open.step !== data.step) return state;
        const info = extractStreamTimingAndUsage(data.stream);
        const firstTokenTime = open.firstTokenTime ?? info.firstTokenTime;
        const usage = info.usage ?? open.usage;
        const hasReasoning = open.hasReasoning || info.hasReasoning;
        if (firstTokenTime === open.firstTokenTime && usage === open.usage && hasReasoning === open.hasReasoning) return state;
        return { ...state, openStep: { ...open, firstTokenTime, usage, hasReasoning } };
      }
      case 'assistant/message': {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : state.activeTurn;
        const step = data.step;
        if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;
        const open = (state.openStep && state.openStep.turn === turn && state.openStep.step === step)
          ? state.openStep
          : { turn, step, startSeq: event.seq ?? null, startTime: null, firstTokenTime: null, usage: null, hasReasoning: false };
        const info = extractStreamTimingAndUsage(data.stream);
        const startTime = open.startTime;
        const firstTokenTime = open.firstTokenTime ?? info.firstTokenTime ?? null;
        const completedTime = typeof event.time === 'number' ? event.time : info.lastTokenTime;
        const ttftMs = (startTime !== null && firstTokenTime !== null) ? Math.max(0, firstTokenTime - startTime) : null;
        const decodeMs = (firstTokenTime !== null && completedTime !== null) ? Math.max(0, completedTime - firstTokenTime) : null;
        const llmMs = (startTime !== null && completedTime !== null) ? Math.max(0, completedTime - startTime) : null;
        const normUsage = normalizeStepUsage(data.usage ?? info.usage ?? open.usage) ?? {
          inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0, prefillTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
        };
        const src = data.message?.source ?? {};
        const provider = typeof src.provider === 'string' && src.provider ? src.provider : (state.lastHeader.provider || '');
        const model = typeof src.model === 'string' && src.model ? src.model : (state.lastHeader.model || '');
        const ppTpsUncached = (ttftMs !== null && ttftMs > 0 && normUsage.prefillTokens > 0) ? (normUsage.prefillTokens / (ttftMs / 1000)) : null;
        const ppTpsTotal = (ttftMs !== null && ttftMs > 0 && normUsage.promptTokens > 0) ? (normUsage.promptTokens / (ttftMs / 1000)) : null;
        const tgTps = (decodeMs !== null && decodeMs > 0 && normUsage.outputTokens > 0) ? (normUsage.outputTokens / (decodeMs / 1000)) : null;
        const cacheHitPercent = normUsage.promptTokens > 0 ? (normUsage.cacheReadTokens / normUsage.promptTokens) * 100 : null;
        const stepRecord = {
          step, seq: event.seq ?? null, startTime, firstTokenTime, completedTime,
          ttftMs, decodeMs, llmMs, ...normUsage,
          hasReasoning: Boolean(open.hasReasoning || info.hasReasoning || normUsage.reasoningTokens > 0),
          ppTpsUncached, ppTpsTotal, tgTps, cacheHitPercent, provider, model,
        };
        const key = String(turn);
        const prevTurn = state.turns[key] ?? emptyTurnSummary(turn, open.startSeq, startTime);
        const filteredSteps = prevTurn.steps.filter((s) => s.step !== step);
        const nextTurn = recomputeTurnAggregates({ ...prevTurn, steps: [...filteredSteps, stepRecord].sort((a, b) => a.step - b.step) });
        return { ...state, openStep: null, turns: { ...state.turns, [key]: nextTurn } };
      }
      case 'tool/call': {
        const callId = data.callId;
        const turn = Number.isSafeInteger(data.turn) ? data.turn : state.activeTurn;
        if (typeof callId !== 'string' || !callId || typeof event.time !== 'number') return state;
        return { ...state, pendingCalls: { ...state.pendingCalls, [callId]: { time: event.time, turn } } };
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId ?? data.callId;
        if (typeof callId !== 'string' || !Object.hasOwn(state.pendingCalls, callId)) return state;
        const pending = state.pendingCalls[callId];
        const nextPending = { ...state.pendingCalls };
        delete nextPending[callId];
        const turn = Number.isSafeInteger(data.turn) ? data.turn : (pending.turn ?? state.activeTurn);
        if (!Number.isSafeInteger(turn) || typeof event.time !== 'number') return { ...state, pendingCalls: nextPending };
        const key = String(turn);
        const prevTurn = state.turns[key];
        if (!prevTurn) return { ...state, pendingCalls: nextPending };
        const dt = Math.max(0, event.time - pending.time);
        const nextTurn = recomputeTurnAggregates({ ...prevTurn, toolMs: (prevTurn.toolMs || 0) + dt, toolCalls: (prevTurn.toolCalls || 0) + 1 });
        return { ...state, pendingCalls: nextPending, turns: { ...state.turns, [key]: nextTurn } };
      }
      case 'turn/end': {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : state.activeTurn;
        if (!Number.isSafeInteger(turn)) return state;
        const key = String(turn);
        const prevTurn = state.turns[key] ?? emptyTurnSummary(turn, null, null);
        const nextTurn = recomputeTurnAggregates({
          ...prevTurn,
          endSeq: event.seq ?? prevTurn.endSeq,
          endTime: typeof event.time === 'number' ? event.time : prevTurn.endTime,
          status: data.reason?.kind ?? 'completed',
        });
        return { ...state, activeTurn: null, openStep: null, pendingCalls: {}, turns: { ...state.turns, [key]: nextTurn } };
      }
      default:
        return state;
    }
  },
  wire: {
    viewSchema: PASSTHROUGH_SCHEMA,
    view: (state) => ({ turns: state.turns }),
  },
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PROMPT_EVAL_RE = /task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;
const EVAL_RE = /task\s+(\d+)\s*\|\s*eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;
const TOTAL_RE = /task\s+(\d+)\s*\|\s*total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;
const DRAFT_RE = /task\s+(\d+)\s*\|\s*draft acceptance\s*=\s*([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\)(?:,\s*mean len\s*=\s*([\d.]+))?/;
const RELEASE_RE = /task\s+(\d+)\s*\|\s*stop processing:\s*n_tokens\s*=\s*(\d+)/;

let llamaLogCache = { mtimeKey: '', tasks: [] };

export function parseLlamaLogText(text) {
  const byTask = new Map();
  const getTask = (id) => {
    let t = byTask.get(id);
    if (!t) {
      t = { taskId: Number(id), promptMs: null, promptTokens: null, promptTps: null, evalMs: null, evalTokens: null, evalTps: null, totalMs: null, totalTokens: null, draftAcceptance: null, draftAccepted: null, draftGenerated: null, draftMeanLen: null, stopTokens: null };
      byTask.set(id, t);
    }
    return t;
  };
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(ANSI_RE, '');
    if (!clean.includes('slot ')) continue;
    let m;
    if ((m = PROMPT_EVAL_RE.exec(clean))) {
      const t = getTask(m[1]);
      t.promptMs = parseFloat(m[2]); t.promptTokens = parseInt(m[3], 10); t.promptTps = parseFloat(m[5]);
    } else if ((m = EVAL_RE.exec(clean))) {
      const t = getTask(m[1]);
      t.evalMs = parseFloat(m[2]); t.evalTokens = parseInt(m[3], 10); t.evalTps = parseFloat(m[5]);
    } else if ((m = TOTAL_RE.exec(clean))) {
      const t = getTask(m[1]);
      t.totalMs = parseFloat(m[2]); t.totalTokens = parseInt(m[3], 10);
    } else if ((m = DRAFT_RE.exec(clean))) {
      const t = getTask(m[1]);
      t.draftAcceptance = parseFloat(m[2]) * 100; t.draftAccepted = parseInt(m[3], 10); t.draftGenerated = parseInt(m[4], 10);
      if (m[5] !== undefined) t.draftMeanLen = parseFloat(m[5]);
    } else if ((m = RELEASE_RE.exec(clean))) {
      const t = getTask(m[1]);
      t.stopTokens = parseInt(m[2], 10);
    }
  }
  return [...byTask.values()].filter((t) => t.evalTokens !== null && t.evalTokens > 1);
}

function loadRecentLlamaTasks(logDir = DEFAULT_LLAMA_LOG_DIR) {
  try {
    if (!existsSync(logDir)) return [];
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith('.log') && !f.startsWith('router-'))
      .map((f) => { const p = join(logDir, f); const st = statSync(p); return { p, mtimeMs: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3);
    if (!files.length) return [];
    const mtimeKey = files.map((f) => `${f.p}:${f.mtimeMs}:${f.size}`).join('|');
    if (llamaLogCache.mtimeKey === mtimeKey) return llamaLogCache.tasks;
    const allTasks = [];
    for (const f of files) {
      try {
        const raw = readFileSync(f.p, 'utf8');
        allTasks.push(...parseLlamaLogText(raw));
      } catch {}
    }
    llamaLogCache = { mtimeKey, tasks: allTasks };
    return allTasks;
  } catch {
    return [];
  }
}

function isLocalStep(step) {
  const p = String(step.provider || '').toLowerCase();
  const m = String(step.model || '').toLowerCase();
  return p === 'local' || p.includes('llama') || p.includes('qwen-router') || m.endsWith('.gguf');
}

function attachLlamaHardwareTimings(turnsMap, logDir) {
  const turnKeys = Object.keys(turnsMap);
  let hasLocal = false;
  for (const k of turnKeys) {
    if (turnsMap[k]?.steps?.some(isLocalStep)) { hasLocal = true; break; }
  }
  if (!hasLocal) return turnsMap;
  const tasks = loadRecentLlamaTasks(logDir);
  if (!tasks.length) return turnsMap;
  const usedIdx = new Set();
  const out = {};
  for (const k of turnKeys) {
    const t = turnsMap[k];
    let hwPromptMs = 0, hwPromptTokens = 0, hwEvalMs = 0, hwEvalTokens = 0;
    let hwAccepted = 0, hwGenerated = 0, hwMeanLenWeighted = 0, hwMatchedSteps = 0;
    const nextSteps = t.steps.map((s) => {
      if (!isLocalStep(s) || !s.outputTokens) return s;
      let bestIdx = -1, bestScore = Infinity;
      for (let i = 0; i < tasks.length; i++) {
        if (usedIdx.has(i)) continue;
        const tk = tasks[i];
        const outDiff = Math.abs((tk.evalTokens || 0) - s.outputTokens);
        if (outDiff > 3) continue;
        const stopDiff = tk.stopTokens && s.totalTokens ? Math.abs(tk.stopTokens - s.totalTokens) : 50;
        const score = outDiff * 100 + Math.min(stopDiff, 500);
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx === -1) return s;
      usedIdx.add(bestIdx);
      const tk = tasks[bestIdx];
      hwMatchedSteps += 1;
      hwPromptMs += tk.promptMs || 0;
      hwPromptTokens += tk.promptTokens || 0;
      hwEvalMs += tk.evalMs || 0;
      hwEvalTokens += tk.evalTokens || 0;
      if (tk.draftAccepted !== null && tk.draftGenerated !== null) {
        hwAccepted += tk.draftAccepted;
        hwGenerated += tk.draftGenerated;
        if (tk.draftMeanLen !== null) hwMeanLenWeighted += tk.draftMeanLen * tk.evalTokens;
      }
      return { ...s, llamaHw: tk };
    });
    const llamaHw = hwMatchedSteps > 0 ? {
      matchedSteps: hwMatchedSteps,
      promptMs: hwPromptMs,
      promptTokens: hwPromptTokens,
      promptTps: hwPromptMs > 0 && hwPromptTokens > 0 ? (hwPromptTokens / (hwPromptMs / 1000)) : null,
      evalMs: hwEvalMs,
      evalTokens: hwEvalTokens,
      evalTps: hwEvalMs > 0 && hwEvalTokens > 0 ? (hwEvalTokens / (hwEvalMs / 1000)) : null,
      draftAcceptance: hwGenerated > 0 ? (hwAccepted / hwGenerated) * 100 : null,
      draftAccepted: hwAccepted,
      draftGenerated: hwGenerated,
      draftMeanLen: hwEvalTokens > 0 && hwMeanLenWeighted > 0 ? (hwMeanLenWeighted / hwEvalTokens) : null,
    } : null;
    out[k] = { ...t, steps: nextSteps, llamaHw };
  }
  return out;
}

function findSessionLogFile(sessionId) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const sessionsRoot = join(home, 'sessions');
    if (!existsSync(sessionsRoot)) return null;
    for (const ws of readdirSync(sessionsRoot)) {
      const wsDir = join(sessionsRoot, ws);
      if (!statSync(wsDir).isDirectory()) continue;
      const candidateDir = join(wsDir, sessionId);
      if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
        const files = readdirSync(candidateDir).filter((f) => f.includes('.jsonl')).sort();
        if (files.length) return join(candidateDir, files[files.length - 1]);
      }
    }
  } catch {}
  return null;
}

export function foldEventsArray(events) {
  let state = turnMetricsProjectionDefinition.init();
  for (let i = 0; i < events.length; i++) {
    state = turnMetricsProjectionDefinition.apply(state, events[i]);
  }
  return state.turns;
}

export function foldSessionLogFile(filePath) {
  const buf = readFileSync(filePath);
  let text = '';
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    const offsets = [];
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i);
    }
    for (let i = 0; i < offsets.length; i++) {
      const slice = buf.subarray(offsets[i], offsets[i + 1] || buf.length);
      try { text += zlib.zstdDecompressSync(slice).toString('utf8'); } catch {}
    }
  } else {
    text = buf.toString('utf8');
  }
  let state = turnMetricsProjectionDefinition.init();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') {
        state = turnMetricsProjectionDefinition.apply(state, ev);
      }
    } catch {}
  }
  return state.turns;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.removeAllListeners('data'); req.resume(); reject(new Error('body-too-large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(s ? JSON.parse(s) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  const disposers = [];
  try {
    const projections = ctx.get?.('sessionProjections') ?? ctx.sessionProjections;
    if (projections && typeof projections.register === 'function') {
      disposers.push(projections.register(turnMetricsProjectionDefinition));
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionProjections'], (scope) => {
        scope.sessionProjections.register(turnMetricsProjectionDefinition);
      });
    }
  } catch {}

  try {
    const settings = ctx.get?.('settings') ?? ctx.settings;
    if (settings && typeof settings.register === 'function') {
      const dummySchema = (x) => x ?? {};
      dummySchema.toJSON = () => ({ type: 'object' });
      settings.register('dsh-turn-metrics', dummySchema);
    }
  } catch {}

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/turn-metrics/session',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId || '');
          const logDir = typeof body.llamaLogDir === 'string' && body.llamaLogDir.trim() ? body.llamaLogDir.trim() : DEFAULT_LLAMA_LOG_DIR;
          if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return; }
          let turns = null;
          const liveSession = ctx.sessions?.get?.(sessionId);
          if (liveSession) {
            const projections = ctx.get?.('sessionProjections') ?? ctx.sessionProjections;
            const projState = projections?.stateOf?.(liveSession, 'turnMetrics');
            if (projState && projState.turns && Object.keys(projState.turns).length > 0) {
              turns = projState.turns;
            } else {
              const events = typeof liveSession.snapshotEvents === 'function' ? liveSession.snapshotEvents() : liveSession.events;
              if (Array.isArray(events)) turns = foldEventsArray(events);
            }
          }
          if (!turns || Object.keys(turns).length === 0) {
            const logFile = findSessionLogFile(sessionId);
            if (logFile) turns = foldSessionLogFile(logFile);
          }
          const enriched = attachLlamaHardwareTimings(turns || {}, logDir);
          sendJson(res, 200, { ok: true, sessionId, turns: enriched });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    }));
  }

  return () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d(); } catch {}
    }
  };
}


