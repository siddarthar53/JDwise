import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { connectDB } from './db';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import jdRoutes from './routes/jds';
import chatRoutes from './routes/chat';
import notificationRoutes from './routes/notifications';
import adminRoutes from './routes/admin';
import assistantRoutes from './routes/assistant';
import meRoutes from './routes/me';
import internalRoutes from './routes/internal';
import { agentAvailable, agentConfigured, agentProvider } from './utils/agentClient';
import { startOpsScheduler } from './utils/opsScheduler';

export function buildApp() {
  const app = express();
  const origins = (process.env.CLIENT_ORIGIN || 'http://localhost:8080').split(',').map((o) => o.trim());
  app.use(cors({ origin: origins, credentials: true }));
  // keep the raw body for HMAC verification of agent callbacks
  app.use(express.json({ limit: '2mb', verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.get('/api/health', async (_req, res) => {
    const agentOk = await agentAvailable();
    res.json({ ok: true, service: 'jd-platform-api', agent: { configured: agentConfigured(), online: agentOk, provider: agentProvider() || null } });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/jds', jdRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/assistant', assistantRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/internal', internalRoutes);

  app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 5000;
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/jd-platform';
  connectDB(MONGODB_URI)
    .then(() => {
      buildApp().listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));
      startOpsScheduler();
    })
    .catch((err) => {
      console.error('[api] failed to connect to MongoDB:', err.message);
      process.exit(1);
    });
}
