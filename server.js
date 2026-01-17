require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager, FileState } = require('@google/generative-ai/server');
const fs = require('fs').promises; 
const fsSync = require('fs'); 
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_football_key"; 

const UPLOAD_DIR = path.join(__dirname, 'saved_plays');
const DB_FILE = path.join(__dirname, 'stats_db.json');
const USER_DB_FILE = path.join(__dirname, 'users_db.json');
const CHATS_FILE = path.join(__dirname, 'chats_db.json');

if (!fsSync.existsSync(UPLOAD_DIR)) fsSync.mkdirSync(UPLOAD_DIR);
const initJSON = (file) => { if (!fsSync.existsSync(file)) fsSync.writeFileSync(file, JSON.stringify(file.includes('db.json') ? [] : {})); };
initJSON(DB_FILE); initJSON(USER_DB_FILE); initJSON(CHATS_FILE);

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use('/plays', express.static(UPLOAD_DIR));
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

// --- PROMPTS ---
const TEAM_PROMPT = `
You are an expert Football Coordinator. Analyze this clip for a Scouting Report.
CRITICAL: Output ONLY valid JSON.

JSON STRUCTURE:
{
  "title": "Concept Name",
  "data": { "formation": "Offense", "coverage": "Defense", "play_type": "Run/Pass" },
  "scouting_report": {
    "summary": "Technical summary.",
    "mistakes": ["Player errors"],
    "weakness": "Structural weakness",
    "action_plan": "Exploit plan"
  },
  "section": "General"
}
`;

const PLAYER_PROMPT = `
You are an elite private Position Coach. 1-on-1 session.
1. Identify focus player. 2. Roast technique. 3. Prescribe workout.
CRITICAL: Output ONLY valid JSON.

JSON STRUCTURE:
{
  "title": "Player Grade",
  "data": { "formation": "Alignment", "coverage": "Role", "play_type": "Focus" },
  "scouting_report": {
    "summary": "Direct feedback.",
    "mistakes": ["Mechanical flaws"],
    "weakness": "Scouting knock",
    "action_plan": "SPECIFIC DRILL & WORKOUT."
  },
  "section": "Individual"
}
`;

async function readJSON(file) {
    try { const data = await fs.readFile(file, 'utf8'); return JSON.parse(data); } 
    catch (e) { return file.includes('users') || file.includes('chats') ? {} : []; }
}
async function writeJSON(file, data) {
    const tempFile = `${file}.tmp`; await fs.writeFile(tempFile, JSON.stringify(data, null, 2)); await fs.rename(tempFile, file);
}
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => { if (err) return res.sendStatus(403); req.user = user; next(); });
};

// --- AUTH ---
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    const db = await readJSON(USER_DB_FILE);
    if (db[email]) return res.json({ error: "User exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    db[email] = { password: hashedPassword, userId: "user_" + Date.now() };
    await writeJSON(USER_DB_FILE, db);
    const token = jwt.sign({ email }, JWT_SECRET);
    res.json({ success: true, token });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const db = await readJSON(USER_DB_FILE);
    const user = db[email];
    if (!user) return res.json({ error: "User not found" });
    if (await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ email }, JWT_SECRET);
        res.json({ success: true, token });
    } else { res.json({ error: "Invalid password" }); }
});

// --- SESSION HANDLING (The Left Sidebar Fix) ---
app.get('/api/sessions', authenticateToken, async (req, res) => {
    const chats = await readJSON(CHATS_FILE);
    const userChats = Object.entries(chats)
        .filter(([id, chat]) => chat.owner === req.user.email)
        .map(([id, chat]) => ({ id, title: chat.title, date: chat.timestamp, type: chat.type || 'team' }));
    res.json(userChats.reverse());
});

app.get('/api/session/:id', authenticateToken, async (req, res) => {
    const chats = await readJSON(CHATS_FILE);
    res.json({ history: chats[req.params.id]?.history || [], type: chats[req.params.id]?.type });
});

app.post('/api/rename-session', authenticateToken, async (req, res) => {
    const { sessionId, newTitle, type } = req.body;
    const chats = await readJSON(CHATS_FILE);
    
    // If session doesn't exist yet, create it fully so it appears in the sidebar
    if (!chats[sessionId]) {
        chats[sessionId] = { 
            owner: req.user.email, 
            title: newTitle, 
            timestamp: Date.now(), 
            history: [], // Empty history to start
            type: type || 'team' 
        };
    } else if (chats[sessionId].owner === req.user.email) {
        chats[sessionId].title = newTitle;
    }
    
    await writeJSON(CHATS_FILE, chats);
    res.json({ success: true });
});

