const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ===== CORS + Preflight (NO app.options("*"))
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ====== CONFIG RARITY & EXP RULES ======
const MAX_LEVEL_BY_RARITY = {
  COMMON: 15,
  UNCOMMON: 20,
  RARE: 30,
  EPIC: 40,
  LEGENDARY: 50,
  SPIRIT: 25,
};

const FEED_EXP_GAIN = 20;
const COOLDOWN_MS = 30 * 60 * 1000;

function getExpNeededForNextLevel(level) {
  if (level <= 0) return 100;
  return 100 + (level - 1) * 40;
}

// ====== "Database" JSON di VPS ======
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "database-fish.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDB() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DB_PATH)) return {};
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("loadDB error:", err);
    return {};
  }
}

function saveDB(db) {
  try {
    ensureDataDir();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  } catch (err) {
    console.error("saveDB error:", err);
  }
}

function computeProgressShape(entry) {
  const rarity = entry?.rarity || null;
  const level = Number(entry?.level || 1);
  const exp = Number(entry?.exp || 0);

  const maxLevel = rarity ? (MAX_LEVEL_BY_RARITY[rarity] || 1) : 1;
  const isMax = !!rarity && level >= maxLevel;
  const expNeededNext = isMax ? 0 : getExpNeededForNextLevel(level);

  return { level, exp, expNeededNext, isMax };
}

function applyFeed(entry, rarity) {
  const maxLevel = MAX_LEVEL_BY_RARITY[rarity] || 1;
  let level = entry.level || 1;
  let exp = entry.exp || 0;

  exp += FEED_EXP_GAIN;

  while (true) {
    if (level >= maxLevel) {
      exp = 0;
      break;
    }
    const needed = getExpNeededForNextLevel(level);
    if (exp >= needed) {
      exp -= needed;
      level += 1;
      continue;
    }
    break;
  }

  return { level, exp };
}

// ====== ROUTE: PROGRESS ======
app.post("/progress", (req, res) => {
  try {
    const { fishes, tokenIds } = req.body || {};

    let ids = [];
    if (Array.isArray(fishes)) {
      ids = fishes.map((f) => String(f?.tokenId)).filter(Boolean);
    } else if (Array.isArray(tokenIds)) {
      ids = tokenIds.map((id) => String(id)).filter(Boolean);
    }

    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "INVALID_PARAMS" });
    }

    const db = loadDB();
    const progressByToken = {};

    for (const tokenId of ids) {
      const entry = db[tokenId];
      progressByToken[tokenId] = entry
        ? computeProgressShape(entry)
        : computeProgressShape({ rarity: null, level: 1, exp: 0 });
    }

    return res.json({ ok: true, progressByToken });
  } catch (err) {
    console.error("POST /progress error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// ====== ROUTE: FEED ======
app.post("/feed", (req, res) => {
  try {
    const { tokenId, rarity, walletAddress, fid } = req.body || {};
    if (!tokenId || !rarity) {
      return res.status(400).json({ ok: false, error: "MISSING_PARAMS" });
    }

    const now = Date.now();
    const db = loadDB();
    const key = String(tokenId);

    const existing = db[key] || {
      tokenId: key,
      rarity,
      level: 1,
      exp: 0,
      lastFeedAt: 0,
      walletAddress: walletAddress || null,
      fid: fid || null,
    };

    if (existing.lastFeedAt && now - existing.lastFeedAt < COOLDOWN_MS) {
      const remainingMs = existing.lastFeedAt + COOLDOWN_MS - now;
      return res.status(429).json({ ok: false, error: "ON_COOLDOWN", remainingMs });
    }

    const updatedStats = applyFeed(existing, rarity);

    const updated = {
      ...existing,
      rarity,
      level: updatedStats.level,
      exp: updatedStats.exp,
      lastFeedAt: now,
      walletAddress: walletAddress || existing.walletAddress,
      fid: fid || existing.fid,
    };

    db[key] = updated;
    saveDB(db);

    const shaped = computeProgressShape(updated);

    return res.json({
      ok: true,
      tokenId: key,
      rarity,
      level: shaped.level,
      exp: shaped.exp,
      expNeededNext: shaped.expNeededNext,
      isMax: shaped.isMax,
      cooldownMs: COOLDOWN_MS,
      lastFeedAt: updated.lastFeedAt,
    });
  } catch (err) {
    console.error("POST /feed error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Betta backend running" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Betta backend listening on port ${PORT}`);
});
