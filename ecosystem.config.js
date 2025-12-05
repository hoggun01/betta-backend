module.exports = {
  apps: [
    {
      name: "betta-ba",
      script: "server.js",
      cwd: "/root/betta-backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        // server
        PORT: "4000",

        // ✅ Betta NFT contract (Base)
        BETTA_CONTRACT_ADDRESS: "0x48A8443f006729729439f9bC529f905c05380BB7",

        // ✅ start block deploy (BaseScan)
        BETTA_START_BLOCK: "38669617",

        // ✅ log scan chunk (kalau RPC sering limit, turunin)
        BETTA_LOG_CHUNK: "8000",

        // ✅ MULTI RPC (fallback otomatis) — pisahkan pakai koma
        // Saran: kalau punya Alchemy/QuickNode, taruh paling depan.
        BASE_RPC_URLS: "https://rpc.ankr.com/base,https://mainnet.base.org",

        // feed & cooldown
        EXP_PER_FEED: "20",
        FEED_COOLDOWN_MS: "1800000"
      }
    }
  ]
};
