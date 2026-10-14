FROM node:24-bookworm-slim
WORKDIR /app
COPY .dockerignore LICENSE NOTICE.md README.md ./
COPY third-party-licenses ./third-party-licenses
COPY mobile-shortcut/README.md ./mobile-shortcut/
COPY mobile-shortcut/src/build_google_shortcut.py mobile-shortcut/src/native_actions.py mobile-shortcut/src/share_input.py ./mobile-shortcut/src/
COPY ["mobile-shortcut/存入 Shelf（自配置）.shortcut", "./mobile-shortcut/"]
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY drive ./drive
COPY src/driveCrypto.ts ./src/driveCrypto.ts
COPY scripts/package-server.mjs ./scripts/package-server.mjs
COPY server/package.json server/package-lock.json server/config.example.json server/init.mjs server/setup.mjs server/deploy.sh server/README.md server/THIRD-PARTY-NOTICES.md server/Dockerfile server/compose.yml server/Caddyfile ./server/
COPY tests/server-deploy.test.mjs tests/server-package.test.mjs tests/drive-node-runtime.test.mjs ./tests/
COPY web-dist ./web-dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8790
CMD ["node", "drive/server.mjs", "server/config.local"]
