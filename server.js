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
const PUBLIC = path.join(__dirname, 'public');

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
//  Routes (API PRIMERO)
// ─────────────────────────────────────────

app.get('/api/session', (req, res) => {
    res.json({ logged: !!req.session.user, user: req.session.user || null });
});

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Demasiados intentos.' });
    
    const { user, password } = req.body;
    if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
        req.session.user = user;
        return req.session.save(() => res.json({ success: true }));
    }
    res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
});

app.get('/api/files', auth, (req, res) => {
    res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No hay archivo' });
    const tmpPath = req.file.path;
    try {
        const msg = await bot.api.sendDocument(process.env.CHAT_ID, new InputFile(tmpPath, req.file.originalname));
        const db = getDB();
        const entry = {
            id: Date.now(),
            nombre: req.file.originalname,
            ruta: (req.body.carpeta || 'General').replace(/^\/+|\/+$/g, ''),
            file_id: msg.document.file_id,
            tipo: req.file.originalname.split('.').pop().toLowerCase(),
            size: (req.file.size / (1024 * 1024)).toFixed(3),
            fecha: Date.now()
        };
        db.push(entry);
        saveDB(db);
        res.json({ success: true, entry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
});

// ─────────────────────────────────────────
//  MANEJADOR DE WEB (AL FINAL DE TODO)
// ─────────────────────────────────────────

// 1. Servir archivos estáticos (CSS, JS)
app.use(express.static(PUBLIC));

// 2. Cualquier otra ruta que no sea API, sirve el index.html
app.get('*', (req, res) => {
    const index = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(index)) {
        res.sendFile(index);
    } else {
        res.status(404).send("Error: No encuentro el index.html en " + PUBLIC);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 CloudGram en puerto ${PORT}`);
});
