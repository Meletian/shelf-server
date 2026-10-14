# 自己搭建 Shelf 服务

此包包含授权、账号状态、Google 文件同步、手机上传和跨账号分享的服务源码，以及可直接使用的 PWA 编译产物。不依赖原运营者的 Cloudflare。默认单进程、单实例；文件存在各用户自己的 Google Drive。跨账号分享双方须连接同一个服务地址。

## 1. 服务器和域名

准备可连接 Google API 的服务器、自己的域名及 Docker Compose。将域名 A/AAAA 指向服务器，开放 TCP 80/443。服务器只运行一个 Shelf 实例；不要把同一数据卷共享给两个实例。没有云服务收费保证：服务器、域名、网络和 Google 配额由部署者负责。

## 2. Google 开发者配置（仅部署者做一次）

在 https://console.cloud.google.com 创建项目：

1. API 和服务 → 库 → 启用 Google Drive API。
2. Google Auth Platform → Branding 填名称、支持邮箱、首页、隐私说明；Audience 选外部。测试阶段加入每个测试账号。测试模式授权可能很快过期；面向其他用户需按 Google 要求转生产及完成所需审核。
3. Data Access 配置 `openid`、`profile`、`email`、`https://www.googleapis.com/auth/drive.file`。不要额外请求整个网盘权限。
4. Clients → 创建 **Web application** OAuth 客户端。Authorized redirect URI 必须是 `https://你的域名/oauth/callback/google`，精确匹配。这个后端流程不需要把桌面应用设为 JavaScript 来源。
5. Client ID 和 Client Secret 只填在服务器私有配置。普通用户只需在应用内输入服务器地址，再登录自己的 Google 账号。

## 3. 初始化、启动

在装好 Docker Engine 和 Docker Compose 的 **Linux 服务器**上，解压本包，在包根目录只运行：

```sh
bash server/deploy.sh
```

按提示输入自己的域名、Google Client ID 和 Client Secret（输入隐藏）。不需要在宿主机安装 Node。脚本生成私有配置与固定随机密钥，启动 Shelf 和 Caddy，只有外部 HTTPS 健康检查及协议检查通过后才提示“部署完成”，并给出 PWA、Google 回调和手机使用地址。域名须解析到服务器，80/443 端口须开放。

未安装 Docker 时脚本会明确停止，按 [Docker 官方安装说明](https://docs.docker.com/engine/install/) 安装后重试；无 Docker 权限时使用 `sudo bash server/deploy.sh`。脚本不会自行修改系统软件源或删除 Docker 数据。

Google 第 2 节的开发者配置仍须部署者做一次，脚本不能替你创建 OAuth 应用。Client Secret 只写入 `server/config.local`，不放命令参数或日志。配置权限为0600，Docker 内固定 node 用户读取；备份该文件可能需要 sudo。

**重复运行同一条命令即可重新构建和启动**，保留原密钥、域名、OAuth 客户端及 Docker 数据卷。升级时在原解压目录更新公开源码，保留 `server/config.local` 和 `server/.env`；不要解压到不同目录启动第二套实例。脚本拒绝残缺配置、链接配置或域名不匹配，不会通过重建密钥“修复”旧数据。仅配置已保存而 `.env` 缺失时，可从原配置恢复域名。

HTTPS 检查失败时，检查域名解析、80/443 及 `docker compose --env-file server/.env -f server/compose.yml logs --tail 50 caddy`，修正后重新运行。构建失败或无法连接时不提示成功，也不删除已启动服务或数据。

保留原来的手动入口 `node server/init.mjs https://shelf.example.com`（需要 Node.js 24.12 或更新版本），供熟悉部署的用户手动编辑配置。`origin`、`encryptionKey` 和 `storageNamespace` 上线后须保持固定。

PWA 在 `https://你的域名/app/`，源码导出在 `/shelf-server-source.zip`。配套签名的“存入 Shelf（自配置）”快捷指令作为单独文件交付，首次填相同服务地址即可。

不使用 Docker 时，在根目录 `npm ci --omit=dev`，将配置的 dataDirectory 改为可写的本地绝对目录；listenHost 改为127.0.0.1，外部 Caddy/Nginx 反代端口8790并保留Host、支持WebSocket和流式上传，再 `npm start`。反代须支持大请求和较长上传时间。

## 4. 连接电脑和手机

Shelf → 账号 → 自配置服务 → 填最终地址 → 检查连接 → 前往 Google 授权。第一次在新实例连接是独立空间；原服务器的账号、密钥和文件不会自动搬过来。同账号文件直接传 Google，跨账号分享保留本服务中转。

手机 PWA 打开自己域名 `/app/` 并添加到主屏幕。使用本次“存入 Shelf（自配置）”快捷指令，首次输入相同服务器地址，在 Google 页面授权；不要把密码或令牌发给部署者。快捷指令缓存与服务地址绑定。

## 5. 数据、备份和恢复

服务器保存加密后的 Google refresh token、空间密钥、会话、分享/上传状态，使用 `encryptionKey` 保护。服务器运营者拥有解密能力，HTTPS 和卡片加密不能消除此信任。原文件和加密副本在用户 Drive 中。不要把 `server/config.local`、`.env`、数据卷、日志或密钥提交到 GitHub。

备份：先停止 shelf 服务，再备份整个 shelf_data 卷和私有配置/密钥；保留 Caddy 证书卷。恢复时使用相同 origin、storageNamespace、encryptionKey、Google OAuth 客户端和数据，再启动一个实例。丢失服务密钥无法通过换一个新密钥恢复旧账号空间；程序拒绝错误密钥，不会重建覆盖。

升级：保留私有配置和数据，停止旧实例，换新源码/资源后重新构建并启动。正常停止和系统崩溃后系统会释放 SQLite 目录锁，锁文件不是待清理文件。没有持久保存原文件到服务端目录；上传/分享故障状态由定时维护恢复、清理。

代理来源默认仅使用 TCP 来源。若需按真实客户端限流，请配置可信反代的精确IP到 trustedProxies，并让反代重写 X-Forwarded-For。不得信任任意外部传入的转发头；应限制 Node 端口只可由反代访问。

## 源码与许可

本仓库源码公开，Shelf 自有代码限非商业用途，按根目录 LICENSE（PolyForm Noncommercial 1.0.0）及 NOTICE.md 使用。商业用途需作者单独授权。第三方组件、字体与运行环境遵循各自许可证，见 third-party-licenses 和 THIRD-PARTY-NOTICES.md。桌面客户端许可不由本仓库授予；PWA 编译产物随包提供。

本机测试覆盖 Node 和模拟 Google 的完整接口。Docker 镜像、远程 HTTPS、真实 Google 新 OAuth 项目、实体 Windows/iPhone 须在部署后验证。
