require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
// CRITICAL: Render sets the PORT automatically. We must use it.
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'database.json');

// Ensure storage exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, chats: {}, clips: [] }));
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); 
app.use('/uploads', express.static(UPLOAD_DIR));

// --- AI CONFIGURATION (PRO TIER) ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// *** UPGRADE: Using "gemini-1.5-pro" (The most powerful model currently available) ***
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

const ANALYST_PROMPT = `
You are an expert Football Coordinator (Bill Belichick style). Analyze this clip for a Scouting Report.
CRITICAL: Output ONLY valid JSON. No markdown. No conversational text.

JSON FORMAT:
{
  "title": "Concept Name (e.g. Duo, Mesh, Cover 3)",
  "formation": "Offensive Formation",
  "coverage": "Defensive Shell",
  "summary": "Detailed technical breakdown of the play.",
  "tendency": "What does this tell us about their gameplan?",
  "weakness": "How do we exploit this?"
}
`;

// --- DATABASE HELPERS ---
function getDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { return { users: {}, chats: {}, clips: [] }; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Auth Route
app.post('/api/auth', (req, res) => {
    const { email, password, type } = req.body;
    const db = getDB();

    if (type === 'signup') {
        if (db.users[email]) return res.json({ success: false, error: "User exists" });
        db.users[email] = { password, credits: 50 }; // Pro Plan: 50 Credits
        saveDB(db);
        return res.json({ success: true, credits: 50 });
    } else {
        if (!db.users[email] || db.users[email].password !== password) {
            return res.json({ success: false, error: "Invalid credentials" });
        }
        return res.json({ success: true, credits: db.users[email].credits });
    }
});

// 2. User Data
app.get('/api/user-data', (req, res) => {
    const { email } = req.query;
    const db = getDB();
    if (!db.users[email]) return res.json({ credits: 0, sessions: [] });
    
    const userChats = Object.entries(db.chats)
        .filter(([_, chat]) => chat.owner === email)
        .map(([id, chat]) => ({ id, title: chat.title }));
    
    res.json({ 
        credits: db.users[email].credits,
        sessions: userChats.reverse() 
    });
});

// 3. Chat & Analysis
app.post('/api/chat', async (req, res) => {
    try {
        const { email, message, sessionId, fileData, mimeType } = req.body;
        const db = getDB();

        if (!db.users[email]) return res.json({ error: "Please login again." });

        // Initialize Session
        if (!db.chats[sessionId]) {
            db.chats[sessionId] = { owner: email, title: "New Analysis", history: [] };
        }
        
        db.chats[sessionId].history.push({ role: "user", parts: [{ text: message }] });

        let promptParts = [{ text: message }];
        let savedFileName = null;

        if (fileData) {
            // Deduct Credit
            if (db.users[email].credits > 0) db.users[email].credits--;
            
            const ext = mimeType.split('/')[1];
            savedFileName = `clip-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, savedFileName), Buffer.from(fileData, 'base64'));
            
            promptParts = [
                { inlineData: { mimeType, data: fileData } },
                { text: ANALYST_PROMPT }
            ];
        }

        // Call Gemini 1.5 Pro
        const chatSession = model.startChat({
            history: db.chats[sessionId].history.slice(0, -1)
        });
        const result = await chatSession.sendMessage(promptParts);
        const responseText = result.response.text();

        db.chats[sessionId].history.push({ role: "model", parts: [{ text: responseText }] });
        
        if (db.chats[sessionId].title === "New Analysis") {
            db.chats[sessionId].title = message.substring(0, 25);
        }

        // Parse Analysis
        let analysisData = null;
        if (savedFileName) {
            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    analysisData = JSON.parse(jsonMatch[0]);
                    db.clips.push({
                        id: savedFileName,
                        owner: email,
                        sessionId: sessionId,
                        ...analysisData
                    });
                }
            } catch (e) { console.log("JSON Parse Error (AI output wasn't pure JSON)"); }
        }

        saveDB(db);
        res.json({ reply: responseText, analysis: analysisData, credits: db.users[email].credits });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "AI Error: Ensure your API Key supports Gemini 1.5 Pro." });
    }
});

// 4. History & Library
app.get('/api/history', (req, res) => {
    const db = getDB();
    res.json(db.chats[req.query.sessionId]?.history || []);
});

app.get('/api/library', (req, res) => {
    const { email, sessionId } = req.query;
    const db = getDB();
    const clips = db.clips.filter(c => c.owner === email && c.sessionId === sessionId);
    res.json(clips);
});

app.listen(port, () => console.log(`Sideline Pro running on port ${port}`));
