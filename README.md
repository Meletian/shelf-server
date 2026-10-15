# Shelf Server

跨设备、跨网络的临时文件托盘服务。文件存入每个用户自己的 Google Drive；服务提供 Google 登录、设备同步、手机上传和跨账号分享。包含可直接运行的 PWA。

**源码公开，限非商业使用。** Shelf 自有代码使用 [PolyForm Noncommercial 1.0.0](LICENSE)；商业用途需向仓库作者另行取得许可。第三方组件保留各自许可，见 [NOTICE.md](NOTICE.md) 和 [third-party-licenses](third-party-licenses)。

## 一条命令部署

在能访问 Google API 的 Linux 服务器上，准备 Git、Docker Engine 和 Docker Compose，将自己的域名解析到服务器，开放 TCP 80/443。

```sh
git clone https://github.com/Meletian/shelf-server.git && cd shelf-server && bash server/deploy.sh
```

首次按提示输入：自己的域名、Google Client ID、Google Client Secret（输入隐藏）。脚本生成并保护固定密钥和配置，构建服务、自动申请 HTTPS，检查通过后显示使用地址。无需在宿主机安装 Node。

**Google 开发者配置仍须部署者做一次**，普通用户无需创建 Google 项目。先在 Google Cloud 启用 Drive API，创建 Web application OAuth 客户端，把回调设为 `https://你的域名/oauth/callback/google`。完整图文路径与权限清单见 [部署指南](server/README.md#2-google-开发者配置仅部署者做一次)。脚本不能自动完成 Google 审核或控制台设置。

已下载代码、正在修正域名或再次启动时：

```sh
cd shelf-server && bash server/deploy.sh
```

升级请在原部署目录运行 `git pull --ff-only`，然后重新运行部署脚本。保留 `server/config.local`、`server/.env` 和 Docker 数据卷；不要重新生成服务密钥。不要在不同目录初始化第二套服务来代替原实例。

## 连接 Shelf

- **桌面：**在支持“自配置服务”的 Shelf 版本中填 `https://你的域名`，检查连接，再登录 Google。
- **网页 / PWA：**打开 `https://你的域名/app/`；手机可添加到主屏幕。
- **iPhone 分享上传：**下载 [存入 Shelf（自配置）.shortcut](mobile-shortcut/存入%20Shelf（自配置）.shortcut)，添加到苹果“快捷指令”；首次输入同一服务器地址，再登录 Google。文件、PDF、图片或短信文字可通过分享菜单存入。原文件不重新编码；短信 RTFD 转文字卡片。每次处理一个分享项目。

跨账号分享的双方须使用同一个服务地址。新服务器对应新账号空间，原服务器数据不会自动迁移。文件下载支持同账号 Google 直传；跨账号分享由本服务中转。

## 数据与信任

Google refresh token、账号密钥、会话及分享状态存于服务器数据卷，由固定服务密钥保护。**服务器运营者拥有解密这些状态的能力**；请使用你信任的服务器。每个用户文件存入自己的 Drive。私有配置、数据、密码和令牌不要提交到 GitHub。

备份和恢复、域名与证书排错、单实例限制，以及无 Docker 的手动部署见 [完整部署指南](server/README.md)。

## 文件说明

| 路径 | 内容 |
|---|---|
| `drive/` | 授权、同步、分享、手机上传及独立 Node 服务源码 |
| `server/` | 配置示例、交互初始化、Docker / Caddy 部署 |
| `web-dist/` | PWA 编译产物及相关第三方许可 |
| `mobile-shortcut/` | 已通过苹果官方签名的自配置快捷指令及生成源码 |
| `src/driveCrypto.ts` | 加密格式与兼容实现 |
| `tests/` | 独立服务、配置保护、导出和部署流程检查 |

## 验证范围

```sh
npm ci --ignore-scripts
npm test
```

需要 Node.js 24.12 或更新版本。检查包含真实本地 HTTP / WebSocket、状态持久化、单实例锁、停机等待，以及部署脚本的配置保存与失败路径。Google 与 Docker 外部边界使用受控测试依赖；没有据此宣称远程 Linux / 新 OAuth 项目已实测。短信文字修复已获用户实体 iPhone 确认；自配置版的新服务器授权仍需部署后验证。

## Cloudflare 私有空间（无需 Google）

如果只需自己的多台设备同步，可使用独立 Worker＋私有 R2＋D1。无需 VPS 或 Google API 授权；Shelf 不人为限制容量或请求，Cloudflare 自身额度及费用仍适用。

[完整部署教程与一条命令](https://github.com/Meletian/shelf-server/releases/download/private-cf-v1.0.0/CLOUDFLARE-SETUP.md) · [源码和 PWA 部署包](https://github.com/Meletian/shelf-server/releases/tag/private-cf-v1.0.0)

在 Shelf 0.3.59 或更新版本选择「自配置服务 → Cloudflare 私有空间」，填写向导输出的服务地址。官方托管空间另有每账号500 MB、每天10,000次及每分钟120次请求限制。
