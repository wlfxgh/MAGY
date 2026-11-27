# MAGY

在 VS Code 与 Cursor 侧边栏中集成 Antigravity（反重力 / `agy`）与 ACP（Agent Client Protocol）的 AI 编程助手扩展，支持独立运行时管理、代码上下文引用、交互式问答、用量与 Token 统计以及 Cursor 对话导入。

## 主要功能

- **侧边栏流式对话**：实时展示模型回复、思考过程、文件 Diff、终端执行与权限确认请求。
- **代码与路径上下文**：支持快捷键、右键菜单或 `Shift + 拖拽` 添加代码选区、文件及目录。
- **交互式问答**：支持代理发起的单选、多选、开关、文本/数值表单以及浏览器外链授权确认。
- **用量与 Token 统计**：展示当前对话上下文窗口占用、累计轮次 Token 消耗以及账号各模型组剩余额度。
- **Cursor 对话导入**：支持只读扫描本机 Cursor 会话数据库与 Agent Transcript 记录，导入后延续上下文。
- **对话导出**：支持将当前或历史对话导出为 Markdown 或 JSON 文件，保留思考过程、代码块、Diff 与 Token 统计。
- **内置设置与账号管理**：支持 Google 账号登录、切换与退出登录，以及 API Key、自定义 HTTP 代理、字体大小、沙盒模式、跳过权限确认和本地二进制路径配置。

## 快速开始

1. 安装扩展并在活动栏打开 **MAGY**。
2. 首次启动会自动下载并准备 Antigravity 运行时至扩展全局存储目录（也可以在设置中通过 `magy.binaryPath` 指定已有可执行文件）。
3. 点击 **Log in with Google** 完成授权，或在设置面板中配置 Gemini API Key。
4. 在底部输入框直接发送任务。

## 常用操作

- **添加代码选区**：在编辑器中选中代码后右键点击「添加到 MAGY 对话」，或使用快捷键 `Ctrl+Alt+L`（macOS 为 `Cmd+Alt+L`）。
- **添加文件 / 目录**：右键文件或目录选择「将路径添加到 MAGY 对话」，或按住 `Shift` 从资源管理器拖入输入框。
- **导入 Cursor 对话**：点击顶栏导入按钮或执行命令 `MAGY: 引入 Cursor 对话`。
- **导出对话**：点击顶栏或历史面板中的导出按钮，或执行命令 `MAGY: 导出当前对话`。
- **查看用量**：点击顶栏「用量」、底部状态栏右侧用量指示器，或在输入框发送 `/usage`（或 `/quota`）。

> 对话历史在打开工作区时保存于对应工作区存储目录，未打开文件夹时保存于全局存储目录。执行与协议日志可在「输出 -> MAGY」及存储目录 `logs/acp.log` 查看。

## 配置项

| 设置项 | 说明 |
| --- | --- |
| `magy.proxy` | HTTP 代理地址（如 `http://127.0.0.1:7890`），作用于运行时下载、认证与代理进程；留空时继承编辑器 `http.proxy` 与系统环境变量 |
| `magy.noProxy` | 不走代理的主机列表，默认 `localhost,127.0.0.1,::1` |
| `magy.binaryPath` | 自定义 `agy` 可执行文件路径；留空时使用扩展管理的内置运行时 |
| `magy.sandbox` | 启动 `agy acp` 时附加 `--sandbox` 参数 |
| `magy.dangerouslySkipPermissions` | 启用后附加 `--dangerously-skip-permissions`，自动批准所有工具、编辑与命令确认 |
| `magy.extraArgs` | 附加在 `acp` 子命令后的自定义参数列表 |
| `magy.cursorDataDir` | 自定义本机 Cursor 用户数据目录；留空时按系统默认路径自动探测 |
| `magy.fontSize` | 侧边栏字体大小（px，范围 `11–22`，默认 `14`） |

## License

[MIT](LICENSE)
