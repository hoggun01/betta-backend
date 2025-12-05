"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================
   Config
   ========================= */
const PORT = Number(process.env.PORT || 4000);

// RPC Base (wajib stabil, jangan default kalau sering rate limit)
const BASE_RPC_URL =
  process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";

// Contract address (wajib)
const BETTA_CONTRACT =
  (process.env.BETTA_CONTRACT_ADDRESS ||
    process.env.NEXT_PUBLIC_BETTA_CONTRACT ||
    process.env.NEXT_PUBLIC_BETTA_CONTRACT_ADDRESS ||
    "").trim();

if (!BETTA_CONTRACT) {
  console.error("❌ Missing BETTA_CONTRACT_ADDRESS env");
}

// Contract creation block (BaseScan menunjukkan 38669617)
const START_BLOCK = BigInt(process.env.BETTA_START_BLOCK || "38669617");

// log scan chunk blocks (kalau RPC limit, turunin ini)
const LOG_CHUNK = BigInt(process.env.BETTA_LOG_CHUNK || "20000");

// feed config
const EXP_PER_FEED = Number(process.env.EXP_PER_FEED || 20);

// gampang ganti cooldown di sini:
// contoh 1 menit: FEED_COOLDOWN_MS=60000
// contoh 10 menit: FEED_COOLDOWN_MS=600000
// contoh 30 menit: FEED_COOLDOWN_MS=1800000
const FEED_COOLDOWN_MS = Number(process.env.FEED_COOLDOWN_MS || 1800000);

// max level per rarity
const MAX_LEVEL_BY_RARITY = {
  COMMON: 15,
  UNCOMMON: 20,
  RARE: 30,
  SPIRIT: 25,
  EPIC: 40,
  LEGENDARY: 50,
};

// exp needed (simple & stabil): 100 + (level-1)*40
function expNeededForNext(level) {
  return Math.max(0, 100 + Math.max(0, level - 1) * 40);
}

/* =========================
   Storage (JSON files)
   ========================= */
