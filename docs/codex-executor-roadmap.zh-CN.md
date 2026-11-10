# Codex Executor 改造路线

## 1. 目标

保留 dsh-superagent 的 GitHub Source、授权策略、Ticket、Thread、面板和 SQLite
业务状态，将任务规划、代码修改、验证和交付执行从 DSH Executor 迁移到 Codex。

改造后的职责边界：

```text
GitHub Issue / PR
        ↓
dsh-superagent Router
  - 接收 Trigger
  - 校验身份和授权
  - 创建并维护 Ticket
  - 保存业务状态
  - 向原 Thread 回复
        ↓
Codex Executor
  - 理解任务合同
  - 规划实施步骤
  - 修改代码
  - 运行检查
  - 产生结构化结果
        ↓
dsh-superagent
  - 验证结果
  - 创建或关联 PR
  - 更新 Ticket
  - 通知人员
```

核心原则：

- Ticket 和 SQLite 是业务状态的唯一事实来源。
- Codex session/thread 是可替换的执行细节。
- 一个 Ticket 同一时间最多运行一个 Codex turn。
- Codex 只在该 Ticket 的 worktree 中写入。
- 家庭环境允许显式选择 `login` 模式，复用本机 `codex login` 的 OpenAI/ChatGPT 登录态；公司 `provider` 模式必须 fail closed，不得回退个人账号或个人 provider。
- GitHub、凭据、PR 和恢复逻辑由宿主程序控制，不依赖 Codex 自行猜测。

## 2. 任务合同

Router 在启动 Executor 前，把 GitHub 请求归一化成结构化任务合同。第一版可以由确定性代码和提示词共同生成，最终版应增加独立的需求审查阶段。

```json
{
  "objective": "需要交付的用户可见结果",
  "allowed_changes": ["允许修改的模块、文件或行为"],
  "forbidden_changes": ["明确不得修改的内容"],
  "acceptance_criteria": ["可验证的验收条件"],
  "required_checks": ["必须执行的检查"],
  "delivery": {
    "create_pull_request": true,
    "auto_merge": false
  },
  "ambiguities": [],
  "needs_human_confirmation": false
}
```

若 `needs_human_confirmation` 为 `true`，不得启动代码执行。Super Agent 应在原 GitHub Thread 提出一个具体问题，并把 Ticket 置于等待人员状态。

## 3. 第一版：Codex Exec Executor

### 3.1 范围

第一版增加一个可选的 `CodexExecExecutor`，保留现有 DSH Executor 作为回退和对照。部署设置决定新 Ticket 使用哪个 Executor；已经创建的 Ticket 不在运行中切换 Executor。Codex Executor 另有两种显式认证模式：家庭环境使用 `login`，公司环境使用 `provider`。

第一版支持：

- 创建 Ticket worktree。
- 通过参数列表启动 `codex exec`。
- 读取 JSONL 事件流。
- 保存 Codex session ID。
- 使用 JSON Schema约束最终报告。
- 停止正在运行的 Codex 子进程。
- 使用 `codex exec resume` 处理 GitHub 后续消息。
- 进程退出、超时和无效报告的确定性失败处理。
- 重启后恢复未完成 Assignment。
- 公司 Responses provider 的独立 Codex profile。

第一版暂不支持：

- Codex 实时交互式审批。
- 多个并发 turn 写同一个 Ticket。
- 在执行过程中切换 Codex provider 或 profile。
- 自动合并 PR。
- 把 Codex 本地 session 当作业务状态恢复源。

### 3.2 启动方式

宿主程序使用 subprocess 参数列表，不使用 shell：

```text
codex exec
  --json
  --cd <ticket-directory>
  --sandbox workspace-write
  --profile company-superagent
  --output-schema <report-schema>
  --output-last-message <report-file>
  -
```

完整任务合同和运行指令通过 stdin 传入。不得把用户文本插入命令字符串。

禁止使用：

```text
--dangerously-bypass-approvals-and-sandbox
```

### 3.3 公司 Responses profile

