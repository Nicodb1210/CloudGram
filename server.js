require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const { Readable } = require('stream');
const { Bot, InputFile } = require('grammy');

const REQUIRED = ['TELEGRAM_TOKEN', 'CHAT_ID', 'APP_USER', 'APP_PASSWORD', 'SESSION_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Faltan env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "https:", "https://api.telegram.org"],
        "media-src": ["'self'", "https://api.telegram.org"],
        "frame-src": ["'self'", "https://api.telegram.org"],
        "connect-src": ["'self'"]
      }
    }
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const isProduction = process.env.NODE_ENV === 'production';

app.use(
  session({
    name: 'cloudgram.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const DB = path.join(__dirname, 'db.json');
const UPLOADS = path.join(__dirname, 'uploads');
const PUBLIC = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PUBLIC)) fs.mkdirSync(PUBLIC, { recursive: true });

const upload = multer({ dest: UPLOADS });

function getDB() {
  try {
    return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : [];
  } catch {
    return [];
  }
}

function saveDB(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

function normalizeFolder(folder = '') {
  return String(folder || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function mimeFromExt(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mov': 'video/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8'
  };
  return map[ext] || fallback;
}

const auth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'No autorizado' });
};

app.get('/api/session', (req, res) => {
  const isLogged = !!(req.session && req.session.user);
  res.json({ logged: isLogged, user: isLogged ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
  const { user, password } = req.body;
  if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
    req.session.user = user;
    return req.session.save(() => res.json({ success: true }));
  }
  res.status(401).json({ error: 'Incorrecto' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/files', auth, (req, res) => {
  res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  try {
    const msg = await bot.api.sendDocument(
      process.env.CHAT_ID,
      new InputFile(req.file.path, req.file.originalname)
    );

    if (!msg || !msg.document) throw new Error('Telegram no devolvió documento');

    const db = getDB();
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const carpeta = normalizeFolder(req.body.carpeta) || 'General';

    db.push({
      id: Date.now(),
      nombre: req.file.originalname,
      carpeta,
      file_id: msg.document.file_id,
      size: (req.file.size / (1024 * 1024)).toFixed(2),
      tipo: ext || 'file',
      fecha: new Date().toISOString()
    });

    saveDB(db);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al enviar a Telegram' });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.delete('/api/delete/:id', auth, (req, res) => {
  let db = getDB();
  db = db.filter((f) => String(f.id) !== String(req.params.id));
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/delete-folder', auth, (req, res) => {
  const carpeta = normalizeFolder(req.body.carpeta);
  if (!carpeta) return res.status(400).json({ error: 'Carpeta inválida' });

  let db = getDB();
  db = db.filter((f) => {
    const fileFolder = normalizeFolder(f.carpeta);
    return !(fileFolder === carpeta || fileFolder.startsWith(carpeta + '/'));
  });

  saveDB(db);
  res.json({ success: true });
});

app.get('/api/download/:file_id', auth, async (req, res) => {
  try {
    const file = await bot.api.getFile(req.params.file_id);
    const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
    const upstream = await fetch(telegramUrl);

    if (!upstream.ok || !upstream.body) {
      return res.status(500).json({ error: 'No se pudo descargar el archivo' });
    }

    const filename = req.query.name
      ? decodeURIComponent(String(req.query.name))
      : path.basename(file.file_path);

    res.set('Content-Type', mimeFromExt(file.file_path, upstream.headers.get('content-type') || 'application/octet-stream'));
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.set('Content-Length', contentLength);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo descargar el archivo' });
  }
});

app.get('/api/preview/:file_id', auth, async (req, res) => {
  try {
    const file = await bot.api.getFile(req.params.file_id);
    const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(telegramUrl, { headers });
    if (!upstream.ok || !upstream.body) {
      return res.status(404).send('No disponible');
    }

    res.status(upstream.status);
    res.set('Content-Type', mimeFromExt(file.file_path, upstream.headers.get('content-type') || 'application/octet-stream'));
    res.set('Accept-Ranges', 'bytes');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.set('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.set('Content-Range', contentRange);

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    console.error(e);
    res.status(404).send('No disponible');
  }
});

app.use(express.static(PUBLIC));

app.use((req, res) => {
  const indexFile = path.join(PUBLIC, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
