# MAGY

在 Visual Studio Code 与 Cursor 的侧边栏中，通过 Agent Client Protocol 使用随扩展安装的反重力。代理同时用于官方运行时下载和对话连接。编辑器中的选中代码可加入当前对话。Cursor 中的既有对话可只读引入并继续，原记录保持不变。

## 功能

- 侧边栏流式对话，展示回复、工具调用、计划与权限请求
- 在插件存储目录维护独立的反重力运行时，不写入系统 PATH
- `magy.proxy` 同时用于官方发布清单、安装包下载，以及反重力进程
- 在编辑器中选中代码或文本后，添加到当前对话；也可右键或 `Shift + 拖动` 文件/目录引入路径
- 引入本机 Cursor 对话。读取使用只读方式，不修改、不删除 Cursor 原有记录
- 查看账号剩余用量（5 小时 / 每周额度、AI 积分余额）与当前对话 Token 统计（上下文窗口占用与累计轮次统计）

## 设置

| 设置 | 作用 |
| --- | --- |
| `magy.proxy` | HTTP 代理，例如 `http://127.0.0.1:7890`。清单下载、安装包下载和反重力进程都走这个地址。留空时，依次使用编辑器的 `http.proxy` 和环境变量中已有的代理 |
| `magy.noProxy` | 不走代理的主机，默认 `localhost,127.0.0.1,::1`。下载与进程共用 |
| `magy.binaryPath` | 指定可执行文件。留空时使用插件目录中的运行时 |
| `magy.sandbox` | 为 `agy acp` 附加 `--sandbox` |
| `magy.dangerouslySkipPermissions` | 开启后为 `agy acp` 附加 `--dangerously-skip-permissions`，自动跳过权限确认 |
| `magy.extraArgs` | 附加在 `acp` 之后的参数 |
| `magy.cursorDataDir` | Cursor 用户数据目录，只用于读取。留空时按操作系统默认路径查找 |
| `magy.fontSize` | 侧边栏默认字体大小（单位：px，范围 11–22，默认 14） |

## 使用

1. 打开活动栏中的 MAGY。首次打开时，按当前代理从官方发布清单下载运行时到插件的 `globalStorage/runtime` 目录。
2. 按界面提示完成 Google 登录，或执行「MAGY: 设置 Gemini API Key」。
3. 在编辑器中选中代码或文本，右键选择「添加到 MAGY 对话」，或按 `Ctrl+Alt+L`（macOS 为 `Cmd+Alt+L`）；也可右键文件/目录选择「将路径添加到 MAGY 对话」，或按住 `Shift` 从资源管理器拖入对话区。Enter 发送，Shift+Enter 换行。
4. 需要沿用既有记录时，使用「引入 Cursor 对话」。来源包括 Cursor 的 composer 数据库，以及 `.cursor/projects` 下的 agent transcript。数据库以只读方式打开，并限制为查询语句。
5. 点击顶栏「用量」、底部状态栏右侧用量胶囊，或在输入框发送 `/usage`（或 `/quota`），可打开用量面板查看账号各模型组剩余额度及当前对话 Token 统计。

侧边栏颜色、字体和控件跟随当前编辑器主题。更新运行时使用命令「MAGY: 安装或更新内置反重力」。连接与安装日志在输出通道 MAGY，ACP 详细日志在插件存储目录的 `logs/acp.log`。

已打开工作区时，对话保存在该工作区的存储目录；未打开文件夹时，保存在全局存储目录。