Codex 使用独立 `CODEX_HOME` 和独立 profile。示意配置：

```toml
[model_providers.company]
base_url = "https://gateway.company.example/v1"
env_key = "COMPANY_OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[profiles.company-superagent]
model_provider = "company"
model = "company-model-id"
```

要求：

- `base_url` 和模型 ID 可以配置，但不能由 GitHub 消息覆盖。
- 真实 Key 仅从进程环境读取。
- 缺少公司 Key、profile 或 provider 时直接失败。
- 不读取默认 Codex 登录凭据。
- 不回退 OpenAI 个人账号、ChatGPT 登录或其他 provider。
- 日志不得包含 Key、完整环境或原始 provider 错误体。

家庭环境配置为 `codexAuthMode: login` 时，不传 `--profile`，使用正常的 `$CODEX_HOME` 或 `~/.codex`，复用执行用户通过 `codex login` 保存的 ChatGPT 登录态。该模式不要求 API Key。公司环境配置为 `codexAuthMode: provider` 时才启用上述隔离 profile 和 Key 校验；两种模式不能在一次运行中自动切换。

### 3.4 执行报告

Codex 的最终消息必须匹配 JSON Schema：

```json
{
  "status": "completed",
  "summary": "完成结果",
  "files_changed": [],
  "checks": [
    {
      "command": "uv run pytest tests/example.py",
      "outcome": "passed"
    }
  ],
  "needs_human_input": false,
  "question": null,
  "limitations": []
}
```

允许的状态：

- `completed`：实现和必要检查已完成。
- `needs_human_input`：需要人员作出具体决定。
- `blocked`：当前权限或资源无法继续。
- `failed`：执行失败，不能声称完成。

宿主程序不能只相信报告文本。标记完成前还应确定性检查：

- 子进程退出码为 0。
- 报告通过 Schema 校验。
- worktree 和分支符合当前 Ticket。
- 改动没有越出允许的仓库目录。
- 未包含已知 Secret 值。
- 必要检查有可验证的结果。
- PR 指向当前 Ticket 的分支和提交。

### 3.5 Session 和后续消息

首次执行后保存 Codex session ID：

```text
Ticket ID → Assignment ID → Codex session ID
```

后续 GitHub 评论进入同一 Ticket 时：

```text
codex exec resume <session-id> --json -
```

恢复输入包括：

- 新消息原文及来源。
- 当前任务合同。
- Ticket 当前状态。
- 当前分支和 PR。
- 授权范围没有因引用内容而扩大这一提醒。

同一 Ticket 的消息必须排队串行处理。新的 turn 不得与已有 turn 并发运行。

### 3.6 人工问题

非交互执行不能在终端里无限等待。Codex 需要人员决策时返回：

```json
{
  "status": "needs_human_input",
  "needs_human_input": true,
  "question": "一个具体、可回答的问题"
}
```

Super Agent 随后：

1. 在原 GitHub Thread 提问。
2. 把 Ticket 标记为等待人员。
3. 停止占用 worker slot。
4. 收到回复后恢复同一 Codex session。

### 3.7 PR 职责

第一版推荐 Codex 只负责修改、检查和提交，不直接创建或合并 PR。

宿主程序负责：

- 验证分支和提交。
- 使用机器人 GitHub CLI 推送。
- 创建或更新 PR。
- 关联 Ticket 与 PR。
- 发布最终回复。

这样可以减少 Codex 的远程写权限，并避免重试时产生重复 PR。

### 3.8 停止、失败与恢复

- 人员停止 Ticket 时，宿主程序先终止 Codex 子进程，再记录 Ticket 结束。
- 网络或 provider 的暂时性失败使用有上限的退避重试。
- 无效 JSON、Schema 不匹配和权限错误属于确定性失败，不自动无限重试。
- 重启后先读取 SQLite Assignment，再检查子进程、worktree、分支和 PR。
- 重试复用原 worktree、分支和 session，不重新创建同名 PR。
- 若 session 无法恢复，可新建 session，但必须把已有代码状态和任务合同重新注入，并记录替换关系。

