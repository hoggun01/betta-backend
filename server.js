"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

// Node < 18 fallback
const fetchFn = global.fetch || require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

process.on("unhandledRejection", (e) => console.error("UNHANDLED_REJECTION", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));

/* =========================
   Config
   ========================= */
const PORT = Number(process.env.PORT || 4000);

// ✅ MULTI RPC: pisahkan pakai koma
// contoh:
// BASE_RPC_URLS="https://base-mainnet.g.alchemy.com/v2/KEY,https://mainnet.base.org,https://rpc.ankr.com/base"
const BASE_RPC_URLS_RAW =
  process.env.BASE_RPC_URLS ||
  process.env.BASE_RPC_URL ||
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://mainnet.base.org";

const RPC_URLS = BASE_RPC_URLS_RAW.split(",")
  .map((s) => String(s || "").trim())
  .filter(Boolean);

// Contract address (wajib)
const BETTA_CONTRACT =
  (process.env.BETTA_CONTRACT_ADDRESS ||
    process.env.NEXT_PUBLIC_BETTA_CONTRACT ||
    process.env.NEXT_PUBLIC_BETTA_CONTRACT_ADDRESS ||
    "").trim();

const START_BLOCK = BigInt(process.env.BETTA_START_BLOCK || "38669617");
const LOG_CHUNK = BigInt(process.env.BETTA_LOG_CHUNK || "20000");
const EXP_PER_FEED = Number(process.env.EXP_PER_FEED || 20);
const FEED_COOLDOWN_MS = Number(process.env.FEED_COOLDOWN_MS || 1800000);

const MAX_LEVEL_BY_RARITY = {
  COMMON: 15,
  UNCOMMON: 20,
  RARE: 30,
  SPIRIT: 25,
  EPIC: 40,
  LEGENDARY: 50,
};

function expNeededForNext(level) {
  return Math.max(0, 100 + Math.max(0, level - 1) * 40);
}

/* =========================
   Storage
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
   Utils
   ========================= */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isHexAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || "").trim());
}
function toHexBlock(bn) {
  return "0x" + bn.toString(16);
}
function pad64No0x(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}
function topicForAddress(addr) {
  const a = String(addr).toLowerCase().replace(/^0x/, "");
  return "0x" + pad64No0x(a);
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_SIG =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/* =========================
   JSON-RPC with multi-RPC fallback
   ========================= */
let rpcCursor = 0;

function pickRpcUrlsRoundRobin() {
  if (!RPC_URLS.length) return ["https://mainnet.base.org"];
  // mulai dari cursor agar rotasi
  const ordered = [];
  for (let i = 0; i < RPC_URLS.length; i++) {
    ordered.push(RPC_URLS[(rpcCursor + i) % RPC_URLS.length]);
  }
  rpcCursor = (rpcCursor + 1) % RPC_URLS.length;
  return ordered;
}

function shouldFailover(errMsg) {
  const s = String(errMsg || "").toLowerCase();
  return (
    s.includes("no backend is currently healthy") ||
    s.includes("http 503") ||
    s.includes("http 502") ||
    s.includes("http 504") ||
    s.includes("rate") ||
    s.includes("timeout") ||
    s.includes("timed out") ||
    s.includes("gateway") ||
    s.includes("temporarily") ||
    s.includes("busy")
  );
}

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };

  const urls = pickRpcUrlsRoundRobin();
  let lastErr = null;

  // coba tiap rpc max 2x dengan backoff kecil
  for (const url of urls) {
    for (const backoff of [0, 350]) {
      try {
        if (backoff) await sleep(backoff);

        const r = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        const text = await r.text().catch(() => "");
        if (!r.ok) {
          throw new Error(`RPC HTTP ${r.status}: ${text.slice(0, 220)}`);
        }

        const j = text ? JSON.parse(text) : null;
        if (!j) throw new Error("RPC empty response");
        if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);

        return j.result;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        // kalau error ini layak failover, lanjut ke rpc url berikutnya
        if (shouldFailover(msg)) continue;
        // kalau bukan transient, stop
        throw e;
      }
    }
  }

  throw lastErr || new Error("RPC_FAILED");
}

async function getLatestBlockNumber() {
  const hex = await rpc("eth_blockNumber", []);
  return BigInt(hex);
}

