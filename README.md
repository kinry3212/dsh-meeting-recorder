# dsh-meeting-recorder

DSH（DeepSeek Harness）宿主侧插件：为**长会话**维护一份随时可查的会议记录，由另一个模型在后台按轮次增量更新，结果只落盘，**不向你的对话注入任何内容**。

A host-side plugin for DSH: keeps a browsable, incrementally updated meeting record of a long session, written by a separate model in the background. Nothing is injected into your conversation.

---

## 它做什么 / What it does

- 监听会话的「每轮结束」事件，把**新增的几轮**内容交给记录员模型，追加进已有记录。
- 记录员有自己的 system prompt、自己的消息、自己的输出预算，和主对话完全隔离。
- 每个会话一份记录与状态，开关独立。
- 默认关闭：不执行 `/record on` 就不产生任何模型调用。

## 安装 / Install

在 DSH 插件市场里搜索 `dsh-meeting-recorder` 安装（市场收录后可用）。

命令行安装到某个 profile：

```sh
dsh plugin --profile <profile-name> add github:kinry3212/dsh-meeting-recorder
```

安装后重启 DSH。插件是纯 host 半边，不注入渲染层，不需要前端协议。

## 使用 / Usage

输入框敲 `/` 会列出命令，`/record` 在其中。

| 输入 | 作用 | 模型调用 |
|---|---|---|
| `/record`、`/record show`、`/record status` | 查看当前状态：摘要、开关、文件路径、状态位，以及记录正文全文 | 不花 |
| `/record on` | 开启当前会话的记录；若此前一条都没记过，会顺手把已有历史补记一次 | 补记时一次 |
| `/record off` | 关闭当前会话的记录；已写内容保留，不置为定稿 | 不花 |
| `/record rebuild` | 游标归零、正文清空、开关置开，把整个会话从头重做 | 最贵 |
| `/record file` | 只输出记录 md 与状态 json 两个路径 | 不花 |

触发点是**每轮结束**，带 1.5 秒防抖，所以刚说完话立刻查看可能还没写进去。

## 记录长什么样 / The record

默认写在 `~/.dsh/meeting-recorder/`：

```
<sessionId>.md    记录正文（markdown），固定 12 节骨架，每条带消息序号 seq
<sessionId>.json  状态：开关、游标 cursorSeq、跑批记录、status=draft
```

12 节骨架顺序固定：当前任务 / 背景与已有基础 / 最初判断 / 用户反馈与关键纠偏 / 后续关键转向 / 阶段成果 / 重要认知 / 可能遗漏的线索 / 关键消息摘录 / 当前现状与下一步建议 / 当前边界提醒 / 交接给下个 session。

状态默认 `draft`，不会自动变成定稿。设置 `debug: true` 时同目录会多一个 `_debug.log`。

## 配置项 / Configuration

在 DSH 的插件配置里改，全部有默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `autoEnable` | `false` | 新会话是否默认开启记录 |
| `provider` / `model` | 未设 | 记录员用哪个模型；不设则跟随当前会话最近一次请求的路由 |
| `storageDir` | `~/.dsh/meeting-recorder` | 记录落盘目录 |
| `debounceMs` | `1500` | 轮次结束后的防抖窗口 |
| `maxOutputTokens` | `6000` | 单次记录员调用的输出上限 |
| `userChars` | `3000` | 单轮内用户内容计入的字数上限 |
| `assistantChars` | `6000` | 单轮内助手正文计入的字数上限 |
| `reasoningChars` | `0` | 是否把助手推理计入（默认不读） |
| `totalChars` | `60000` | 单批输入总量上限 |
| `maxDrain` | `5` | 一批装不下时最多自动续跑几批 |
| `timeoutMs` | `180000` | 单次调用的超时 |
| `debug` | `false` | 是否写 `_debug.log` |

预算的取舍单位是**一整轮（一问一答）**：一轮要么整轮进，要么整轮延后到下次更新，不会出现「只有问没有答」。

## 边界 / Boundaries

- 不读工具调用与工具输出细节，只按你说的话和助手答的话归纳。
- 不写会话日志，也不改动会话内容。
- 命令行（headless）跑完即退出时，最后一轮可能来不及写；下次加载会自动续接补记。
- 开关按会话独立，不跨会话继承。

## 卸载 / Uninstall

```sh
dsh plugin --profile <profile-name> remove dsh-meeting-recorder
```

已生成的记录文件在 `storageDir` 里，不会被自动删除。

## 开发 / Development

纯 ESM，无构建步骤；源码在 `lib/`，`cordis.patch.yml` 只有一条 insert，把 host 半边挂进 Loader 树。

```sh
node --test test/budget.test.mjs    # 纯逻辑，独立可跑
```

`test/command.test.mjs` 与 `test/e2e.patch.yml` 会加载内核侧的 `@deepseek-ai/dsh-llm` 等包，只能在 DSH 进程内运行（这些包由宿主提供，不随本仓库安装）。

## License

MIT
