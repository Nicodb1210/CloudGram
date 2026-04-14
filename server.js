require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const helmet   = require('helmet');
const { Bot, InputFile } = require('grammy');

const REQUIRED = ['TELEGRAM_TOKEN', 'CHAT_ID', 'APP_USER', 'APP_PASSWORD', 'SESSION_SECRET'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`❌ Faltan env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// SEGURIDAD REFORZADA PERO PERMISIVA
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
        "connect-src": ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// SESIÓN
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

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const DB = path.join(__dirname, 'db.json');
const UPLOADS = path.join(__dirname, 'uploads');
const PUBLIC = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PUBLIC))  fs.mkdirSync(PUBLIC, { recursive: true });

const upload = multer({ dest: UPLOADS });

function getDB() {
    try { return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf-8')) : []; }
    catch (e) { return []; }
}
function saveDB(data) {
    fs.writeFileSync(DB, JSON.stringify(data, null, 2));
}

const auth = (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'No autorizado' });
};

// --- API ---

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

// RUTA DE SUBIDA CORREGIDA
app.post('/api/upload', auth, upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    try {
        const msg = await bot.api.sendDocument(process.env.CHAT_ID, new InputFile(req.file.path, req.file.originalname));
        if (!msg || !msg.document) throw new Error('Telegram no devolvió documento');
        const db = getDB();
        const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
        
        db.push({
            id: Date.now(),
            nombre: req.file.originalname,
            carpeta: (req.body.carpeta || 'General').trim() || 'General',
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
    }
    finally { 
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

// NUEVA RUTA: BORRAR ARCHIVO
app.delete('/api/delete/:id', auth, (req, res) => {
    let db = getDB();
    db = db.filter(f => f.id != req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// NUEVA RUTA: DESCARGAR ARCHIVO
app.get('/api/download/:file_id', auth, async (req, res) => {
    try {
        const file = await bot.api.getFile(req.params.file_id);
        const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
        res.json({ url });
    } catch (e) { res.status(500).json({ error: 'No se pudo obtener el link' }); }
});

// NUEVA RUTA: VISTA PREVIA
app.get('/api/preview/:file_id', auth, async (req, res) => {
    try {
        const file = await bot.api.getFile(req.params.file_id);
        res.redirect(`https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`);
    } catch (e) { res.status(404).send('No disponible'); }
});

// ... el resto del código arriba igual ...

// STATIC & FALLBACK
app.use(express.static(PUBLIC));

app.use((req, res) => {
    const indexFile = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
    } else {
        res.status(404).send('Not found');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
