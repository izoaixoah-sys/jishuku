# 耳塾 — 日语听力会话练习

在本地跑一个日语听力 + AI 问答的练习工具。搜索或粘贴日语文章，听真人朗读、看假名注音、对照中文翻译，随时暂停向 AI 提问语法和词汇。

## 功能

- 🔍 搜索日语维基百科文章，或粘贴任意日语文本
- 🔊 逐句朗读（Edge Neural 高音质 / 系统语音备用），可调速
- 📖 汉字假名注音（kuromoji 自动分析）
- 🌏 中文 / 英文翻译对照（需配置大模型）
- 💬 AI 问答助手，了解当前朗读句的语法和词汇
- 🎤 语音输入，支持中文和日文切换
- ⚙ 支持 Anthropic、OpenAI、Ollama（本地）、DeepSeek、Groq 等多种大模型

## 环境要求

- **Node.js 18 或更高版本**（[下载地址](https://nodejs.org/zh-cn/download)）
- 大模型 API Key（可选；也可用本地 Ollama，完全免费）
- 推荐使用 **Microsoft Edge** 浏览器以获得最佳语音质量

## 安装

### Windows

```
双击运行 install.bat
```

### macOS / Linux

```bash
bash install.sh
```

安装脚本会自动完成：
1. 检查 Node.js 版本
2. 安装依赖包（`npm install`）
3. 生成 `.env` 配置文件

## 启动

### Windows

```
双击运行 start.bat
```

### macOS / Linux

```bash
bash start.sh
```

或直接：

```bash
npm start
```

启动后访问：**http://localhost:3000**

## 配置大模型（可选）

翻译和 AI 问答功能需要配置大模型。点击页面右上角 ⚙ 按钮进行配置：

| 提供商 | 说明 |
|--------|------|
| Anthropic | 需要 API Key，质量好 |
| OpenAI | 需要 API Key |
| Ollama | 本地运行，完全免费，需先安装 [Ollama](https://ollama.com) |
| DeepSeek | 价格低，需要 API Key |
| Groq | 免费额度，需要 API Key |

配置后点击"保存"，下次启动自动加载。历史配置会保存，方便切换。

也可以在项目根目录的 `.env` 文件中预设 Anthropic Key：

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## 文件结构

```
jishuku/
├── server.js          # 后端服务（Express + kuroshiro）
├── public/
│   ├── index.html     # 页面
│   ├── app.js         # 前端逻辑
│   └── style.css      # 样式
├── install.bat        # Windows 一键安装
├── install.sh         # macOS/Linux 一键安装
├── start.bat          # Windows 启动
├── start.sh           # macOS/Linux 启动
└── .env.example       # 环境变量模板
```

## 常见问题

**Q：没有 API Key 也能用吗？**  
可以。假名注音和文章朗读完全不需要大模型。翻译和 AI 问答需要配置大模型，推荐免费的本地 Ollama。

**Q：朗读声音很机械怎么办？**  
推荐使用 Microsoft Edge 浏览器，它内置了 Nanami（七海）、Keita（圭太）等高质量日语 Neural 语音，无需额外安装。

**Q：日语维基百科访问慢？**  
正常现象，ja.wikipedia.org 在部分网络环境下较慢。可使用"粘贴文本"功能直接粘贴日语文章。

**Q：npm install 速度慢？**  
可以使用国内镜像：
```bash
npm install --registry https://registry.npmmirror.com
```
