# dsh-turn-metrics

DeepSeek Harness (DSH) 每轮会话性能指标插件：在每轮会话回复底部（`conversation.chat.turnTail`）实时展示 **TTFT（首字时间）**、**预读取（Prefill / PP）**、**解码（Decode / TG）** 以及 **多步 Agent 调用拆解表**，并支持自动关联本地 `llama-server` 硬件级日志（真实增量 `prompt eval`、`eval` 与 MTP/DFlash 草稿接受率）。

## 安装方式

### 1. 在 DSH 客户端 GUI 中安装
打开 **设置 → 插件管理 → 添加插件**，输入：
```text
github:snow930/dsh-turn-metrics
```

### 2. 使用命令行安装
```bash
# 桌面端 Profile
dsh plugin --profile desktop add github:snow930/dsh-turn-metrics

# Web Profile
dsh plugin --profile web add github:snow930/dsh-turn-metrics
```

## 展示指标

1. **TTFT（首字延迟）**
   - 单步轮次：直接显示从 `step/start` 到首个输出 token 到达的毫秒/秒数（如 `TTFT 1.38 s`）。
   - 多步轮次（含工具调用）：同时显示 **首步 TTFT**、**步均 TTFT** 与 **整轮累计 TTFT**。
2. **预读取（Prefill / PP）**
   - 显示本轮预读取 Token 数、预读取吞吐速度（`tok/s`）与预读取耗时。
   - 当命中 KV 缓存（`cacheReadTokens > 0`）时，自动显示绿色 **缓存命中率徽章**（如 `缓存 85.4%`）。
   - 支持在 **设置 → 插件** 中切换预读取速度口径：
     - **未缓存实际计算 Token**（`inputTokens + cacheWriteTokens`，默认）
     - **总输入 Prompt Token**（`inputTokens + cacheReadTokens + cacheWriteTokens`）
3. **解码（Decode / TG）**
   - 显示本轮解码输出 Token 数（若包含思考链则标注 `思 xxx`）、解码速度（`tok/s`）与解码耗时。
4. **本地 `llama-server` 硬件级增强（可选，默认开启）**
   - 当检测到本地模型（`provider: local` 或 `.gguf` 模型）时，自动扫描 `F:\LocalLLM\logs` 最新日志，匹配硬件实测的：
     - **硬件 PP**：扣除 Slot LCP 复用后的真实增量 `prompt eval` token 数与速度（`硬件PP 296 @ 437.2 t/s`）
     - **硬件 TG**：服务端 `eval time` 实测解码速度（`硬件TG 50.2 t/s`）
     - **推测解码草稿接受率**：MTP / DFlash 的 `draft acceptance` 百分比与平均接受步长 `mean len`（`草稿 48.4% L3.11`）
5. **逐步骤（Step #1, #2...）展开明细表**
   - 点击右侧 `N 步 · 总 xx.xs ▾` 按钮，即可展开本轮完整汇总卡片与每一步的独立 TTFT、预读取、缓存命中、解码速度及耗时表格。

## 许可证

MIT