async function getTransferLogs({ fromBlock, toBlock, fromAddr, toAddr }) {
  if (!BETTA_CONTRACT) throw new Error("BETTA_CONTRACT_ADDRESS not set");

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

  const w = String(wallet || "").trim().toLowerCase();
  if (!isHexAddress(w)) throw new Error("INVALID_WALLET");

  const entry = ownedCache[w] || { lastScannedBlock: null, tokenIds: [] };
  const latest = await getLatestBlockNumber();

  let start = START_BLOCK;
  if (entry.lastScannedBlock !== null && entry.lastScannedBlock !== undefined) {
    const prev = BigInt(entry.lastScannedBlock);
    if (prev + 1n > start) start = prev + 1n;
  }

  const set = new Set((entry.tokenIds || []).map((x) => String(x)));

  if (start > latest) {
    ownedCache[w] = {
      lastScannedBlock: String(latest),
      tokenIds: Array.from(set).sort((a, b) => Number(a) - Number(b)),
    };
    writeJsonAtomic(OWNED_CACHE_PATH, ownedCache);
    return ownedCache[w];
  }

  for (let from = start; from <= latest; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n;

    const logsTo = await getTransferLogs({
      fromBlock: from,
      toBlock: to,
      toAddr: w,
    });
    for (const lg of logsTo) {
      const tid = tokenIdFromLog(lg);
      if (tid !== null) set.add(tid.toString());
    }

    const logsFrom = await getTransferLogs({
      fromBlock: from,
      toBlock: to,
      fromAddr: w,
    });
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
  if (!w) return tokenIdStr;
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

  if (level >= maxLevel) {
    return {
      level: maxLevel,
      exp: expNeededForNext(maxLevel),
      expNeededNext: 0,
      isMax: true,
    };
  }

  return {
    level,
    exp,
    expNeededNext: expNeededForNext(level),
    isMax: false,
  };
}

/* =========================
   Routes
   ========================= */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Betta backend is running",
    port: PORT,
    hasContract: !!BETTA_CONTRACT,
    rpcUrls: RPC_URLS.length,
  });
});

app.get("/owned", async (req, res) => {
  try {
    const q =
      req.query.wallet ||
      req.query.address ||
      req.query.owner ||
      req.query.walletAddress;

    const wallet = String(q || "").trim().toLowerCase();
    if (!isHexAddress(wallet)) {
      return res.status(400).json({ ok: false, error: "INVALID_WALLET" });
    }
    if (!BETTA_CONTRACT) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_CONTRACT_ENV",
        message: "BETTA_CONTRACT_ADDRESS not set",
      });
    }

    // kalau cache sudah ada dan punya token, return cepat
    const cached = ownedCache[wallet];
    if (cached && Array.isArray(cached.tokenIds) && cached.tokenIds.length > 0) {
      return res.json({
        ok: true,
        wallet,
        tokenIds: cached.tokenIds,
        lastScannedBlock: cached.lastScannedBlock ?? null,
        cached: true,
      });
    }

    const entry = await updateOwnedTokensForWallet(wallet);
    return res.json({
      ok: true,
      wallet,
      tokenIds: entry.tokenIds || [],
      lastScannedBlock: entry.lastScannedBlock ?? null,
      cached: false,
    });
  } catch (e) {
    console.error("GET /owned error", e);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: String(e?.message || e),
    });
  }
});

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

app.post("/feed", (req, res) => {
  try {
    const tokenId = String(req.body?.tokenId ?? "");
    const rarity = normalizeRarity(req.body?.rarity);
    const walletAddress = (req.body?.walletAddress || "").toString();
    const fid = req.body?.fid ?? null;

    if (!tokenId)
      return res.status(400).json({ ok: false, error: "INVALID_TOKEN" });

    const { key, row } = getOrInitProgress({
      tokenId,
      rarity,
      walletAddress,
      fid,
    });

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
    row.exp = isMax ? expNeededForNext(maxLevel) : exp;
    row.rarity = rarity;
    row.lastFeedAt = now;
    row.walletAddress = walletAddress || row.walletAddress || null;
    row.fid = fid ?? row.fid ?? null;

    progressDb[key] = row;
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
if (!BETTA_CONTRACT) {
  console.error("❌ Missing BETTA_CONTRACT_ADDRESS env");
}
console.log("RPC_URLS:", RPC_URLS);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Betta backend listening on port ${PORT}`);
});