### 3.9 第一版建议代码边界

```text
src/executor/port.ts
  Executor 接口和通用类型

src/executor/dsh.ts
  现有 DSH Executor 实现

src/executor/codex-exec.ts
  Codex CLI 子进程、JSONL、停止和 resume

src/executor/codex-report.ts
  最终报告 Schema 和校验

src/executor/codex-profile.ts
  公司 profile 的 fail-closed 检查

src/executor/process.ts
  可测试的 subprocess 抽象
```

具体文件可在实施时根据现有依赖方向调整，避免为了目录形式扩大重构范围。

### 3.10 第一版测试

测试必须使用临时仓库、临时状态目录和 fake subprocess runner，不调用真实 Codex、GitHub、模型网关或 Docker。

直接覆盖：

- 参数列表和 stdin 构造。
- JSONL 分片和异常行解析。
- session ID 持久化。
- 正常完成和 Schema 校验。
- 人工问题状态转换。
- 非零退出码。
- 停止子进程。
- 同一 Ticket 串行 resume。
- 重启恢复。
- 缺失公司 profile 或 Key 时 fail closed。
- Secret 扫描失败。
- 不产生重复 PR。

### 3.11 第一版验收标准

- 一个 GitHub Issue 可以创建 Ticket，并由 `codex exec` 在独立 worktree 完成修改。
- Codex 运行过程中不需要交互式终端输入。
- 后续评论可以恢复同一 session。
- 需要决策时能够回 GitHub 提问并暂停。
- 停止 Ticket 会停止对应 Codex 进程。
- 服务重启不会丢失 Ticket、session ID、worktree、分支或 PR 关联。
- 公司 provider 缺失时不回退个人 provider。
- Codex 默认不调用 Docker；部署显式允许时，只可运行仓库的测试脚本（如 `scripts/run-backend-tests.sh`），不得挂载宿主目录、Docker socket 或凭据；不能访问其他 Ticket 的写目录。
- 所有相关 fake-runner 测试通过。

## 4. 最终版：Codex App Server Executor

### 4.1 目标

最终版用 Codex app-server（或在能力相同的情况下使用官方 SDK）替代对 CLI 文本输出的管理，使 Codex 成为可持续控制的嵌入式执行运行时。

```text
dsh-superagent
      ↕ JSON-RPC / SDK
Codex app-server
  - thread/start
  - thread/resume
  - turn/start
  - 流式事件
  - interrupt
  - approval handling
      ↕ Responses
公司模型网关
```

最终版仍保持 Super Agent SQLite 为业务状态事实来源。

### 4.2 相比第一版增加的能力

- 持久 Codex thread 生命周期。
- 原生流式 item 和 turn 事件。
- 精确的 turn 完成、失败和中断状态。
- 运行中 interrupt。
- 审批请求的宿主处理。
- 更可靠的 token、耗时和工具调用可观测性。
- 不依赖 CLI 文本格式演进。
- 更自然的人员 follow-up 和多轮任务。

### 4.3 需求审查阶段

最终版在执行前增加独立 `requirements-reviewer`：

1. 读取 Trigger、Thread、仓库指令和相关上下文。
2. 输出任务合同。
3. 检测歧义、冲突和越权要求。
4. 需要决定时先向人员提问。
5. 合同稳定后才允许 Executor 启动。

交付前增加 `scope-reviewer`：

1. 比较任务合同与实际 diff。
2. 检查是否有无关修改。
3. 检查验收条件和必要测试。
4. 不合格时退回同一 Codex thread 修复。
5. 合格后才允许宿主创建或更新 PR。

审查 Agent 可以与执行 Agent 使用不同模型，但都必须走公司 Responses 网关。

### 4.4 审批模型

最终版由 Super Agent 决定审批策略：

