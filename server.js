const http = require('http');
const net = require('net');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const XRAY_PORT = 8081;

// 1. 自动生成或读取持久化的随机 UUID
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

// 4. 动态生成本地静态订阅文件的核心函数
function generateLocalSubFiles(host) {
  const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=%2Fproxy#Node-Auto`;
  
  // 生成 v2rayN Base64 订阅文件 (sub.txt)
  const base64Data = Buffer.from(vlessLink).toString('base64');
  fs.writeFileSync('sub.txt', base64Data);

  // 生成 Clash 订阅文件 (clash.yaml)
  const clashYaml = `
proxies:
  - name: "Node-Auto-Clash"
    type: vless
    server: ${host}
    port: 443
    uuid: ${UUID}
    network: ws
    tls: true
    sni: ${host}
    ws-opts:
      path: "/proxy"
      headers:
        Host: ${host}

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "Node-Auto-Clash"

rules:
  - MATCH,🚀 节点选择
`.trim();
  fs.writeFileSync('clash.yaml', clashYaml);
  console.log(`[Info] Local subscription files (sub.txt, clash.yaml) updated for host: ${host}`);
}

// 5. 创建 Node.js 服务
const server = http.createServer((req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  const urlObj = new URL(req.url, `http://${host}`);
  const pathname = urlObj.pathname;
  const format = urlObj.searchParams.get('format');

  // 每次有外部访问时，顺便更新一次本地订阅文件（确保域名最新）
  generateLocalSubFiles(host);

  // 健康检查响应
  if (pathname === '/healthz' || pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // 根目录：展示面板
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (fs.existsSync('index.html')) {
      let html = fs.readFileSync('index.html', 'utf8');
      html = html.replace(/__UUID__/g, UUID).replace(/__HOST__/g, host);
      res.end(html);
    } else {
      res.end(`<h1>Server is running. UUID: ${UUID}</h1>`);
    }
  } 
  // /sub 路径：动态返回
  else if (pathname === '/sub') {
    if (format === 'clash') {
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8' });
      res.end(fs.readFileSync('clash.yaml'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync('sub.txt'));
    }
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// 6. WebSocket 流量转发
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
  // 启动时先用默认 host 生成一次本地文件
  generateLocalSubFiles('localhost');
  console.log(`Node Server is running on port ${PORT}, UUID: ${UUID}`);
});