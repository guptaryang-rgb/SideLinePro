require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'database.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, chats: {}, clips: [], clip_chats: {} }));
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); 
app.use('/uploads', express.static(UPLOAD_DIR));

// --- AI CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// *** MODEL SET TO GEMINI 3 PRO PREVIEW ***
const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

const ANALYST_PROMPT = `
You are an expert Football Coordinator. Analyze this clip for a detailed Scouting Report.
CRITICAL: Output ONLY valid JSON. No markdown.

JSON FORMAT:
{
  "title": "Concept Name (e.g. Duo, Mesh, Cover 3)",
  "formation": "Offensive Formation",
  "coverage": "Defensive Shell",
  "summary": "Technical breakdown of the play.",
  "mistakes": ["List exactly which players failed and how (e.g. 'CB1 bad leverage', 'LB filled wrong gap')"],
  "weakness": "The structural flaw exposed here.",
  "action_plan": "Step-by-step gameplan to exploit this weakness next time (e.g. '1. Motion to empty. 2. Isolate the MIKE LB.')."
}
`;

// --- DB HELPERS ---
function getDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { return { users: {}, chats: {}, clips: [], clip_chats: {} }; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Auth (3 Credits)
app.post('/api/auth', (req, res) => {
    const { email, password, type } = req.body;
    const db = getDB();

    if (type === 'signup') {
        if (db.users[email]) return res.json({ success: false, error: "User exists" });
        // *** 3 FREE CREDITS ***
        db.users[email] = { password, credits: 3 }; 
        saveDB(db);
        return res.json({ success: true, credits: 3 });
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

// 3. Main Chat & Analysis
app.post('/api/chat', async (req, res) => {
    try {
        const { email, message, sessionId, fileData, mimeType } = req.body;
        const db = getDB();

        if (!db.users[email]) return res.json({ error: "Please login again." });

        if (!db.chats[sessionId]) {
            db.chats[sessionId] = { owner: email, title: "New Analysis", history: [] };
        }
        
        db.chats[sessionId].history.push({ role: "user", parts: [{ text: message }] });

        let promptParts = [{ text: message }];
        let savedFileName = null;

        if (fileData) {
            if (db.users[email].credits > 0) db.users[email].credits--;
            
            const ext = mimeType.split('/')[1];
            savedFileName = `clip-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, savedFileName), Buffer.from(fileData, 'base64'));
            
            promptParts = [
                { inlineData: { mimeType, data: fileData } },
                { text: ANALYST_PROMPT }
            ];
        }

        const chatSession = model.startChat({
            history: db.chats[sessionId].history.slice(0, -1)
        });
        const result = await chatSession.sendMessage(promptParts);
        const responseText = result.response.text();

        db.chats[sessionId].history.push({ role: "model", parts: [{ text: responseText }] });
        
        if (db.chats[sessionId].title === "New Analysis") {
            db.chats[sessionId].title = message.substring(0, 25);
        }

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
            } catch (e) { console.log("JSON Parse Error"); }
        }

        saveDB(db);
        res.json({ reply: responseText, analysis: analysisData, credits: db.users[email].credits });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "AI Error: Ensure your API key has access to gemini-3-pro-preview." });
    }
});

// 4. Clip Chat (War Room)
app.post('/api/clip-chat', async (req, res) => {
    try {
        const { clipId, message, context } = req.body;
        const db = getDB();

        if (!db.clip_chats) db.clip_chats = {};
        if (!db.clip_chats[clipId]) {
            db.clip_chats[clipId] = [
                { role: "user", parts: [{ text: `System: User is analyzing this play data: ${JSON.stringify(context)}` }] },
                { role: "model", parts: [{ text: "Understood. Ready for specific questions." }] }
            ];
        }

        db.clip_chats[clipId].push({ role: "user", parts: [{ text: message }] });

        const chatSession = model.startChat({ history: db.clip_chats[clipId] });
        const result = await chatSession.sendMessage(message);
        const responseText = result.response.text();

        db.clip_chats[clipId].push({ role: "model", parts: [{ text: responseText }] });
        saveDB(db);

        res.json({ reply: responseText });
    } catch (e) {
        res.status(500).json({ error: "Chat failed." });
    }
});

app.get('/api/clip-history', (req, res) => {
    const db = getDB();
    const history = db.clip_chats?.[req.query.clipId] || [];
    res.json(history.slice(2)); // Skip system prompt
});

// 5. Session Report
app.post('/api/session-report', async (req, res) => {
    const { sessionId, email } = req.body;
    const db = getDB();
    const clips = db.clips.filter(c => c.owner === email && c.sessionId === sessionId);
    
    if (clips.length === 0) return res.json({ report: "No clips to analyze." });

    const summaryPrompt = `
    Analyze these ${clips.length} plays as a full game session. 
    Plays: ${JSON.stringify(clips)}
    Generate a concise "Coordinator's Summary" identifying the opponent's main tendencies and how to beat them.
    `;

    const result = await model.generateContent(summaryPrompt);
    res.json({ report: result.response.text() });
});

// 6. Utils
app.post('/api/rename-session', (req, res) => {
    const { sessionId, newTitle, email } = req.body;
    const db = getDB();
    if (db.chats[sessionId] && db.chats[sessionId].owner === email) {
        db.chats[sessionId].title = newTitle;
        saveDB(db);
        res.json({ success: true });
    } else {
        res.json({ error: "Session not found" });
    }
});

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
