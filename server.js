require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
// CRITICAL: Use the port Render assigns, or 3000 for local testing
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const UPLOAD_DIR = path.join(__dirname, 'saved_plays');
const DB_FILE = path.join(__dirname, 'stats_db.json');
const USER_DB_FILE = path.join(__dirname, 'users_db.json');
const CHATS_FILE = path.join(__dirname, 'chats_db.json');

// --- FILE SYSTEM SETUP ---
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function initJSON(filePath, defaultContent) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent);
}
initJSON(DB_FILE, '[]');
initJSON(USER_DB_FILE, '{}');
initJSON(CHATS_FILE, '{}');

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// --- SERVE WEBSITE FILES ---
app.use(express.static(__dirname));
app.use('/plays', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// USING FLASH MODEL (Most reliable for free tier)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const ANALYST_PROMPT = `
You are an expert Football Coordinator. Analyze this clip for a Scouting Report.
CRITICAL INSTRUCTION: Output ONLY valid JSON. Do not speak. Do not add markdown like \`\`\`json. Just the raw JSON object.

JSON STRUCTURE:
{
  "title": "Play Name",
  "data": {
    "down_distance": "e.g. 3rd & 5",
    "hash": "Left/Right/Middle",
    "personnel": "e.g. 11 Pers",
    "formation": "e.g. Gun Empty",
    "play_type": "Run/Pass",
    "coverage": "e.g. Cover 3"
  },
  "scouting_report": {
    "tells": "Physical tells (e.g. RG leans back)",
    "tendency": "Predictive tendency",
    "weakness": "Exploitable match"
  },
  "grading": {
    "assignment": "Pass/Fail",
    "technique": "Technique notes",
    "effort": "Effort notes"
  },
  "section": "General"
}
`;

// --- DB HELPERS ---
function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}
function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- API ROUTES ---

app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    const db = readJSON(USER_DB_FILE);
    if (db[email]) return res.json({ error: "User exists" });
    db[email] = { password, credits: 5, userId: "user_" + Date.now() };
    writeJSON(USER_DB_FILE, db);
    res.json({ success: true, credits: 5 });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const db = readJSON(USER_DB_FILE);
    if (!db[email] || db[email].password !== password) return res.json({ error: "Invalid login" });
    res.json({ success: true, credits: db[email].credits });
});

app.post('/api/balance', (req, res) => {
    const db = readJSON(USER_DB_FILE);
    res.json({ credits: db[req.body.email]?.credits || 0 });
});

app.get('/api/sessions', (req, res) => {
    const { email } = req.query;
    const chats = readJSON(CHATS_FILE);
    const userChats = Object.entries(chats)
        .filter(([id, chat]) => chat.owner === email)
        .map(([id, chat]) => ({ id, title: chat.title, date: chat.timestamp }));
    res.json(userChats.reverse());
});

app.get('/api/session/:id', (req, res) => {
    const chats = readJSON(CHATS_FILE);
    res.json(chats[req.params.id]?.history || []);
});

app.post('/api/rename-session', (req, res) => {
    const { sessionId, newTitle, email } = req.body;
    const chats = readJSON(CHATS_FILE);
    if (chats[sessionId] && chats[sessionId].owner === email) {
        chats[sessionId].title = newTitle;
        writeJSON(CHATS_FILE, chats);
        res.json({ success: true });
    } else {
        res.json({ error: "Session not found" });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, sessionId, fileData, mimeType, email } = req.body;
        const users = readJSON(USER_DB_FILE);
        const chats = readJSON(CHATS_FILE);

        const cost = fileData ? 1 : 0;
        if (users[email].credits < cost) return res.json({ error: "payment_required" });
        if (cost > 0) {
            users[email].credits -= cost;
            writeJSON(USER_DB_FILE, users);
        }

        if (!chats[sessionId]) {
            chats[sessionId] = { 
                owner: email, 
                title: message.substring(0, 30) || "New Analysis", 
                timestamp: Date.now(), 
                history: [] 
            };
        }

        chats[sessionId].history.push({ role: 'user', text: message });
        
        const historyForAI = chats[sessionId].history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text }]
        }));

        const chat = model.startChat({ history: historyForAI.slice(0, -1) });
        const parts = [];
        let savedFilename = null;

        if (fileData) {
            const buffer = Buffer.from(fileData, 'base64');
            const ext = mimeType.split('/')[1];
            savedFilename = `${sessionId}-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, savedFilename), buffer);
            parts.push({ inlineData: { mimeType, data: fileData } });
            parts.push({ text: ANALYST_PROMPT });
        }
        parts.push({ text: message });

        const result = await chat.sendMessage(parts);
        const reply = result.response.text();

        chats[sessionId].history.push({ role: 'model', text: reply });
        if (chats[sessionId].history.length <= 2) chats[sessionId].title = message.substring(0, 30);
        writeJSON(CHATS_FILE, chats);

        let newClip = null;
        
        const firstBrace = reply.indexOf('{');
        const lastBrace = reply.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && savedFilename) {
            try {
                const jsonString = reply.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(jsonString);
                
                newClip = {
                    id: savedFilename,
                    owner: email,
                    title: parsed.title || "Analyzed Play",
                    formation: parsed.data?.formation || "Unknown",
                    concept: parsed.title || "Unknown",
                    coverage: parsed.data?.coverage || "Unknown",
                    section: parsed.section || "Uncategorized",
                    fullData: parsed 
                };
                
                const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
                library.push(newClip);
                fs.writeFileSync(DB_FILE, JSON.stringify(library));
            } catch(e) { console.log("JSON Parse Failed"); }
        }

        res.json({ reply, newClip, remainingCredits: users[email].credits });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "AI Error" });
    }
});

app.post('/api/update-clip', (req, res) => {
    const { id, section, owner } = req.body;
    let library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const clipIndex = library.findIndex(p => p.id === id && p.owner === owner);
    if (clipIndex > -1) {
        library[clipIndex].section = section;
        fs.writeFileSync(DB_FILE, JSON.stringify(library));
        res.json({ success: true });
    } else { res.json({ error: "Clip not found" }); }
});

app.post('/api/delete-clip', (req, res) => {
    const { id, owner } = req.body;
    let library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const libraryLen = library.length;
    library = library.filter(p => !(p.id === id && p.owner === owner));

    if (library.length < libraryLen) {
        fs.writeFileSync(DB_FILE, JSON.stringify(library, null, 2));
        try {
            const filePath = path.join(UPLOAD_DIR, id);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {}
        res.json({ success: true });
    } else { res.json({ error: "Clip not found" }); }
});

app.get('/api/search', (req, res) => {
    const { email, q, sessionId } = req.query;
    const term = q ? q.toLowerCase() : "";
    const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const results = library.filter(p => 
        p.owner === email && 
        (!sessionId || p.sessionId === sessionId) &&
        (!term || (p.title && p.title.toLowerCase().includes(term)))
    );
    res.json(results);
});

app.get('/api/stats', (req, res) => {
    const { email, sessionId } = req.query;
    const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const userPlays = library.filter(p => p.owner === email);
    if (userPlays.length === 0) return res.json({ empty: true });
    
    const count = (field) => {
        const counts = {};
        userPlays.forEach(p => {
            const val = p[field] || 'Unknown';
            counts[val] = (counts[val] || 0) + 1;
        });
        return counts;
    };
    res.json({
        total: userPlays.length,
        formation: count('formation'),
        coverage: count('coverage'),
        concept: count('concept')
    });
});

app.listen(port, () => console.log(`Sideline Pro running on port ${port}`));
