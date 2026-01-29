require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");

const { ClerkExpressWithAuth } = require("@clerk/clerk-sdk-node");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager, FileState } = require("@google/generative-ai/server");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;

// Increased limit for Full Game Footage
app.use(cors());
app.use(express.json({ limit: "500mb" })); 
app.use(ClerkExpressWithAuth());
app.use(express.static(__dirname));

const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');
fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(console.error);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Vantage Vision DB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// *** TANK STRATEGY ***
const MODEL_FALLBACK_LIST = [
    "gemini-2.5-pro", "gemini-1.5-pro", "gemini-1.5-pro-002", "gemini-1.5-flash"
];

async function generateWithFallback(promptParts) {
    let lastError = null;
    for (const modelName of MODEL_FALLBACK_LIST) {
        try {
            console.log(`🤖 Analyzing with ${modelName}...`);
            const model = genAI.getGenerativeModel({ 
                model: modelName,
                generationConfig: { temperature: 0.0, topP: 0.95, topK: 40, responseMimeType: "application/json" }
            });
            const result = await model.generateContent({ contents: [{ role: "user", parts: promptParts }] });
            console.log(`✅ Success with ${modelName}`);
            return result; 
        } catch (error) {
            console.warn(`⚠️ ${modelName} failed. Switching...`);
            lastError = error;
            if (!error.message.includes("404") && !error.message.includes("not found")) {}
        }
    }
    throw new Error(`Analysis failed. Last error: ${lastError.message}`);
}

/* ---------------- UPDATED RUBRICS ---------------- */
const RUBRICS = {
    "team": `
    ELITE COORDINATOR DIAGNOSTICS:
    1. SITUATION: Down, Distance, Field Position, Personnel.
    2. SCHEME: Identify Concept (Mesh, Dagger, Duo, Inside Zone) vs Coverage.
    3. THE 'WHY': Point of Attack win/loss? Conflict player decision?
    4. TENDENCY: Does this align with previous plays? (Pass heavy in 11 personnel?)`,
    
    "qb": "BIOMECHANICS: Base Width, Hip Sequencing, Eye Discipline.",
    "rb": "BIOMECHANICS: Pad Level, Vision/Cuts, Pass Pro scanning.",
    "wr": "BIOMECHANICS: Release vs Press, Stem & Stack, Break point efficiency.",
    "te": "BIOMECHANICS: In-line blocking leverage, Route finding in zone.",
    "ol": "BIOMECHANICS: First Step, Hand Punch, Anchor.",
    "dl": "BIOMECHANICS: Get-off, Hand fighting, Gap integrity.",
    "lb": "BIOMECHANICS: Read step, Trigger speed, Block shedding.",
    "cb": "BIOMECHANICS: Press technique, Hip fluidity, Phase maintenance.",
    "s": "BIOMECHANICS: Range, Run fit alleys, Disguise.",
    "kp": "BIOMECHANICS: Approach, Plant foot, Leg swing.",
    "general": "GENERAL MECHANICS: Stance, Effort, Execution."
};

/* ---------------- MODELS ---------------- */
const PlayerProfileSchema = new mongoose.Schema({
    identifier: String, position: String, grade: String, notes: [String], weaknesses: [String], last_updated: { type: Date, default: Date.now }
});

const Session = mongoose.model("Session", new mongoose.Schema({
  sessionId: String, owner: String, title: String, type: { type: String, default: "team" }, sport: String,
  history: [{ role: String, text: String }],
  roster: [PlayerProfileSchema] 
}));

const Clip = mongoose.model("Clip", new mongoose.Schema({
  owner: String, sessionId: String, sport: String, title: String, formation: String,
  o_formation: String, d_formation: String, section: { type: String, default: "Inbox" },
  videoUrl: String, geminiFileUri: String, fullData: Object,
  chatHistory: [{ role: String, text: String }], snapshots: [String],
  createdAt: { type: Date, default: Date.now }
}));

const requireAuth = (req, res, next) => {
  if (!req.auth?.userId) return res.status(401).json({ error: "Unauthorized" });
  next();
};

/* ---------------- ROUTES ---------------- */
app.get("/", (_, res) => { res.sendFile(path.join(__dirname, "index.html")); });
app.get("/privacy.html", (_, res) => { res.sendFile(path.join(__dirname, "privacy.html")); });
app.get("/terms.html", (_, res) => { res.sendFile(path.join(__dirname, "terms.html")); });

app.post("/api/create-session", requireAuth, async (req, res) => {
  try {
    const session = await Session.create({
      sessionId: "sess_" + Date.now(), owner: req.auth.userId, title: req.body.title || "New Session",
      type: req.body.type || "team", sport: "football", history: [], roster: []
    });
    res.json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    const query = { owner: req.auth.userId };
    if (req.query.type) query.type = req.query.type; 
    const sessions = await Session.find(query).sort({ _id: -1 });
    res.json(sessions.map(s => ({ id: s.sessionId, title: s.title, type: s.type })));
  } catch (e) { res.json([]); }
});

