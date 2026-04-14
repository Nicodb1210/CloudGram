require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const helmet   = require('helmet');
const { Bot, InputFile } = require('grammy');

// 1. VALIDACIÓN VARIABLES DE ENTORNO
const REQUIRED = ['TELEGRAM_TOKEN', 'CHAT_ID', 'APP_USER', 'APP_PASSWORD', 'SESSION_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`❌ Faltan variables: ${missing.join(', ')}`);
    process.exit(1);
}

const app = express();

// 2. CONFIGURACIÓN DE SEGURIDAD Y PARSERS
app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "img-src": ["'self'", "data:", "https:"],
            "connect-src": ["'self'"]
        }
    }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// 3. CONFIGURACIÓN DE SESIÓN (Corregida sin errores de sintaxis)
app.use(session({
    name: 'cloudgram.sid',
    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    proxy: true,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

// 4. PREPARACIÓN DE DIRECTORIOS Y BOT
const bot = new Bot(process.env.TELEGRAM_TOKEN);
const DB = path.join(__dirname, 'db.json');
const UPLOADS = path.join(__dirname, 'uploads');
const PUBLIC = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PUBLIC))  fs.mkdirSync(PUBLIC, { recursive: true });

const upload = multer({ dest: UPLOADS });

// 5. FUNCIONES DE BASE DE DATOS
function getDB() {
    try {
        return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : [];
    } catch (e) {
        return [];
    }
}
function saveDB(data) {
    fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

// 6. MIDDLEWARE DE AUTENTICACIÓN
const auth = (req, res, next) => {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ error: 'No autorizado' });
};

// 7. RUTAS DE LA API
app.get('/api/session', (req, res) => {
    const isLogged = !!(req.session && req.session.user);
    res.json({ logged: isLogged, user: isLogged ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
    const { user, password } = req.body;
    if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
        req.session.user = user;
        return req.session.save((err) => {
            if (err) return res.status(500).json({ error: 'Error de sesión' });
            res.json({ success: true });
        });
    }
    res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/files', auth, (req, res) => {
    res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' });
    const tmpPath = req.file.path;
    try {
        const msg = await bot.api.sendDocument(
            process.env.CHAT_ID, 
            new InputFile(tmpPath, req.file.originalname)
        );
        const db = getDB();
        const entry = {
            id: Date.now(),
            nombre: req.file.originalname,
            carpeta: (req.body.carpeta || 'General').trim(),
            file_id: msg.document.file_id,
            tipo: req.file.mimetype,
            size: req.file.size,
            fecha: new Date().toISOString()
        };
        db.push(entry);
        saveDB(db);
        res.json({ success: true, entry });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al enviar a Telegram' });
    } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
});

app.delete('/api/file/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    let db = getDB().filter(f => f.id !== id);
    saveDB(db);
    res.json({ success: true });
});

// 8. ARCHIVOS ESTÁTICOS Y FALLBACK
app.use(express.static(PUBLIC));
app.use((req, res) => {
    res.sendFile(path.join(PUBLIC, 'index.html'));
});

// 9. LANZAMIENTO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});function getDB() {
    try { return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : []; }
    catch (e) { return []; }
}
function saveDB(data) {
    fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

// 5. AUTH MIDDLEWARE (Blindado contra undefined)
const auth = (req, res, next) => {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ error: 'No autorizado' });
};

