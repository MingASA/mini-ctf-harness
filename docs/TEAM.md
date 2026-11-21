# 局域网团队协作（可选）

团队模式在 `feature/lan-team` 分支开发。每台电脑仍运行自己的 Harness、模型和 Docker；Center 与 Worker 都是原有交互式 Pi 会话。机器型号、数量、模型大小和方向分配均未写死。不配置 `team` 时不监听团队端口、不增加协作工具。

## 三台电脑启动

三台机器安装同一版本的 Harness，并切到 `feature/lan-team`。已有安装只需拉取该分支的前端代码，本功能没有新依赖、模型后端补丁或 Docker 镜像变更。保留每台机器自己的 `.install.json` 和数据目录，不要复制其他机器的 `sessions/team` 身份目录。

已有干净安装可执行：

```bash
git fetch origin
git switch --track origin/feature/lan-team
# 已经有本地分支时，使用 git switch feature/lan-team
```

然后编辑配置，运行 `./mini-ctf`。不需要开启或重新编译 `/btw` 后端。

在各自数据目录的 `config.json` **顶层**添加以下字段，保留原有模型、Docker 和其他配置：

```json
{
  "team": {
    "name": "desk-center",
    "host": "0.0.0.0",
    "port": 18765,
    "advertiseUrl": "http://192.168.50.10:18765",
    "secret": "replace-with-the-same-random-team-secret"
  }
}
```

这里的地址只是示例。其他两台分别改成自己的名称和交换机局域网 IP，例如 `desk-worker-a` / `192.168.50.11`、`desk-worker-b` / `192.168.50.12`。三台的 `secret` 相同；可在一台机器执行 `python3 -c 'import secrets; print(secrets.token_hex(32))'` 生成，然后离线复制到另外两台配置。名称不决定角色。模型配置和角色选择各自独立，之后可以增加更多 Worker。

各机执行 `./mini-ctf`。团队 HTTP 使用 TCP 18765，发现使用 UDP 18766；两者均可通过 `port`、`discoveryPort` 改动。允许同一可信局域网内的电脑访问这两个端口。模型端口继续仅供本机使用，不需要对外开放。

WSL 中运行 Harness 时，`advertiseUrl` 必须是其他电脑能访问的地址；先确认 Windows/WSL 的 LAN 连通和防火墙。可使用现有 mirrored networking 配置。如果广播发现不可用，直接使用下方 `/team connect`，无需依赖广播。多网卡场景请明确配置 `advertiseUrl`；省略时自动选择的第一张外部 IPv4 网卡可能不是比赛网卡。

## 组队与操作

1. 在 Worker 上输入 `/team worker new`，允许 Center 为新题创建本机解题会话和容器。如果已有单 Agent 探路记录，先 `/view` 选择该题，输入 `/team worker`，后续邀请会复用它的记录和工作区。复用时请人工确认是同一道题。
2. 在 Center 上选择已有题目（或 `Ctrl+N` 创建），输入 `/team center`。在多行输入框粘贴探路报告，或输入 `-` 跳过。Center 的现有记录、文件和普通工具都会保留。
3. Center 自动发现已准备好的 Worker，按加入顺序编号。发现不到时输入 `/team connect http://192.168.50.11:18765`、`/team connect http://192.168.50.12:18765`。之后加入的电脑可以用 `/team discover` 再发现。邀请实际确认后，Center 会收到“Worker N 已加入”的消息并安排方向。
4. `/start` 开启各机调度（正常自动启动时已开启）。Center 自行维护图、派工，Worker 报告后等待；Center 收到反馈就继续原会话。直接输入文字可以随时纠正本机 Agent。
5. Worker `/help [问题说明]`：当前完整轮次结束后，让模型明确说明卡点并发给 Center。`/handoff [补充说明]`：停止继续探路，生成基于实际观察的交接报告并发送。两者不会把未完成的旧回答当成报告。Worker 的命令帮助改用 `/help commands`。Center 和普通会话的 `/help` 保持原义。
6. `/pause`、`Ctrl+C` 保留人工暂停语义。网络消息照常落盘，但不会恢复被人工暂停的题目，也不会擅自重新打开已停止的调度。用 `/resume`、必要时 `/start` 恢复。后台本地命令仍遵循原有行为，需单独 `/cancel` 才停止。

Worker 可以继续参加其他题：保留旧会话，再 `/team worker new` 接受新题，或选择另一份尚未组队的探路会话后 `/team worker`。每道题按自己的 team ID 和本地会话绑定路由，旧团队仍可继续发消息；同一台机器仍由原来的单主会话调度器决定先运行哪题。

## 查看进展与模型工具

- `/team`：节点身份、题目角色、Worker 编号、待投递数量和最近通信错误。输入栏持续显示角色与待投递数。
- `/team messages`：最近发送及确认记录。实际收到的消息在主对话和 `/tab inbox` 可见。
- `/team graph`：人类查看 Fact/Intent Markdown；Worker 从 Center 获取。
- `/tab output`：从查询面板回到模型输出。组队、连接和报告命令完成后会自动回到输出。