const DATA_DIR = path.join(__dirname, "data");
const PROGRESS_DB_PATH = path.join(DATA_DIR, "database-fish.json");
const OWNED_CACHE_PATH = path.join(DATA_DIR, "wallet-owned.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

ensureDataDir();

let progressDb = readJsonSafe(PROGRESS_DB_PATH, {});
let ownedCache = readJsonSafe(OWNED_CACHE_PATH, {});

/* =========================
   CORS
   ========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* =========================
   Minimal JSON-RPC helpers
   ========================= */
async function rpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  };

  const r = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`RPC HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

function toHexBlock(bn) {
  return "0x" + bn.toString(16);
}
async function getLatestBlockNumber() {
  const hex = await rpc("eth_blockNumber", []);
  return BigInt(hex);
}

function pad64No0x(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}
function topicForAddress(addr) {
  const a = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + pad64No0x(a);
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_SIG =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function getTransferLogs({ fromBlock, toBlock, fromAddr, toAddr }) {
  const topics = [TRANSFER_SIG, null, null, null];

  if (fromAddr) topics[1] = topicForAddress(fromAddr);
  if (toAddr) topics[2] = topicForAddress(toAddr);

  const filter = {
    address: BETTA_CONTRACT,
    fromBlock: toHexBlock(fromBlock),
    toBlock: toHexBlock(toBlock),
    topics,
  };

  return await rpc("eth_getLogs", [filter]);
}

function tokenIdFromLog(log) {
  // ERC721 Transfer tokenId indexed => topics[3]
  const t3 = log?.topics?.[3];
  if (!t3) return null;
  try {
    return BigInt(t3);
  } catch {
    return null;
  }
}

/* =========================
   Owned token cache via logs
   ========================= */
async function updateOwnedTokensForWallet(wallet) {
  if (!BETTA_CONTRACT) throw new Error("BETTA_CONTRACT_ADDRESS not set");
  const w = wallet.toLowerCase();
  const entry = ownedCache[w] || { lastScannedBlock: null, tokenIds: [] };

  const latest = await getLatestBlockNumber();

  let start = START_BLOCK;
  if (entry.lastScannedBlock !== null && entry.lastScannedBlock !== undefined) {
    const prev = BigInt(entry.lastScannedBlock);
    if (prev + 1n > start) start = prev + 1n;
  }

  // current holdings set
  const set = new Set((entry.tokenIds || []).map((x) => String(x)));

  if (start > latest) {
    // nothing to do
    ownedCache[w] = { lastScannedBlock: String(latest), tokenIds: Array.from(set).sort((a,b)=>Number(a)-Number(b)) };
    writeJsonAtomic(OWNED_CACHE_PATH, ownedCache);
    return ownedCache[w];
  }

  // scan logs in ranges
  for (let from = start; from <= latest; from += LOG_CHUNK) {
    const to = (from + LOG_CHUNK - 1n) > latest ? latest : (from + LOG_CHUNK - 1n);

    // receive logs
    const logsTo = await getTransferLogs({ fromBlock: from, toBlock: to, toAddr: w });
    for (const lg of logsTo) {
      const tid = tokenIdFromLog(lg);
      if (tid !== null) set.add(tid.toString());
    }

    // send logs (remove)
    const logsFrom = await getTransferLogs({ fromBlock: from, toBlock: to, fromAddr: w });
    for (const lg of logsFrom) {
      const tid = tokenIdFromLog(lg);
      if (tid !== null) set.delete(tid.toString());
    }
  }

  const tokenIds = Array.from(set).sort((a, b) => Number(a) - Number(b));

  ownedCache[w] = {
    lastScannedBlock: String(latest),
    tokenIds,
  };
  writeJsonAtomic(OWNED_CACHE_PATH, ownedCache);

  return ownedCache[w];
}

/* =========================
   Progress DB helpers
   ========================= */
function progressKey(walletAddress, tokenIdStr) {
  const w = (walletAddress || "").toLowerCase();
  if (!w) return tokenIdStr; // fallback
  return `${w}:${tokenIdStr}`;
}
function normalizeRarity(r) {
  const up = String(r || "").toUpperCase();
  if (up === "COMMON") return "COMMON";
  if (up === "UNCOMMON") return "UNCOMMON";
  if (up === "RARE") return "RARE";
  if (up === "EPIC") return "EPIC";
  if (up === "LEGENDARY") return "LEGENDARY";
  if (up === "SPIRIT") return "SPIRIT";
  return "COMMON";
}
function getMaxLevel(rarity) {
  return MAX_LEVEL_BY_RARITY[rarity] || 15;
}

function getOrInitProgress({ tokenId, rarity, walletAddress, fid }) {
  const tokenIdStr = String(tokenId);
  const rar = normalizeRarity(rarity);
  const key = progressKey(walletAddress, tokenIdStr);

  // prefer walletKey, fallback to tokenId only (biar backward compatible)
  let row = progressDb[key] || progressDb[tokenIdStr];

  if (!row) {
    row = {
      tokenId: tokenIdStr,
      rarity: rar,
      level: 1,
      exp: 0,
      lastFeedAt: 0,
      walletAddress: walletAddress || null,
      fid: fid ?? null,
    };
  } else {
    // normalize
    row.tokenId = tokenIdStr;
    row.rarity = rar;
    row.walletAddress = walletAddress || row.walletAddress || null;
    row.fid = fid ?? row.fid ?? null;
  }

  return { key, row };
}

function serializeProgress(row) {
  const level = Number(row.level || 1);
  const exp = Number(row.exp || 0);
  const maxLevel = getMaxLevel(row.rarity);
  const isMax = level >= maxLevel;

  if (isMax) {
    return { level: maxLevel, exp: expNeededForNext(maxLevel), expNeededNext: 0, isMax: true };
  }

  const need = expNeededForNext(level);
  return { level, exp, expNeededNext: need, isMax: false };
}

/* =========================
   Routes
   ========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Betta backend is running", port: PORT });
});

// ✅ NEW: returns tokenIds owned by wallet (fast, accurate)
app.get("/owned", async (req, res) => {
  try {
    const wallet = String(req.query.wallet || "").trim();
    if (!wallet || !wallet.startsWith("0x") || wallet.length < 10) {
      return res.status(400).json({ ok: false, error: "INVALID_WALLET" });
    }
    const entry = await updateOwnedTokensForWallet(wallet);
    return res.json({
      ok: true,
      wallet: wallet.toLowerCase(),
      tokenIds: entry.tokenIds || [],
      lastScannedBlock: entry.lastScannedBlock,
    });
  } catch (e) {
    console.error("GET /owned error", e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// returns progress for fishes
app.post("/progress", (req, res) => {
  try {
    const fishes = req.body?.fishes;
    const walletAddress = (req.body?.walletAddress || "").toString();
    const fid = req.body?.fid ?? null;

    if (!Array.isArray(fishes) || fishes.length === 0) {
      return res.status(400).json({ ok: false, error: "INVALID_FISHES" });
    }

    const out = {};
    for (const f of fishes) {
      const tokenId = String(f?.tokenId ?? "");
      const rarity = normalizeRarity(f?.rarity);
      if (!tokenId) continue;

      const { row } = getOrInitProgress({ tokenId, rarity, walletAddress, fid });
      out[tokenId] = serializeProgress(row);
    }

    return res.json({ ok: true, progressByToken: out });
  } catch (e) {
    console.error("POST /progress error", e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

// feed (adds exp, enforces cooldown)
app.post("/feed", (req, res) => {
  try {
    const tokenId = String(req.body?.tokenId ?? "");
    const rarity = normalizeRarity(req.body?.rarity);
    const walletAddress = (req.body?.walletAddress || "").toString();
    const fid = req.body?.fid ?? null;

    if (!tokenId) return res.status(400).json({ ok: false, error: "INVALID_TOKEN" });

    const { key, row } = getOrInitProgress({ tokenId, rarity, walletAddress, fid });

    const now = Date.now();
    const last = Number(row.lastFeedAt || 0);
    const nextOkAt = last + FEED_COOLDOWN_MS;

    if (nextOkAt > now) {
      return res.status(429).json({
        ok: false,
        error: "ON_COOLDOWN",
        remainingMs: nextOkAt - now,
      });
    }

    // apply exp/level
    let level = Number(row.level || 1);
    let exp = Number(row.exp || 0);

    const maxLevel = getMaxLevel(rarity);
    if (level >= maxLevel) {
      return res.json({
        ok: true,
        tokenId,
        rarity,
        level: maxLevel,
        exp: expNeededForNext(maxLevel),
        expNeededNext: 0,
        isMax: true,
        cooldownMs: FEED_COOLDOWN_MS,
        lastFeedAt: now,
      });
    }

    exp += EXP_PER_FEED;

    // level up loop
    while (level < maxLevel) {
      const need = expNeededForNext(level);
      if (need <= 0) break;
      if (exp < need) break;
      exp -= need;
      level += 1;
      if (level >= maxLevel) break;
    }

    const isMax = level >= maxLevel;
    row.level = level;
    row.exp = isMax ? expNeededForNext(maxLevel) : exp; // if max, keep UI pretty
    row.rarity = rarity;
    row.lastFeedAt = now;
    row.walletAddress = walletAddress || row.walletAddress || null;
    row.fid = fid ?? row.fid ?? null;

    progressDb[key] = row;
    // optional: also write tokenId-only row for backward compat (safe)
    progressDb[tokenId] = row;

    writeJsonAtomic(PROGRESS_DB_PATH, progressDb);

    const payload = serializeProgress(row);
    return res.json({
      ok: true,
      tokenId,
      rarity,
      ...payload,
      cooldownMs: FEED_COOLDOWN_MS,
      lastFeedAt: now,
    });
  } catch (e) {
    console.error("POST /feed error", e);
    return res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
  }
});

/* =========================
   Start
   ========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Betta backend listening on port ${PORT}`);
});
