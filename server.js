const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
require('dotenv').config({ path: '../.env' });

const app = express();
const PORT = process.env.GATEWAY_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskflow-pro-super-secret-key-2024';

// ─── Middleware ─────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
// app.use(express.json()); // Removed to allow proxy to forward raw body stream
app.use(morgan(':method :url :status :response-time ms'));

// ─── Rate Limiting (Disabled for Dev) ──────────────────
/*
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);
*/

// ─── Auth Middleware ────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const publicPaths = ['/users/login', '/users/register', '/health'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.headers['x-user-id'] = decoded.id;
    req.headers['x-user-email'] = decoded.email;
    req.headers['x-user-role'] = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
app.use('/api', authMiddleware);

// ─── Service Registry ───────────────────────────────────
const services = {
  users:         `http://localhost:${process.env.USER_SERVICE_PORT || 3001}`,
  projects:      `http://localhost:${process.env.PROJECT_SERVICE_PORT || 3002}`,
  tasks:         `http://localhost:${process.env.TASK_SERVICE_PORT || 3003}`,
  analytics:     `http://localhost:${process.env.ANALYTICS_SERVICE_PORT || 3004}`,
  notifications: `http://localhost:${process.env.NOTIFICATION_SERVICE_PORT || 3005}`,
  messages:      `http://localhost:${process.env.MESSAGE_SERVICE_PORT || 3006}`,
  payments:      `http://localhost:${process.env.PAYMENT_SERVICE_PORT || 3007}`,
};

// ─── Health Check ───────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const checks = {};
  for (const [name, url] of Object.entries(services)) {
    try {
      const resp = await fetch(`${url}/health`);
      checks[name] = resp.ok ? 'healthy' : 'unhealthy';
    } catch {
      checks[name] = 'unreachable';
    }
  }
  res.json({ gateway: 'healthy', services: checks, timestamp: new Date().toISOString() });
});

// ─── Proxy Routes ───────────────────────────────────────
const proxyOptions = (target) => ({
  target,
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/api\/[^/]+/, ''),
  onError: (err, req, res) => {
    console.error(`Proxy error: ${err.message}`);
    res.status(502).json({ error: 'Service unavailable' });
  },
});

app.use('/api/users', createProxyMiddleware(proxyOptions(services.users)));
app.use('/api/projects', createProxyMiddleware(proxyOptions(services.projects)));
app.use('/api/tasks', createProxyMiddleware(proxyOptions(services.tasks)));
app.use('/api/analytics', createProxyMiddleware(proxyOptions(services.analytics)));
app.use('/api/notifications', createProxyMiddleware(proxyOptions(services.notifications)));
app.use('/api/messages', createProxyMiddleware(proxyOptions(services.messages)));
app.use('/api/payments', createProxyMiddleware(proxyOptions(services.payments)));

// ─── Start ──────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🔀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   API Gateway running on port ${PORT}`);
  console.log(`   Routes:`);
  Object.entries(services).forEach(([name, url]) => {
    console.log(`     /api/${name} → ${url}`);
  });
  console.log(`🔀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

// ─── WebSocket Proxy ────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  
  if (pathname.startsWith('/api/notifications')) {
    const target = services.notifications;
    const wsProxy = createProxyMiddleware({ target, ws: true, changeOrigin: true });
    wsProxy.upgrade(req, socket, head);
  }
});