// 6. API ROUTES
app.get('/api/session', (req, res) => {
    // Verificación segura para evitar el error de la captura
    const isLogged = !!(req.session && req.session.user);
    res.json({ logged: isLogged, user: isLogged ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
    const { user, password } = req.body;
    if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
        req.session.user = user;
        return req.session.save((err) => {
            if (err) return res.status(500).json({ error: 'Error al guardar sesión' });
            res.json({ success: true });
        });
    }
    res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/files', auth, (req, res) => {
    res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const tmpPath = req.file.path;
    try {
        const msg = await bot.api.sendDocument(process.env.CHAT_ID, new InputFile(tmpPath, req.file.originalname));
        const db = getDB();
        const entry = {
            id: Date.now(),
            nombre: req.file.originalname,
            carpeta: (req.body.carpeta || 'General').trim(),
            file_id: msg.document.file_id,
            tipo: req.file.mimetype,
            size: req.file.size,
            fecha: new Date().toISOString()
        };
        db.push(entry);
        saveDB(db);
        res.json({ success: true, entry });
    } catch (e) {
        res.status(500).json({ error: 'Error Telegram' });
    } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
});

app.delete('/api/file/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    let db = getDB().filter(f => f.id !== id);
    saveDB(db);
    res.json({ success: true });
});

// 7. STATIC & FALLBACK (Al final)
app.use(express.static(PUBLIC));
app.use((req, res) => {
    res.sendFile(path.join(PUBLIC, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 CloudGram PRO en puerto ${PORT}`));    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    proxy: true,
    cookie: {
        httpOnly: true,
        secure: true, // Obligatorio para HTTPS en Render
        sameSite: 'none', // Crucial para que no se bloquee el login
        maxAge: 8 * 60 * 60 * 1000
    }
}));

// ─────────────────────────────────────────
// MULTER
// ─────────────────────────────────────────
const upload = multer({ dest: UPLOADS });

function log(level, msg, extra = '') {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level}] ${msg}${extra ? ' → ' + extra : ''}`);
}

// ─────────────────────────────────────────
// DB LOGIC
// ─────────────────────────────────────────
function getDB() {
    try {
        return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : [];
    } catch (e) {
        return [];
    }
}

function saveDB(data) {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DB);
}

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────
const auth = (req, res, next) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
};

// ─────────────────────────────────────────
// RATE LIMITER SIMPLE
// ─────────────────────────────────────────
const attempts = new Map();
function checkLogin(ip) {
    const now = Date.now();
    const data = attempts.get(ip) || { count: 0, time: now };
    if (now - data.time > 15 * 60 * 1000) {
        attempts.set(ip, { count: 1, time: now });
        return true;
    }
    data.count++;
    attempts.set(ip, data);
    return data.count <= 10; // Un poco más de margen
}

// ─────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────
app.use(express.static(PUBLIC));

// ─────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────
app.get('/api/session', (req, res) => {
    res.json({ logged: !!(req.session && req.session.user), user: req.session ? req.session.user : null });
});

app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (!checkLogin(ip)) return res.status(429).json({ error: 'Demasiados intentos' });

    const { user, password } = req.body;

    if (user === process.env.APP_USER && password === process.env.APP_PASSWORD) {
        req.session.user = user;
        // Forzamos el guardado de la sesión antes de responder
        return req.session.save((err) => {
            if (err) return res.status(500).json({ error: 'Error de sesión' });
            res.json({ success: true });
        });
    }

    res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/files', auth, (req, res) => {
    res.json(getDB());
});

app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const tmpPath = req.file.path;
    try {
        const msg = await bot.api.sendDocument(
            process.env.CHAT_ID,
            new InputFile(tmpPath, req.file.originalname)
        );
        const db = getDB();
        const entry = {
            id: Date.now(),
            nombre: req.file.originalname,
            carpeta: (req.body.carpeta || 'General').trim(),
            file_id: msg.document.file_id,
            tipo: req.file.mimetype,
            size: req.file.size,
            fecha: new Date().toISOString()
        };
        db.push(entry);
        saveDB(db);
        res.json({ success: true, entry });
    } catch (e) {
        log('ERROR', 'Upload failed', e.message);
        res.status(500).json({ error: 'Error subiendo archivo' });
    } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
});

app.delete('/api/file/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    let db = getDB();
    db = db.filter(f => f.id !== id);
    saveDB(db);
    res.json({ success: true });
});

// FALLBACK
app.use((req, res) => {
    res.sendFile(path.join(PUBLIC, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log('INFO', `CloudGram PRO running on port ${PORT}`);
});
