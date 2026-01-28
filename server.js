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

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Vantage Vision DB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// *** TANK STRATEGY: Try all reliable models ***
const MODEL_FALLBACK_LIST = [
    "gemini-2.5-pro",         // Best reasoning (least hallucinations)
    "gemini-1.5-pro",         // Good fallback
    "gemini-1.5-pro-002",     // Stable snapshot
    "gemini-1.5-flash",       // Fast fallback
    "gemini-1.5-flash-001"    // Universal fallback
];

async function generateWithFallback(promptParts) {
    let lastError = null;

    for (const modelName of MODEL_FALLBACK_LIST) {
        try {
            console.log(`🤖 Anti-Hallucination Mode: Analyzing with ${modelName}...`);
            
            const model = genAI.getGenerativeModel({ 
                model: modelName,
                // *** FIX 1: ZERO TEMPERATURE ***
                // This forces the AI to be deterministic. No randomness allowed.
                generationConfig: { 
                    temperature: 0.0,
                    topP: 0.95,
                    topK: 40,
                    responseMimeType: "application/json" 
                }
            });

            const result = await model.generateContent({
                contents: [{ role: "user", parts: promptParts }]
            });
            
            console.log(`✅ Success! Verified by: ${modelName}`);
            return result; 

        } catch (error) {
            console.warn(`⚠️ ${modelName} failed. Reason: ${error.message}. Switching...`);
            lastError = error;
            
            if (!error.message.includes("404") && !error.message.includes("not found")) {
               // Optional: Stop on non-connection errors
            }
        }
    }

    console.error("❌ CRITICAL: All models failed.");
    throw new Error(`Analysis failed. Last error: ${lastError.message}`);
}