app.get("/api/session/:id", requireAuth, async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id, owner: req.auth.userId });
    res.json({ history: session?.history || [], roster: session?.roster || [] });
  } catch (e) { res.json({ history: [], roster: [] }); }
});

app.post("/api/delete-session", requireAuth, async (req, res) => {
  try {
    await Session.deleteOne({ sessionId: req.body.sessionId, owner: req.auth.userId });
    await Clip.deleteMany({ sessionId: req.body.sessionId, owner: req.auth.userId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Delete failed" }); }
});

app.get("/api/search", requireAuth, async (req, res) => {
  try {
    if (!req.query.sessionId) return res.json([]);
    const query = { owner: req.auth.userId, sessionId: req.query.sessionId };
    const clips = await Clip.find(query).sort({ section: 1, createdAt: -1 });
    res.json(clips);
  } catch (e) { res.json([]); }
});

app.post("/api/update-clip", requireAuth, async (req, res) => {
  try {
    await Clip.findOneAndUpdate({ _id: req.body.id, owner: req.auth.userId }, { $set: { section: req.body.section } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Update failed" }); }
});

app.post("/api/delete-clip", requireAuth, async (req, res) => {
  try {
    await Clip.findOneAndDelete({ _id: req.body.id, owner: req.auth.userId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Delete failed" }); }
});

app.post("/api/save-snapshot", requireAuth, async (req, res) => {
  try {
    await Clip.updateOne({ _id: req.body.clipId, owner: req.auth.userId }, { $push: { snapshots: req.body.imageData } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Save failed" }); }
});

// *** UPDATED CHAT ROUTE FOR ROSTER/TENDENCY AWARENESS ***
app.post("/api/clip-chat", requireAuth, async (req, res) => {
  try {
    const clip = await Clip.findOne({ _id: req.body.clipId, owner: req.auth.userId });
    if (!clip || !clip.fullData) return res.json({ reply: "Analysis needed first." });

    // 1. Fetch the Session to get the FULL Roster (All clips in this game)
    const session = await Session.findOne({ sessionId: clip.sessionId, owner: req.auth.userId });
    const rosterContext = session ? JSON.stringify(session.roster) : "[]";

    const chatHistory = clip.chatHistory || [];
    const historyText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.text}`).join("\n");

    // 2. Inject Roster Data into Prompt
    const prompt = `
    ROLE: Elite Football Coordinator / Scout.
    CONTEXT: The user is asking about a specific clip, but you have access to the FULL TEAM ROSTER data from the entire game/session.
    
    CURRENT CLIP DATA: ${JSON.stringify(clip.fullData)}
    
    FULL TEAM ROSTER / TENDENCY DATA: ${rosterContext}
    
    CHAT HISTORY: ${historyText}
    
    USER QUESTION: "${req.body.message}"
    
    INSTRUCTION: 
    1. Answer elegantly and specifically. 
    2. If the user asks about a player, check the ROSTER DATA to see if this player has shown similar weaknesses in other clips (Tendency Analysis).
    3. Use bolding (**text**) for key stats or player names.
    `;
    
    const result = await generateWithFallback([{ text: prompt }]);
    const reply = result.response.text();

    await Clip.updateOne(
        { _id: req.body.clipId }, 
        { $push: { chatHistory: { $each: [{ role: 'user', text: req.body.message }, { role: 'model', text: reply }] } } }
    );

    res.json({ reply });
  } catch (e) { res.status(500).json({ error: "Chat failed" }); }
});

/* ---- MAIN ANALYSIS ROUTE ---- */
app.post("/api/chat", requireAuth, async (req, res) => {
  const { message, sessionId, fileData, mimeType, sport, position } = req.body;
  let tempPath = null;

  try {
    if (!fileData) {
        await Session.updateOne({ sessionId }, { $push: { history: { role: 'user', text: message } } });
        const result = await generateWithFallback([{ text: `ROLE: NFL Coach. USER: ${message}` }]);
        const reply = result.response.text();
        await Session.updateOne({ sessionId }, { $push: { history: { role: 'model', text: reply } } });
        return res.json({ reply });
    }

    const buffer = Buffer.from(fileData, "base64");
    tempPath = path.join(UPLOAD_DIR, `upload_${Date.now()}.mp4`);
    await fs.writeFile(tempPath, buffer);

    const [cloud, uploaded] = await Promise.all([
        cloudinary.uploader.upload(tempPath, { resource_type: "video", folder: "vantage_vision" }),
        fileManager.uploadFile(tempPath, { mimeType, displayName: "Video" })
    ]);

    let savedClip = await Clip.create({
      owner: req.auth.userId, sessionId, sport, videoUrl: cloud.secure_url,
      title: "Analyzing...", formation: "...", section: "Inbox", chatHistory: [], snapshots: []
    });

    let file = await fileManager.getFile(uploaded.file.name);
    while (file.state === FileState.PROCESSING) {
        await new Promise(r => setTimeout(r, 2000));
        file = await fileManager.getFile(uploaded.file.name);
    }
    if (file.state === FileState.FAILED) throw new Error("Video processing failed at Google.");

    const session = await Session.findOne({ sessionId, owner: req.auth.userId });
    const rosterContext = session.roster.map(p => `${p.identifier}: ${p.weaknesses.join(', ')}`).join('\n');
    const specificFocus = RUBRICS[position] || RUBRICS["team"];

    // *** LOGIC FORK: TEAM VS INDIVIDUAL ***
    let systemInstruction;
    
    if (position === 'team') {
        systemInstruction = `
        ROLE: NFL Offensive/Defensive Coordinator.
        TASK: Perform a high-level schematic self-scout of this play (or full game sequence).
        
        ANALYSIS CHECKLIST:
        ${specificFocus}

        ROSTER CONTEXT (Historical Weaknesses):
        ${rosterContext}

        CRITICAL OUTPUT FORMAT (JSON):
        { 
            "title": "Play Title (e.g. 'Power Read vs 4-3 Over')", 
            "data": { "o_formation": "Specific Set", "d_formation": "Front & Coverage" }, 
            "tactical_breakdown": {
                "concept": "Scheme Name",
                "box_count": "Light / Neutral / Loaded",
                "coverage_shell": "Cover X",
                "pressure": "Blitz Type",
                "key_matchup": "Key 1v1"
            },
            "scouting_report": { 
                "summary": "Schematic narrative.", 
                "timeline": [
                    { "time": "0:00", "type": "Pre-Snap", "text": "Alignment." },
                    { "time": "0:04", "type": "Execution", "text": "Result." }
                ],
                "coaching_prescription": { "fix": "Schematic fix", "drill": "Group drill", "pro_tip": "Tip" },
                "report_card": { "scheme_soundness": "Grade", "execution": "Grade", "success_rate": "Efficiency", "overall": "A-" }
            },
            "players_detected": [ { "identifier": "Name", "position": "Pos", "grade": "B", "observation": "Note", "weakness": "Weak" } ] 
        }`;
    } else {
        systemInstruction = `
        ROLE: Elite Private Position Coach.
        TASK: Biomechanical analysis.
        FOCUS: ${specificFocus}
        ROSTER: ${rosterContext}

        OUTPUT JSON:
        { 
            "title": "Play Title", 
            "data": { "o_formation": "Set", "d_formation": "Shell" }, 
            "scouting_report": { 
                "summary": "Technical breakdown.", 
                "timeline": [{ "time": "0:00", "type": "Action", "text": "Obs" }],
                "coaching_prescription": { "fix": "Fix", "drill": "Drill", "pro_tip": "Tip" },
                "report_card": { "football_iq": "B", "technique": "C", "effort": "A", "overall": "B" }
            },
            "players_detected": [ { "identifier": "Name", "position": "Pos", "grade": "B", "observation": "Note", "weakness": "Weak" } ]
        }`;
    }

    const prompt = [ { fileData: { mimeType, fileUri: file.uri } }, { text: systemInstruction } ];
    const result = await generateWithFallback(prompt);
    
    let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    let json = JSON.parse(text);

    if (json.players_detected && json.players_detected.length > 0) {
        for (const p of json.players_detected) {
            const idx = session.roster.findIndex(r => r.identifier === p.identifier);
            if (idx > -1) {
                session.roster[idx].grade = p.grade;
                session.roster[idx].notes.push(p.observation);
                if(p.weakness) session.roster[idx].weaknesses.push(p.weakness);
                session.roster[idx].last_updated = new Date();
            } else {
                session.roster.push({
                    identifier: p.identifier, position: p.position, grade: p.grade,
                    notes: [p.observation], weaknesses: p.weakness ? [p.weakness] : []
                });
            }
        }
        await session.save();
    }

    savedClip.title = json.title;
    savedClip.o_formation = json.data.o_formation;
    savedClip.d_formation = json.data.d_formation;
    savedClip.formation = `${json.data.o_formation} vs ${json.data.d_formation}`;
    savedClip.fullData = json;
    savedClip.geminiFileUri = file.uri;
    await savedClip.save();

    await Session.updateOne({ sessionId }, { $push: { history: { role: 'user', text: "Uploaded Video Analysis" } } });
    await Session.updateOne({ sessionId }, { $push: { history: { role: 'model', text: JSON.stringify(json) } } });

    await fs.unlink(tempPath).catch(console.error);
    res.json({ reply: JSON.stringify(json), newClip: savedClip });

  } catch (e) {
    console.error("SERVER ERROR:", e); 
    if (tempPath) await fs.unlink(tempPath).catch(console.error);
    res.status(500).json({ error: e.message || "Analysis failed." });
  }
});

app.listen(PORT, () => console.log(`🚀 Vantage Vision running on http://localhost:${PORT}`));
