require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const { Bot, InputFile } = require('grammy');

// ─────────────────────────────────────────
//  Validate required env vars on startup
// ─────────────────────────────────────────
const REQUIRED = ['TELEGRAM_TOKEN', 'CHAT_ID', 'APP_USER', 'APP_PASSWORD', 'SESSION_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`[CloudGram] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const app = express();
const bot = new Bot(process.env.TELEGRAM_TOKEN);

const DB      = path.join(__dirname, 'db.json');
const UPLOADS = path.join(__dirname, 'uploads');
const PUBLIC  = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PUBLIC))  fs.mkdirSync(PUBLIC,  { recursive: true });

// ─────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC));

app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            true,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   false,
        sameSite: 'lax',
        maxAge:   8 * 60 * 60 * 1000
    }
}));

// ─────────────────────────────────────────
//  Multer – SIN límite de tamaño
// ─────────────────────────────────────────
const upload = multer({ dest: UPLOADS }); // sin limits: sin restricción

// ─────────────────────────────────────────
//  Logger
// ─────────────────────────────────────────
function log(level, msg, extra = '') {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${extra ? ' — ' + extra : ''}`);
}

// ─────────────────────────────────────────
//  DB helpers (atomic write)
// ─────────────────────────────────────────
function getDB() {
    try {
        return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : [];
    } catch {
        log('warn', 'DB read failed, returning empty array');
        return [];
    }
}

function saveDB(data) {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, DB);
}

// ─────────────────────────────────────────
//  Auth middleware
// ─────────────────────────────────────────
const auth = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
    next();
};

// ─────────────────────────────────────────
//  Rate limiter (login brute-force)
// ─────────────────────────────────────────
const loginAttempts = new Map();
const BLOCK_AFTER   = 5;
const BLOCK_WINDOW  = 15 * 60 * 1000;

function checkRateLimit(ip) {
    const now   = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, firstAt: now };
    if (now - entry.firstAt > BLOCK_WINDOW) {
        loginAttempts.set(ip, { count: 1, firstAt: now });
        return true;
    }
    entry.count++;
    loginAttempts.set(ip, entry);
    return entry.count <= BLOCK_AFTER;
}

// ─────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────

app.get('/api/session', (req, res) => {
    res.json({ logged: !!req.session.user, user: req.session.user || null });
});

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    const { user, password } = req.body;
    if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
        req.session.user = user;
        loginAttempts.delete(ip);
        log('info', `Login OK — user: ${user}`);
        return req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Error al guardar sesión' });
            res.json({ success: true });
        });
    }
    log('warn', `Login failed for user: "${user}" from ${ip}`);
    res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
    const user = req.session.user;
    req.session.destroy(() => {
        log('info', `Logout — user: ${user}`);
        res.json({ success: true });
    });
});

app.get('/api/files', auth, (req, res) => {
    res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const tmpPath = req.file.path;
    try {
        log('info', `Uploading: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
        const msg = await bot.api.sendDocument(
            process.env.CHAT_ID,
            new InputFile(tmpPath, req.file.originalname)
        );
        const db    = getDB();
        const entry = {
            id:      Date.now(),
            nombre:  req.file.originalname,
            ruta:    (req.body.carpeta || 'General').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
            file_id: msg.document.file_id,
            tipo:    req.file.originalname.split('.').pop().toLowerCase(),
            size:    (req.file.size / 1024 / 1024).toFixed(3),
            fecha:   Date.now()
        };
        db.push(entry);
        saveDB(db);
        log('info', `Upload OK — ${entry.nombre}`);
        res.json({ success: true, entry });
    } catch (e) {
        log('error', `Upload failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    } finally {
        if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch {} }
    }
});

app.delete('/api/files/:id', auth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    let db = getDB();
    const before = db.length;
    db = db.filter(f => f.id !== id);
    if (db.length === before) return res.status(404).json({ error: 'Archivo no encontrado' });
    saveDB(db);
    log('info', `Deleted file id: ${id}`);
    res.json({ success: true });
});

// Download – devuelve la URL de Telegram
app.get('/api/download/:fileId', auth, async (req, res) => {
    const fileId = req.params.fileId;
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return res.status(400).json({ error: 'File ID inválido' });
    try {
        const file = await bot.api.getFile(fileId);
        const url  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        res.json({ url });
    } catch (e) {
        log('error', `Download failed for ${fileId}: ${e.message}`);
        res.status(500).json({ error: 'No se pudo obtener el enlace de descarga' });
    }
});

// Proxy de previsualización – evita exponer el token al cliente
app.get('/api/preview/:fileId', auth, async (req, res) => {
    const fileId = req.params.fileId;
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return res.status(400).json({ error: 'File ID inválido' });
    try {
        const file = await bot.api.getFile(fileId);
        const url  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

        const https = require('https');
        https.get(url, (telegramRes) => {
            res.setHeader('Content-Type', telegramRes.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'private, max-age=3600');
            telegramRes.pipe(res);
        }).on('error', e => {
            res.status(500).json({ error: 'Error al obtener el archivo' });
        });
    } catch (e) {
        log('error', `Preview failed for ${fileId}: ${e.message}`);
        res.status(500).json({ error: 'No se pudo previsualizar' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime().toFixed(0) + 's' });
});

app.get('/{*path}', (req, res) => {
    const index = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
    log('error', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log('info', `🚀 CloudGram Enterprise → http://localhost:${PORT}`);
});