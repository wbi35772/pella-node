const http = require('http');
const net = require('net');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const XRAY_PORT = 8081;

// 1. 自动生成或读取持久化的随机 UUID（多账号下每个账号独立随机）
let UUID = process.env.UUID;
if (!UUID) {
  if (fs.existsSync('uuid.txt')) {
    UUID = fs.readFileSync('uuid.txt', 'utf8').trim();
  } else {
    UUID = crypto.randomUUID();
    fs.writeFileSync('uuid.txt', UUID);
    console.log(`Generated new random UUID: ${UUID}`);
  }
}

// 2. 生成 Xray 配置文件
const config = {
  inbounds: [{
    port: XRAY_PORT,
    listen: "127.0.0.1",
    protocol: "vless",
    settings: { clients: [{ id: UUID }], decryption: "none" },
    streamSettings: { network: "ws", wsSettings: { path: "/proxy" } }
  }],
  outbounds: [{ protocol: "freedom" }]
};
fs.writeFileSync('config.json', JSON.stringify(config));

// 3. 自动下载并启动官方 Xray 核心
const startCmd = `
if [ ! -f ./xray ]; then
  echo "Downloading Xray..."
  wget -qO xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip || curl -sL -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
  unzip -q xray.zip xray
  chmod +x xray
  rm xray.zip
fi
./xray -config config.json
`;
fs.writeFileSync('start.sh', startCmd);
exec('sh start.sh', (error) => {
  if (error) console.error(`Xray Error: ${error}`);
});

// 4. 创建纯 Node.js 服务（全动态抓取 Host，不写死任何域名）
const server = http.createServer((req, res) => {
  // 动态捕获当前平台分配的真实域名（包含端口或不包含都兼容）
  const rawHost = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  const currentHost = rawHost.split(':')[0]; // 剥离可能存在的端口号

  const urlObj = new URL(req.url, `http://${rawHost}`);
  const pathname = urlObj.pathname;
  const format = urlObj.searchParams.get('format');

  if (pathname === '/healthz' || pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // 根目录：动态渲染当前域名的面板
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (fs.existsSync('index.html')) {
      let html = fs.readFileSync('index.html', 'utf8');
      html = html.replace(/__UUID__/g, UUID).replace(/__HOST__/g, currentHost);
      res.end(html);
    } else {
      res.end(`<h1>Server is running. UUID: ${UUID}</h1>`);
    }
  } 
  // /sub 路径：动态生成当前域名的订阅
  else if (pathname === '/sub') {
    const vlessLink = `vless://${UUID}@${currentHost}:443?encryption=none&security=tls&type=ws&host=${currentHost}&path=%2Fproxy#Node-${currentHost.split('.')[0]}`;

    if (format === 'clash') {
      const clashYaml = `
proxies:
  - name: "Node-${currentHost.split('.')[0]}"
    type: vless
    server: ${currentHost}
    port: 443
    uuid: ${UUID}
    network: ws
    tls: true
    sni: ${currentHost}
    skip-cert-verify: true
    ws-opts:
      path: "/proxy"
      headers:
        Host: ${currentHost}

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "Node-${currentHost.split('.')[0]}"

rules:
  - MATCH,🚀 节点选择
`.trim();
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
      res.end(clashYaml);
    } else {
      const base64Data = Buffer.from(vlessLink).toString('base64');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(base64Data);
    }
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// 5. WebSocket 流量无缝转发
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/proxy') {
    const proxySocket = net.connect(XRAY_PORT, '127.0.0.1', () => {
      proxySocket.write(head);
      socket.pipe(proxySocket);
      proxySocket.pipe(socket);
    });
    proxySocket.on('error', () => socket.end());
    socket.on('error', () => proxySocket.end());
  } else {
    socket.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Node Server is running on port ${PORT}, UUID: ${UUID}`);
});