只增加三个工具，Center 的命令、文件、知识库、图片等工具完整保留：

| 工具 | Center | Worker |
| --- | --- | --- |
| `team_message` | `action=status` 看成员；`action=send, worker="1", kind=task, text=...` 派工或指导 | `action=send, kind=help/finish/handoff, text=...` 报告并等待指导；不填 worker |
| `team_graph` | `action=read/update`，以 Markdown 替换 facts/intents | `action=read` 读取 Center 图 |
| `team_read` | 指定 worker 编号，读取其 messages/journal/artifact/file | 不填 worker，读取 Center 的相关证据或文件 |

图只有 facts/intents 两段文字与题目关联，历史更新保存在日志。Center 提示词要求用 F1/I1 等引用、证据和必要依赖表达事实与意图；Harness 不判断事实、不自动规划、不定期让模型空转。

`team_read` 默认每页 20 个消息/日志事件或 4,000 个 artifact 字符，按 `next_offset` 翻页，可显式调大 `limit`，没有新增硬上限。journal 提供原始对话、工具调用/结果及证据事件，不传本机启动配置。文件使用 `/work/...` 引用，按需下载到调用方 `/work/team-import/...`，返回本地路径、SHA256 和字节数，可用普通工具继续分析。新题创建使用 Center 提供的靶机 target 地址，沿用原有 LAN 容器配置；复用旧题时会同时展示本地与 Center 的 target，需确认环境对应。原题附件清单随邀请发送，内容按需获取；不会默认上传全量轨迹。文件没有新增大小或总传输时间上限，可人工中断。不同电脑的 `/work` 是独立目录，拿到远端路径后需要先 fetch；不要假定附件或产生的脚本自动同步。

## 持久化、断线与 /btw

`contestDir/team/` 保存本机节点身份、题目绑定、图历史和通信日志。出站消息先落盘再发送，未收到确认会重试；接收按消息 ID 去重，写入相应题目的 TaskInbox。重启会恢复绑定和未确认消息。消息同时核验接收节点 ID，地址复用不会投给另一台机器。收到同时发来的报告会串行入队，不会同时启动多个主 Agent。删除本地题目会移除该题的团队绑定；旧队友继续发往该题的消息会显示投递错误，需要选手停止旧任务；它不会阻塞同一节点的其他题目。

建议使用稳定的比赛网 IP。地址变化后，Center 在对应题目 `/team connect 新Worker地址` 更新其目的地址；Worker 在对应题目 `/team connect 新Center地址` 更新 Center 地址。这只重连原节点，不能把旧团队改绑到另一节点。尚未确认的消息会继续投递。加入、断线和图更新不是新调度器，不会自动抢占人工暂停或预算耗尽的会话。

`/btw` 可以继续作为本机讨论使用。它没有三个团队工具，接收与工具结果仍留在自己的分支；团队消息只交给主会话。`/team`、`/handoff`、Worker `/help` 要先 `/main`。分支仍与主会话共享本地题目文件，这是原有行为。团队模式本身不需要开启 `/btw`，也不要求安装其后端。

## 验证与边界

开发测试使用本机真实 HTTP/UDP、多节点持久化和真实 Pi Agent Core，模型响应由可控的流式服务提供，以稳定复现并发和暂停时序：

```bash
cd offline_harness
node --test --test-timeout=30000 test/team.test.mjs test/terminal.test.mjs
```

覆盖派工→help→Center 纠正→finish、图更新、精确会话路由、四节点任意编号、已有会话和节点重启、去重重发、启动重放与慢处理并发、连续两题、人工暂停、handoff 轮次边界、分页/附件/目录逃逸、流传输取消、发现和 `/btw` 工具隔离。原单 Agent 与 /btw 回归另行执行。

本次验证：团队专项 15/15 通过，团队/启动/TUI/BTW 专项 58/58 通过；全套 314 项中 309 通过，5 项为主线已有的中文知识库检索断言失败，无新增失败或超时。

三台实机上线前，先用一份小附件验证：Center 发给 Worker 1 一个方向，Worker 2 发另一个；让 Worker 1 `/help`，确认只有 Center 被唤醒并能读其证据；Center 更新图后两端 `/team graph` 应一致。暂停一台 Worker 再派工，确认消息排队且模型不启动，恢复后才处理。最后断网发一条消息，恢复网络，确认只出现一次。

目前未在用户的三台交换机实机上验收；模型自主规划和解题质量也需要实题观察。协议是可信离线 LAN 上的共享令牌 HTTP，没有 TLS、互联网中继或跨 Worker 直连。发现只是便利功能，真实加入仍需令牌验证。Worker 必须先主动准备；无需把其他正在单机解题的电脑强制改成 Worker。