/* ---------------- RUBRICS ---------------- */
const RUBRICS = {
    "team": "COORDINATOR LEVEL CHECKLIST (22-MAN VIEW):\n1. Offensive Concept: Identify the scheme.\n2. Defensive Shell: Identify Front and Coverage.\n3. Structural Failure: Where did the scheme break down?\n4. Leverage & Numbers: Box count vs perimeter.",
    "qb": "BIOMECHANICS CHECKLIST:\n1. Base Width: Is it too wide or narrow?\n2. Hip Sequencing: Do hips lead the throw?\n3. Eye Discipline: Is he reading the safety rotation?",
    "rb": "BIOMECHANICS CHECKLIST:\n1. Pad Level at contact.\n2. Vision/Cuts (Plant foot efficiency).\n3. Pass Pro scanning.",
    "wr": "BIOMECHANICS CHECKLIST:\n1. Release vs Press.\n2. Stem & Stack technique.\n3. Break point efficiency (sink hips).",
    "te": "BIOMECHANICS CHECKLIST:\n1. In-line blocking leverage.\n2. Route finding in zone pockets.",
    "ol": "BIOMECHANICS CHECKLIST:\n1. First Step explosiveness.\n2. Hand Punch location/timing.\n3. Base width and anchor.",
    "dl": "BIOMECHANICS CHECKLIST:\n1. Get-off speed.\n2. Hand fighting technique.\n3. Gap integrity (spill vs box).",
    "lb": "BIOMECHANICS CHECKLIST:\n1. Read step efficiency.\n2. Downhill trigger speed.\n3. Block shedding mechanics.",
    "cb": "BIOMECHANICS CHECKLIST:\n1. Press/Jam technique.\n2. Hip fluidity (opening the gate).\n3. Phase maintenance.",
    "s": "BIOMECHANICS CHECKLIST:\n1. Range and angle to ball.\n2. Run fit alleys.\n3. Disguise pre-snap.",
    "kp": "BIOMECHANICS CHECKLIST:\n1. Approach consistency.\n2. Plant foot depth.\n3. Leg swing mechanics.",
    "general": "GENERAL MECHANICS:\n1. Stance & Start.\n2. Effort/Motor.\n3. Execution."
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

app.post("/api/clip-chat", requireAuth, async (req, res) => {
  try {
    const clip = await Clip.findOne({ _id: req.body.clipId, owner: req.auth.userId });
    if (!clip || !clip.fullData) return res.json({ reply: "Analysis needed first." });

    const chatHistory = clip.chatHistory || [];
    const historyText = chatHistory.map(h => `${h.role.toUpperCase()}: ${h.text}`).join("\n");

    const prompt = `
    ROLE: Elite Private Mechanics Coach.
    TASK: Answer user question about the clip.
    DATA: ${JSON.stringify(clip.fullData)}
    HISTORY: ${historyText}
    USER QUESTION: "${req.body.message}"
    INSTRUCTION: Be extremely specific. Quote the video data if possible.
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
    // 1. Handle Text-Only Chat
    if (!fileData) {
        await Session.updateOne({ sessionId }, { $push: { history: { role: 'user', text: message } } });
        const result = await generateWithFallback([{ text: `ROLE: NFL Coach. USER: ${message}` }]);
        const reply = result.response.text();
        await Session.updateOne({ sessionId }, { $push: { history: { role: 'model', text: reply } } });
        return res.json({ reply });
    }

    // 2. Handle Video Upload
    const buffer = Buffer.from(fileData, "base64");
    tempPath = path.join(UPLOAD_DIR, `upload_${Date.now()}.mp4`);
    await fs.writeFile(tempPath, buffer);

    const [cloud, uploaded] = await Promise.all([
        cloudinary.uploader.upload(tempPath, { resource_type: "video", folder: "vantage_vision" }),
        fileManager.uploadFile(tempPath, { mimeType, displayName: "Video" })
    ]);

    let savedClip = await Clip.create({
      owner: req.auth.userId,
      sessionId,
      sport,
      videoUrl: cloud.secure_url,
      title: "Scouting...",
      formation: "Analyzing...",
      section: "Inbox",
      chatHistory: [],
      snapshots: []
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

    // *** FIX 2: CHAIN-OF-THOUGHT PROMPTING ***
    // This prompt forces the AI to "Show its work" visually before deciding the result.
    // This drastically reduces hallucinations because it must ground the result in pixels.
    let systemInstruction = `
        ROLE: ${position === 'team' ? "NFL Coordinator" : "Elite Private Coach"}.
        TASK: Analyze this video clip frame-by-frame.
        
        FOCUS: 
        ${specificFocus}

        ROSTER CONTEXT:
        ${rosterContext}

        *** CRITICAL: ANTI-HALLUCINATION PROTOCOL ***
        Step 1: Identify the BALL. Where does it start? Where does it go?
        Step 2: Identify the END RESULT. Did the ball hit the ground? Was it intercepted? Was it a TD?
        Step 3: If the video is too blurry or cuts off, output "UNCLEAR" for that specific field. DO NOT GUESS.

        OUTPUT JSON ONLY:
        { 
            "title": "Play Title (e.g. 'Completed Slant' or 'Interception')", 
            "data": { "o_formation": "Offensive Set", "d_formation": "Defensive Front" }, 
            "scouting_report": { 
                "summary": "Step-by-step diagnostic of exactly what happened physically.", 
                "timeline": [
                    { "time": "0:00", "type": "Snap", "text": "Ball snapped." },
                    { "time": "0:02", "type": "Visual Evidence", "text": "Describe the moment of catch/interception clearly." }
                ],
                "coaching_prescription": { "fix": "", "drill": "", "pro_tip": "" },
                "report_card": { "football_iq": "B", "technique": "C", "effort": "A", "overall": "B" }
            },
            "players_detected": [ { "identifier": "Name", "position": "Pos", "grade": "B", "observation": "Note", "weakness": "Weakness" } ]
        }`;

    const prompt = [ { fileData: { mimeType, fileUri: file.uri } }, { text: systemInstruction } ];
    
    // *** USE THE TANK FUNCTION ***
    const result = await generateWithFallback(prompt);
    let text = result.response.text();
    
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        console.error("JSON PARSE ERROR. Raw text:", text);
        throw new Error("AI returned invalid data.");
    }

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
