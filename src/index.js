import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { migrate } from './models/migrate.js';
import authRouter   from './routes/auth.js';
import videosRouter from './routes/videos.js';
import usersRouter  from './routes/users.js';
import aiRouter     from './routes/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static(path.join(__dirname, '..')));
app.use('/api', rateLimit({ windowMs:15*60*1000, max:300, standardHeaders:true, legacyHeaders:false }));

app.use('/api/auth',   authRouter);
app.use('/api/videos', videosRouter);
app.use('/api/users',  usersRouter);
app.use('/api/ai',     aiRouter);

app.get('/health', (_, res) => res.json({ status:'ok', app:'Miri API', db:'SQLite', version:'2.0.0', time:new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ error:`${req.method} ${req.path} не найден` }));
app.use((err, req, res, next) => {
  if (err.code==='LIMIT_FILE_SIZE') return res.status(413).json({ error:'Файл слишком большой. Макс 500 МБ' });
  res.status(err.status||500).json({ error: err.message||'Ошибка сервера' });
});

const PORT = parseInt(process.env.PORT) || 3000;
console.log('Starting on PORT:', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟡 Miri API → http://0.0.0.0:${PORT}`);
  console.log('  База данных: SQLite (miri.db)');
  console.log('  POST /api/auth/register');
  console.log('  POST /api/auth/login');
  console.log('  GET  /api/videos/feed');
  console.log('  POST /api/videos/upload');
  console.log('  POST /api/users/:id/follow');
  console.log('  POST /api/ai/generate-video');
  console.log('  POST /api/ai/generate-video-veo');
  console.log('  POST /api/ai/translate');
  console.log('  GET  /api/ai/video-status/:id\n');
});