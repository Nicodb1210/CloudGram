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

// SEGURIDAD
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

// EL MIDDLEWARE (SOLO UNA VEZ)
const auth = (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'No autorizado' });
};

// API
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
    if (!req.file) return res.status(400).send('No file');
    try {
        const msg = await bot.api.sendDocument(process.env.CHAT_ID, new InputFile(req.file.path, req.file.originalname));
        const db = getDB();
        db.push({
            id: Date.now(),
            nombre: req.file.originalname,
            carpeta: (req.body.carpeta || 'General'),
            file_id: msg.document.file_id,
            size: req.file.size,
            fecha: new Date().toISOString()
        });
        saveDB(db);
        res.json({ success: true });
    } catch (e) { res.status(500).send('Error'); }
    finally { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
});

// STATIC & FALLBACK
app.use(express.static(PUBLIC));
app.use((req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
