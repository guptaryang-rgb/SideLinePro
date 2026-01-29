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
            console.warn(`⚠️ ${modelName} failed: ${error.message}`);
            lastError = error;
            if (!error.message.includes("404") && !error.message.includes("not found")) {} // Continue
        }
    }
    throw new Error(`Analysis failed. Last error: ${lastError.message}`);
}

/* ---------------- UPDATED RUBRICS ---------------- */
const RUBRICS = {
    // *** NEW: COORDINATOR LEVEL RUBRIC ***
    "team": `
    ELITE COORDINATOR DIAGNOSTICS:
    1. SITUATION: Down, Distance, Field Position, Personnel (11, 12, 21, Empty).
    2. PRE-SNAP: Formation Width, Motion, Defensive Front (Over/Under/Tite), Safety Shell (MOFO/MOFC).
    3. SCHEME: Identify Concept (Mesh, Dagger, Duo, Inside Zone) vs Coverage (Cover 1, 3, 4, 6).
    4. THE 'WHY': Point of Attack win/loss? Conflict player decision? Blown assignment?
    5. EFFICIENCY: Success Rate (4+ yds on 1st, Conversion on 3rd).`,
    
    // *** PLAYER RUBRICS ***
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

app.post("/api/clip-chat", requireAuth, async (req, res) => {
  try {
    const clip = await Clip.findOne({ _id: req.body.clipId, owner: req.auth.userId });
    if (!clip || !clip.fullData) return res.json({ reply: "Analysis needed first." });

    const chatHistory = clip.chatHistory || [];
    const historyText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.text}`).join("\n");

    const prompt = `
    ROLE: Elite Coach.
    CONTEXT: Reviewing a clip.
    DATA: ${JSON.stringify(clip.fullData)}
    HISTORY: ${historyText}
    QUESTION: "${req.body.message}"
    TASK: Answer specifically using the data provided.
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
        // --- COORDINATOR MODE ---
        systemInstruction = `
        ROLE: NFL Offensive/Defensive Coordinator.
        TASK: Perform a high-level schematic self-scout of this play.
        
        ANALYSIS CHECKLIST:
        ${specificFocus}

        CRITICAL OUTPUT FORMAT (JSON):
        { 
            "title": "Play Title (e.g. 'Power Read vs 4-3 Over')", 
            "data": { "o_formation": "Specific Set", "d_formation": "Front & Coverage" }, 
            "tactical_breakdown": {
                "concept": "Name of Scheme (e.g. Duo, Mesh)",
                "box_count": "Light / Neutral / Loaded (count)",
                "coverage_shell": "Pre-Snap (MOFO/MOFC) -> Post-Snap (Rotation)",
                "pressure": "Blitz? Stunt? Base?",
                "key_matchup": "The specific 1v1 that decided the play"
            },
            "scouting_report": { 
                "summary": "Schematic narrative of the play.", 
                "timeline": [
                    { "time": "0:00", "type": "Pre-Snap", "text": "Formations, Motion, Leverage." },
                    { "time": "0:02", "type": "Snap/Read", "text": "The Conflict: Who was put in a bind?" },
                    { "time": "0:04", "type": "Execution", "text": "Point of Attack result." }
                ],
                "coaching_prescription": { "fix": "Schematic fix", "drill": "Group install drill", "pro_tip": "Coordination tip" },
                "report_card": { "scheme_soundness": "A/B/C", "execution": "A/B/C", "success_rate": "Efficiency Grade", "overall": "A-" }
            },
            "players_detected": [] 
        }`;
    } else {
        // --- PLAYER MODE ---
        systemInstruction = `
        ROLE: Elite Private Position Coach.
        TASK: Biomechanical analysis of specific player.
        
        FOCUS: ${specificFocus}
        ROSTER: ${rosterContext}

        OUTPUT JSON:
        { 
            "title": "Play Title", 
            "data": { "o_formation": "Set", "d_formation": "Shell" }, 
            "scouting_report": { 
                "summary": "Technical breakdown.", 
                "timeline": [{ "time": "0:00", "type": "Action", "text": "Obs" }],
                "coaching_prescription": { "fix": "Tech fix", "drill": "Drill", "pro_tip": "Tip" },
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
