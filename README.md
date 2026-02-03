# pinyin-father-chat（Vercel 友好部署）

## 本地运行（可选）

1. 复制环境变量文件：
   - `pinyin-father-chat/.env.example` → `pinyin-father-chat/.env`
2. 填写 `.env`：
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_URL`（可填 base url 或完整 endpoint）
   - `DEEPSEEK_MODEL`
3. 启动：
   - `node server.js`
4. 打开：
   - `http://127.0.0.1:5179`

## 部署到 Vercel（推荐）

1. 把整个 `pinyin-father-chat` 文件夹作为一个项目部署（或设为项目根目录）。
2. 在 Vercel 项目里设置 Environment Variables：
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_URL`（默认 `https://api.deepseek.com/v1`）
   - `DEEPSEEK_MODEL`（默认 `deepseek-chat`）
3. 访问站点即可：
   - 前端：`/index.html`
   - 配置：`/api/config`
   - 代理：`/api/chat`

## 使用方式

- 页面只有一个输入框：把“孩子信息 + 孩子的话”直接粘贴进去即可
- 回复会先流式输出（像 ChatGPT），完成后自动切换为“拼音在上 / 汉字在下”的逐字对齐显示

## 真 API 冒烟测试（会产生少量费用）

前提：本地 `pinyin-father-chat/.env` 已填好 `DEEPSEEK_API_KEY`。

- 运行：`node scripts/smoke-real-api.js`