- worktree 内常规读取和写入可自动允许。
- 越出 worktree 的写入拒绝。
- Docker 默认拒绝；部署显式允许时仅限仓库测试脚本，且需确认沙箱可访问 Docker socket，否则由宿主侧执行。
- 凭据、系统目录和其他 Ticket 目录拒绝。
- 远程写操作由宿主完成，不直接交给 Codex。
- 无法自动决定的请求转成 GitHub 人工问题。

### 4.5 事件映射

```text
Codex thread.started       → 保存 thread ID
Codex turn.started         → Assignment working
Codex item/tool events     → 内部执行轨迹
Codex approval request     → 策略判断或人工问题
Codex turn.completed       → 验证结构化结果
Codex turn.failed          → Assignment failed/retryable
Codex turn.interrupted     → stopped 或 interrupted
```

事件处理必须幂等。每个外部事件具有稳定标识，重复接收不得重复更新 Ticket 或重复发 GitHub 消息。

### 4.6 可观测性

最终版面板应展示：

- 当前 Executor 类型。
- Codex thread 和 turn 状态。
- 当前阶段：审查、规划、修改、验证、等待人员或交付。
- 最近一次有效进展时间。
- token 和耗时摘要。
- 重试次数及稳定错误分类。
- 任务合同和 scope-review 结论。

不得展示：

- API Key。
- 完整环境变量。
- 原始 provider 错误体。
- 可能带认证信息的请求头或 URL。

### 4.7 最终版验收标准

- 所有第一版验收标准继续成立。
- 任务全过程由持久 Codex thread 承载。
- 可流式观察阶段进展，但不会把内部噪音发送给人员。
- 可以安全中断并恢复 turn。
- 审批请求按策略自动拒绝、允许或转人工。
- 需求不明确时不会提前修改代码。
- 交付前自动检查 diff 是否符合任务合同。
- 重复事件、进程重启和网络重连不会产生重复评论、提交或 PR。
- Executor 实现可以在 DSH 与 Codex 之间切换，但单个 Ticket 的执行历史保持可审计。

## 5. 迁移顺序

### 阶段 A：接口整理

- 抽取最小 Executor 接口。
- 让现有 DSH Executor 通过该接口运行。
- 不改变现有行为。

### 阶段 B：第一版 Codex Exec

- 增加 Codex subprocess runner。
- 增加 JSONL 和最终报告解析。
- 增加 session ID、resume、停止和恢复。
- 增加公司 profile fail-closed 检查。
- 仅在测试仓库试运行。

### 阶段 C：小范围使用

- 默认仍使用 DSH Executor。
- 对指定仓库或显式设置启用 Codex Executor。
- 对比完成质量、耗时、人工干预和失败率。

### 阶段 D：需求与范围审查

- 增加任务合同。
- 增加 requirements-reviewer。
- 增加 scope-reviewer。

### 阶段 E：App Server

- 用 app-server/SDK 事件替换 CLI JSONL 管理。
- 保留同一 Executor 业务接口。
- 完成流式事件、中断和审批处理。

## 6. 决策记录

### 为什么不只把 Codex 作为 subagent

subagent 仍受原 Worker 的规划和完成判断控制，不能解决主执行器对需求理解、范围和完成质量把控不足的问题。Codex 应成为完整 Executor，而不是辅助建议者。

### 为什么第一版选择 `codex exec`

- 非交互调用面小。
- 已支持 JSONL、结构化最终输出和 session resume。
- 容易通过 fake subprocess runner 测试。
- 可以先验证执行质量，再投入长期运行时集成。

### 为什么最终版选择 app-server/SDK

- 产品需要持久会话、流式事件、中断和审批处理。
- 这些能力由结构化协议表达，比解析 CLI 生命周期更稳定。
- 可以保留 Super Agent 的业务状态和界面，同时复用 Codex agent loop。

## 7. 实施前待确认

- 公司 Responses 网关 `base_url`。
- 公司模型 ID。
- 是否使用标准 `Authorization: Bearer`。
- Codex profile 的存放位置和运行 OS 账号。
- 第一版允许 Codex执行的测试上限。
- PR 是否始终由宿主创建。
- 第一批用于验证的测试仓库。
