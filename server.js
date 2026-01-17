require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- STORAGE SETUP (Using Files for Simplicity) ---
// Note: On free cloud hosting, these reset daily. 
// For permanent storage, you would eventually need a Database.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'database.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, chats: {}, clips: [] }));

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Limit increased for video data
app.use(express.static(__dirname)); // Serves index.html
app.use('/uploads', express.static(UPLOAD_DIR)); // Serves video files

// --- AI CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const ANALYST_PROMPT = `
You are an expert Football Coach. Analyze this clip for a Scouting Report.
CRITICAL: Output ONLY valid JSON. No markdown. No talking.

JSON FORMAT:
{
  "title": "Play Concept Name",
  "formation": "e.g. Gun Trips Open",
  "coverage": "e.g. Cover 3 Match",
  "summary": "2-sentence summary of the play.",
  "tendency": "What does this tell us about their strategy?",
  "weakness": "How do we beat this?"
}
`;

// --- HELPER FUNCTIONS ---
function getDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { return { users: {}, chats: {}, clips: [] }; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- ROUTES ---

// 1. Serve the Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Authentication
app.post('/api/auth', (req, res) => {
    const { email, password, type } = req.body;
    const db = getDB();

    if (type === 'signup') {
        if (db.users[email]) return res.json({ success: false, error: "User exists" });
        db.users[email] = { password, credits: 10 };
        saveDB(db);
        return res.json({ success: true, credits: 10 });
    } else {
        if (!db.users[email] || db.users[email].password !== password) {
            return res.json({ success: false, error: "Invalid credentials" });
        }
        return res.json({ success: true, credits: db.users[email].credits });
    }
});

// 3. Get User Data (Sessions & Balance)
app.get('/api/user-data', (req, res) => {
    const { email } = req.query;
    const db = getDB();
    const userChats = Object.entries(db.chats)
        .filter(([_, chat]) => chat.owner === email)
        .map(([id, chat]) => ({ id, title: chat.title }));
    
    res.json({ 
        credits: db.users[email]?.credits || 0,
        sessions: userChats.reverse() 
    });
});

// 4. Chat & Analysis
app.post('/api/chat', async (req, res) => {
    try {
        const { email, message, sessionId, fileData, mimeType } = req.body;
        const db = getDB();

        // Check Credits
        if (fileData && db.users[email].credits <= 0) {
            return res.json({ error: "No credits remaining." });
        }

        // Initialize Session if needed
        if (!db.chats[sessionId]) {
            db.chats[sessionId] = { owner: email, title: "New Analysis", history: [] };
        }
        
        // Add User Message
        db.chats[sessionId].history.push({ role: "user", parts: [{ text: message }] });

        // Prepare AI Request
        let promptParts = [{ text: message }];
        let savedFileName = null;

        if (fileData) {
            // Deduct Credit
            db.users[email].credits--;
            
            // Save File
            const ext = mimeType.split('/')[1];
            savedFileName = `clip-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, savedFileName), Buffer.from(fileData, 'base64'));
            
            // Add Video to AI Prompt
            promptParts = [
                { inlineData: { mimeType, data: fileData } },
                { text: ANALYST_PROMPT }
            ];
        }

        // Call Gemini
        const chatSession = model.startChat({
            history: db.chats[sessionId].history.slice(0, -1) // Send previous context
        });
        const result = await chatSession.sendMessage(promptParts);
        const responseText = result.response.text();

        // Save AI Response
        db.chats[sessionId].history.push({ role: "model", parts: [{ text: responseText }] });
        
        // Update Title if it's new
        if (db.chats[sessionId].title === "New Analysis") {
            db.chats[sessionId].title = message.substring(0, 25);
        }

        // Parse JSON if video was analyzed
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
        res.status(500).json({ error: "Analysis failed. Try again." });
    }
});

// 5. Get Session History
app.get('/api/history', (req, res) => {
    const db = getDB();
    res.json(db.chats[req.query.sessionId]?.history || []);
});

// 6. Get Library (Search)
app.get('/api/library', (req, res) => {
    const { email, sessionId } = req.query;
    const db = getDB();
    const clips = db.clips.filter(c => c.owner === email && c.sessionId === sessionId);
    res.json(clips);
});

app.listen(port, () => console.log(`Sideline Pro running on port ${port}`));
