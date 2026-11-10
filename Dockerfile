FROM node:20-alpine

# Xray-core (VLESS / VMess / Trojan)
RUN apk add --no-cache curl unzip ca-certificates \
 && mkdir -p /opt/xray \
 && curl -fsSL -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
 && unzip /tmp/xray.zip xray -d /opt/xray \
 && chmod +x /opt/xray/xray \
 && rm /tmp/xray.zip \
 && apk del curl unzip

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ENV XRAY_BIN=/opt/xray/xray \
    NODE_ENV=production \
    PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