// --- AI CHAT ---
app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        const { message, sessionId, fileData, mimeType, sessionType } = req.body;
        const email = req.user.email;
        const chats = await readJSON(CHATS_FILE);

        if (!chats[sessionId]) {
            chats[sessionId] = { owner: email, title: "New Analysis", timestamp: Date.now(), history: [], type: sessionType || 'team' };
        }

        const historyForAI = chats[sessionId].history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text }]
        }));

        chats[sessionId].history.push({ role: 'user', text: message });

        let promptContent = [{ text: message }];
        let savedFilename = null;
        const SYSTEM_PROMPT = (chats[sessionId].type === 'player') ? PLAYER_PROMPT : TEAM_PROMPT;

        if (fileData) {
            const buffer = Buffer.from(fileData, 'base64');
            const ext = mimeType.split('/')[1];
            savedFilename = `${sessionId}-${Date.now()}.${ext}`;
            const filePath = path.join(UPLOAD_DIR, savedFilename);
            await fs.writeFile(filePath, buffer);

            const uploadResponse = await fileManager.uploadFile(filePath, { mimeType: mimeType, displayName: savedFilename });
            
            let file = await fileManager.getFile(uploadResponse.file.name);
            while (file.state === FileState.PROCESSING) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                file = await fileManager.getFile(uploadResponse.file.name);
            }
            if (file.state === FileState.FAILED) throw new Error("Video processing failed.");

            promptContent = [{ fileData: { mimeType: uploadResponse.file.mimeType, fileUri: uploadResponse.file.uri } }, { text: SYSTEM_PROMPT }];
        }

        const chat = model.startChat({ history: historyForAI });
        const result = await chat.sendMessage(promptContent);
        const reply = result.response.text();

        chats[sessionId].history.push({ role: 'model', text: reply });
        await writeJSON(CHATS_FILE, chats);

        let newClip = null;
        const firstBrace = reply.indexOf('{');
        const lastBrace = reply.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && savedFilename) {
            try {
                const parsed = JSON.parse(reply.substring(firstBrace, lastBrace + 1));
                newClip = {
                    id: savedFilename,
                    owner: email,
                    sessionId: sessionId,
                    title: parsed.title,
                    formation: parsed.data?.formation,
                    coverage: parsed.data?.coverage,
                    section: (chats[sessionId].type === 'player') ? "My Reps" : "Team Film",
                    fullData: parsed 
                };
                const library = await readJSON(DB_FILE);
                library.push(newClip);
                await writeJSON(DB_FILE, library); 
            } catch(e) {}
        }
        res.json({ reply, newClip });
    } catch (e) { res.status(500).json({ error: "Analysis failed. " + e.message }); }
});

app.post('/api/update-clip', authenticateToken, async (req, res) => {
    const { id, section } = req.body;
    let library = await readJSON(DB_FILE);
    const index = library.findIndex(p => p.id === id && p.owner === req.user.email);
    if(index > -1) { library[index].section = section; await writeJSON(DB_FILE, library); res.json({ success: true }); } 
    else { res.json({ error: "Clip not found" }); }
});

// *** UPDATED: ASK MORE QUESTIONS (MEMORY FIX) ***
app.post('/api/clip-chat', authenticateToken, async (req, res) => {
    try {
        const { message, context } = req.body;
        
        // This Prompt forces the AI to use the JSON data instead of asking for the file again.
        const prompt = `
        SYSTEM INSTRUCTION: You are analyzing a football play.
        You have ALREADY watched the video. You do not need the video file again.
        
        Here is the technical data you extracted from the video:
        ${JSON.stringify(context)}
        
        USER QUESTION: "${message}"
        
        TASK: Answer the user's question specifically based on the data above. Be detailed.
        `;
        
        const result = await model.generateContent(prompt);
        res.json({ reply: result.response.text() });
    } catch(e) { res.status(500).json({ error: "Chat failed" }); }
});

app.post('/api/session-summary', authenticateToken, async (req, res) => {
    const { sessionId, focus } = req.body; 
    const library = await readJSON(DB_FILE);
    const clips = library.filter(p => p.owner === req.user.email && p.sessionId === sessionId);
    if (clips.length === 0) return res.json({ report: "No clips found in this session." });

    const summaryPrompt = `
    Based on the ${clips.length} plays in this session: ${JSON.stringify(clips)}
    Write a "Tendency Report" for **${focus.toUpperCase()}**.
    `;
    try {
        const result = await model.generateContent(summaryPrompt);
        res.json({ report: result.response.text() });
    } catch(e) { res.json({ report: "Could not generate summary." }); }
});

app.get('/api/search', authenticateToken, async (req, res) => {
    const { sessionId } = req.query; 
    const library = await readJSON(DB_FILE);
    const results = library.filter(p => p.owner === req.user.email && (!sessionId || p.sessionId === sessionId));
    res.json(results);
});

app.post('/api/delete-clip', authenticateToken, async (req, res) => {
    const { id } = req.body;
    let library = await readJSON(DB_FILE);
    const initialLength = library.length;
    library = library.filter(p => !(p.id === id && p.owner === req.user.email));
    if (library.length < initialLength) {
        await writeJSON(DB_FILE, library);
        try { await fs.unlink(path.join(UPLOAD_DIR, id)); } catch(e){}
        res.json({ success: true });
    } else { res.json({ error: "Clip not found" }); }
});

app.listen(port, () => console.log(`Sideline Pro Secure running at http://localhost:${port}`));
