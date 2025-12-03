const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

// CORS (boleh untuk farcaster.xyz / vercel / dll)
app.use(cors());
app.use(express.json());

// IMPORTANT: Express versi baru kadang error kalau "*".
// Paling aman pakai regex:
app.options(/.*/, cors());

// ====== CONFIG RARITY & EXP RULES ======
const MAX_LEVEL_BY_RARITY = {
  COMMON: 15,
  UNCOMMON: 20,
  RARE: 30,
  EPIC: 40,
  LEGENDARY: 50,
  SPIRIT: 25,
};

const FEED_EXP_GAIN = 20; // +20 exp per feed
const COOLDOWN_MS = 30 * 60 * 1000; // 30 menit

// expNeeded(level) = 100 + (level - 1) * 40
function getExpNeededForNextLevel(level) {
  if (level <= 0) return 100;
  return 100 + (level - 1) * 40;
}

// ====== "Database" JSON di VPS ======
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "database-fish.json");

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}", "utf-8");
  } catch (err) {
    console.error("ensureDataDir error:", err);
  }
}

function loadDB() {
  try {
    ensureDataDir();
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    if (!raw) return {};
    return JSON.parse(raw);
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

// ====== RUMUS FEED (LEVEL UP) ======
function applyFeed(entry, rarity) {
  const maxLevel = MAX_LEVEL_BY_RARITY[rarity] || 1;

  let level = entry.level || 1;
  let exp = entry.exp || 0;

  exp += FEED_EXP_GAIN;

  while (true) {
    const needed = getExpNeededForNextLevel(level);

    if (level >= maxLevel) {
      exp = 0; // kalau max level, exp dikunci 0 (sesuai rules sebelumnya)
      break;
    }

    if (exp >= needed) {
      exp -= needed;
      level += 1;
      continue;
    }
    break;
  }

  return { level, exp };
}

function buildProgressPayload(entryOrNull, rarityFallback) {
  const rarity = (entryOrNull?.rarity || rarityFallback || "COMMON").toUpperCase();
  const maxLevel = MAX_LEVEL_BY_RARITY[rarity] || 1;

  const level = entryOrNull?.level ?? 1;
  const exp = entryOrNull?.exp ?? 0;

  const isMax = level >= maxLevel;
  const expNeededNext = isMax ? 0 : getExpNeededForNextLevel(level);

  return { level, exp, expNeededNext, isMax };
}

// ====== ROUTE: PROGRESS ======
// body: { fishes: [{ tokenId:"1", rarity:"COMMON" }, ...] }
app.post("/progress", (req, res) => {
  try {
    const { fishes } = req.body || {};
    if (!Array.isArray(fishes)) {
      return res.status(400).json({ ok: false, error: "INVALID_FISHES" });
    }

    const db = loadDB();
    const progressByToken = {};

    for (const f of fishes) {
      const tokenId = String(f?.tokenId ?? "");
      if (!tokenId) continue;

      const entry = db[tokenId] || null;
      progressByToken[tokenId] = buildProgressPayload(entry, f?.rarity);
    }

    return res.json({ ok: true, progressByToken });
  } catch (err) {
    console.error("POST /progress error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// ====== ROUTE: FEED ======
// body: { tokenId:"1", rarity:"COMMON", walletAddress?, fid? }
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
      rarity: rarity,
      level: 1,
      exp: 0,
      lastFeedAt: 0,
      walletAddress: walletAddress || null,
      fid: fid || null,
    };

    // cooldown backend
    if (existing.lastFeedAt && now - existing.lastFeedAt < COOLDOWN_MS) {
      const remainingMs = existing.lastFeedAt + COOLDOWN_MS - now;
      return res.status(429).json({
        ok: false,
        error: "ON_COOLDOWN",
        remainingMs,
        retryAt: existing.lastFeedAt + COOLDOWN_MS,
        cooldownMs: COOLDOWN_MS,
        lastFeedAt: existing.lastFeedAt,
      });
    }

    // apply rumus exp/level
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

    const progress = buildProgressPayload(updated, rarity);

    return res.json({
      ok: true,
      tokenId: key,
      rarity,
      level: progress.level,
      exp: progress.exp,
      expNeededNext: progress.expNeededNext,
      isMax: progress.isMax,
      cooldownMs: COOLDOWN_MS,
      lastFeedAt: updated.lastFeedAt,
    });
  } catch (err) {
    console.error("POST /feed error:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// ====== HEALTHCHECK ======
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Betta backend running" });
});

const PORT = process.env.PORT || 4000;
ensureDataDir();
app.listen(PORT, () => console.log(`Betta backend listening on port ${PORT}`));
