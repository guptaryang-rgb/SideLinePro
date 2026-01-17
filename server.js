require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server'); // *** NEW IMPORT ***
const fs = require('fs');
const path = require('path');

// Initialize Stripe
let stripe;
try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch (e) {
    console.log("Stripe key missing - Payments will be in Demo Mode");
}

const app = express();
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
// 500MB Limit for raw upload to server before sending to Google
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.use('/plays', express.static(UPLOAD_DIR));
app.use(express.static(__dirname)); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY); // *** FILE MANAGER ***

// *** GEMINI 3 PRO PREVIEW ***
const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

const ANALYST_PROMPT = `
You are an expert Football Coordinator. Analyze this clip for a Scouting Report.
CRITICAL INSTRUCTION: Output ONLY valid JSON. Do not speak.

JSON STRUCTURE:
{
  "title": "Concept Name",
  "data": {
    "formation": "Offensive Formation",
    "coverage": "Defensive Coverage Shell",
    "play_type": "Run/Pass"
  },
  "scouting_report": {
    "summary": "Concise technical summary.",
    "mistakes": ["List specific player errors (e.g. 'CB1 bad leverage')"],
    "weakness": "Structural weakness exposed.",
    "action_plan": "Step-by-step plan to exploit this."
  }
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

// 1. Auth
app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    const db = readJSON(USER_DB_FILE);
    if (db[email]) return res.json({ error: "User exists" });
    db[email] = { password, credits: 3, userId: "user_" + Date.now() }; 
    writeJSON(USER_DB_FILE, db);
    res.json({ success: true, credits: 3 });
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

// 2. Stripe
app.post('/api/buy-credits', async (req, res) => {
    const { email } = req.body;
    if (stripe) {
        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: { name: '50 Scouting Credits' },
                        unit_amount: 1500,
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `https://your-site.com/success`, 
                cancel_url: 'https://your-site.com/cancel',
            });
            return res.json({ success: true, url: session.url });
        } catch (e) { console.log("Stripe Error:", e.message); }
    }
    const db = readJSON(USER_DB_FILE);
    if(db[email]) {
        db[email].credits += 50;
        writeJSON(USER_DB_FILE, db);
    }
    res.json({ success: true, message: "Credits added (Demo Mode)" });
});

// 3. Chat & Analysis
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
    } else { res.json({ error: "Session not found" }); }
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
                title: "New Analysis", 
                timestamp: Date.now(), 
                history: [] 
            };
        }

        chats[sessionId].history.push({ role: 'user', text: message });

        let promptContent = [{ text: message }];
        let savedFilename = null;

        if (fileData) {
            // 1. Save locally first
            const buffer = Buffer.from(fileData, 'base64');
            const ext = mimeType.split('/')[1];
            savedFilename = `${sessionId}-${Date.now()}.${ext}`;
            const filePath = path.join(UPLOAD_DIR, savedFilename);
            fs.writeFileSync(filePath, buffer);

            // 2. *** UPLOAD TO GOOGLE FILE MANAGER *** // This is the key fix for "File too large" errors
            const uploadResponse = await fileManager.uploadFile(filePath, {
                mimeType: mimeType,
                displayName: savedFilename,
            });

            // 3. Wait for file to be active (usually instant for small files)
            // In production, you might want to loop check getFile() state
            
            promptContent = [
                {
                    fileData: {
                        mimeType: uploadResponse.file.mimeType,
                        fileUri: uploadResponse.file.uri
                    }
                },
                { text: ANALYST_PROMPT }
            ];
        }

        const chat = model.startChat(); 
        const result = await chat.sendMessage(promptContent);
        const reply = result.response.text();

        chats[sessionId].history.push({ role: 'model', text: reply });
        if (chats[sessionId].title === "New Analysis" && chats[sessionId].history.length <= 2) {
            chats[sessionId].title = message.substring(0, 30);
        }
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
                    sessionId: sessionId,
                    title: parsed.title || "Analyzed Play",
                    formation: parsed.data?.formation || "Unknown",
                    coverage: parsed.data?.coverage || "Unknown",
                    fullData: parsed 
                };
                
                const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
                library.push(newClip);
                fs.writeFileSync(DB_FILE, JSON.stringify(library));
            } catch(e) { console.log("JSON Parse Failed", e); }
        }

        res.json({ reply, newClip, remainingCredits: users[email].credits });

    } catch (e) {
        console.error("AI ERROR:", e);
        res.status(500).json({ error: "Analysis failed. Please try again." });
    }
});

// 4. Session Summary
app.post('/api/session-summary', async (req, res) => {
    const { sessionId, email } = req.body;
    const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const clips = library.filter(p => p.owner === email && p.sessionId === sessionId);
    if (clips.length === 0) return res.json({ report: "No clips found in this session." });

    const summaryPrompt = `Coordinator Session Report for: ${JSON.stringify(clips)}. Tendencies & Gameplan?`;
    try {
        const result = await model.generateContent(summaryPrompt);
        res.json({ report: result.response.text() });
    } catch(e) { res.json({ report: "Could not generate summary." }); }
});

// 5. Library & Delete
app.get('/api/search', (req, res) => {
    const { email, sessionId } = req.query; 
    const library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const results = library.filter(p => p.owner === email && (!sessionId || p.sessionId === sessionId));
    res.json(results);
});

app.post('/api/delete-clip', (req, res) => {
    const { id, owner } = req.body;
    let library = JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '[]');
    const initialLength = library.length;
    library = library.filter(p => !(p.id === id && p.owner === owner));
    if (library.length < initialLength) {
        fs.writeFileSync(DB_FILE, JSON.stringify(library, null, 2));
        res.json({ success: true });
    } else { res.json({ error: "Clip not found" }); }
});

app.listen(port, () => console.log(`Sideline Pro running at http://localhost:${port}`));
