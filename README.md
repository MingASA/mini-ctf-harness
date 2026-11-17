# mini-ctf-harness

本地模型 CTF 解题终端，基于 Pi Agent Core 与 Pi TUI。每题使用独立 Docker 工具容器，支持多题队列、后台命令、人工判题、技能读取和保持前缀的 Compact。

## 安装并运行

支持原生 x86-64 Ubuntu 24.04，以及 Windows 11 + WSL2 Ubuntu 22.04/24.04。系统需有 Python 3.10+、Git、启用 systemd 和 NVIDIA 驱动。WSL 使用 Windows CUDA 引擎；原生 Ubuntu 使用 Linux CUDA 引擎。

将仓库放在准备使用的磁盘，然后执行：

```bash
git clone https://github.com/MingASA/mini-ctf-harness.git
cd mini-ctf-harness
./mini-ctf install --data-dir /path/to/mini-ctf-data --model qwen3.8-27b-iq4xs
./mini-ctf
```

`--data-dir` 换成你的数据目录。WSL 请指定 Windows 数据盘上的路径，例如 `/mnt/d/mini-ctf-data`。安装器把权重、引擎、下载缓存和容器数据放在那里；需要 Linux 文件系统时自动建立本安装专用的稀疏 ext4 镜像。原生 Linux 可使用任意有足够空间的本地目录。首次安装联网下载依赖、构建工具镜像，之后启动直接复用。

安装命令会完成：

- 校验并下载固定版本的模型权重、llama.cpp 与 CUDA 运行库；支持断点续传。
- 准备 Node 22、固定 npm 依赖、独立 Docker Engine 和 Compose。
- 构建含 Python、pwntools、z3、sympy、Crypto、gdb、binutils、curl、nmap 等工具的容器镜像。
- 生成可编辑的 `config.json`；每次启动自动加载模型并准备工具环境。

同样可以在安装好 Harness 后，用一条命令安装模型和相关依赖：

```bash
./mini-ctf model install qwen3.8-27b-iq4xs --data-dir /path/to/mini-ctf-data
```

安装前查看下载清单和步骤：

```bash
./mini-ctf install --plan --data-dir /path/to/mini-ctf-data
```

原生 Linux 首次安装使用 sudo；WSL 通过当前发行版的 root 入口准备本安装的 Docker 和存储。驱动及 WSL 的安装涉及系统重启，由操作者预先完成。

## 固定模型版本与配置

默认权重是 [Unsloth Qwen3.8-27B UD-IQ4_XS](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/4ca720788d1e01f1bff70c033e0d0028fd02e502)，revision `4ca720788d1e01f1bff70c033e0d0028fd02e502`，14.25 GB，SHA256：

```text
40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199
```

推理引擎固定为 [llama.cpp b12144](https://github.com/ggml-org/llama.cpp/releases/tag/b12144)。全部下载地址、大小和哈希在 [installer/assets.json](installer/assets.json)。可复用已有资产：`--model-file`、`--runtime-exe`、`--docker`、`--dockerd`、`--docker-host`、`--solver-image`；权重仍校验上述 SHA256。

默认是 16 GB 显存配置：55,296 上下文、Q8 KV、单槽、无 MTP；普通生成 medium、总输出 8K；40K 软 Compact，Compact 使用 xhigh、4K 思考与 8K 总输出。硬件不同可修改数据目录的 `config.json` 中 `contextTokens`、`compactSoftTokens`、`gpuLayers`、`kvType` 等参数。预留约 30 GB 可用磁盘空间。

Thinking 采样 `temperature=1.0, top_p=0.95, top_k=20`；Non-thinking 为 `0.7, 0.80, 20`。内置 15 个原始 SKILL.md 与 32 个 References；Pi 直接发现 `.agents/skills/`，按需使用通用 `read` 读取。

## 交互

```text
Ctrl+N       新建题目，粘贴题意、选择附件、填写目标地址
/queue       查看所有题目、后台任务、待人工确认的答案
/review      选择候选并记录平台通过或错误
/model       列出模型；/model 编号或ID 切换
/effort      查看思考设置；/effort xhigh 4096 修改
/compact     当前完整轮次结束后压缩
Ctrl+C       停止生成，保留内容、后台命令及驻留模型；输入消息或 /resume 继续
/quit        保存并退出前端
```

工具接口保持简短：

```json
run_command({"command":"python3 solve.py"})
wait_job({"job_id":"j1"})
read({"path":"/work/result.txt"})
submit_flag({"candidate":"flag{...}"})
```

命令先等待最多 15 秒；未结束则给出 job ID，模型自行选择后续动作。每次 `wait_job` 最多等待 120 秒，仍在运行就提醒，后台继续执行。工具结果直接进入上下文，长输出保存成可用 `read` 打开的文件。

默认人工判题：`submit_flag` 保存候选并返回 `awaiting_review`，在 `/review` 中录入结果。`/start` 开启调度。每题的对话、工具结果、预算和检查点独立保存。页首显示源码提交号，启动身份保存在会话目录 `startups/` 中。

## Web 环境

已有内网目标：

```bash
./mini-ctf --target http://192.168.1.20:8000
```

也可在新题表单中填写目标。工具容器会使用受限的内网访问规则。

本地 Compose 题目：在 `config.json` 的 `environments` 中添加环境，例如：

```json
{
  "local-web": {
    "type": "internal",
    "network": "mini-ctf-web",
    "subnet": "172.28.248.0/24",
    "targetUrl": "http://172.28.248.10:8000",
    "composeFile": "/absolute/path/to/challenge/compose.yaml"
  }
}
```

`./mini-ctf --env local-web` 会启动对应 Compose 并预填目标地址。题目镜像需提前拉取或导入；正式解题时使用本地镜像。可添加 `imageArchives` 数组，由启动器导入离线镜像。

## 测试与目录

```bash
cd offline_harness
npm test
python3 -m unittest discover -s ../installer/test
```

`offline_harness/src/` 是运行时，`prompts/` 是普通解题和 Compact 提示词，`installer/` 管理安装及校验，`docker/` 定义工具环境。模型权重、运行记录、用户配置和依赖目录保存在本机并由 Git 忽略。

依赖 Pi、llama.cpp、Docker、Node.js 和模型各自的上游许可；下载的模型权重遵循模型发布方的许可。
