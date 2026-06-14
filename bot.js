// ════════════════════════════════════════════════════════════════
//  NEURALTRADE BOT  –  Node.js Backend für Railway
//  Capital.com Live API · Claude AI Brain · Telegram Alerts
// ════════════════════════════════════════════════════════════════
import https from "https";
import http  from "http";

const CAPITAL_BASE   = process.env.CAPITAL_BASE ?? "https://api-capital.backend-capital.com/api/v1";
const API_KEY        = process.env.CAPITAL_API_KEY;
const IDENTIFIER     = process.env.CAPITAL_IDENTIFIER;
const PASSWORD       = process.env.CAPITAL_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const POLL_MS        = 30_000;
const MAX_POS_PCT    = 0.18;
const MIN_CONFIDENCE = 65;
const TOTAL_CAPITAL  = 50;

// ── Watchlist ─────────────────────────────────────────────────
const WATCHLIST = [
  { epic: "GOLD",   name: "Gold",      emoji: "🥇" },
  { epic: "SILVER", name: "Silber",    emoji: "🥈" },
  { epic: "BTCUSD", name: "Bitcoin",   emoji: "₿"  },
  { epic: "ETHUSD", name: "Ethereum",  emoji: "Ξ"  },
  { epic: "EURUSD", name: "EUR/USD",   emoji: "💶" },
  { epic: "US500",  name: "S&P 500",   emoji: "📈" },
  { epic: "NVDA",   name: "NVIDIA",    emoji: "🤖" },
  { epic: "NATGAS", name: "Erdgas",    emoji: "⛽" },
];

const EARNINGS_CONTEXT = {
  NVDA:   "NVIDIA Q1 2026: Beat estimates +12%, Revenue $26B. AI demand surging.",
  US500:  "S&P500 Q1 2026: 78% beat EPS. Tech outperforming.",
  BTCUSD: "BTC Halving April 2024. ETF inflows $35B+ YTD.",
  GOLD:   "Gold near highs – central bank buying + geopolitical tension.",
  EURUSD: "ECB rates steady. USD weakening on Fed pivot expectations.",
};

// ── State ─────────────────────────────────────────────────────
let session      = null;
let priceHistory = {};
let cycle        = 0;
let xSentiment   = "";

// ════════════════════════════════════════════════════════════════
//  CORE HTTP  (native Node.js https – no dependencies needed)
// ════════════════════════════════════════════════════════════════
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const headers = {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + (parsed.search ?? ""),
      method:   options.method ?? "GET",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
const fmt   = (n, d=2) => n == null ? "-" : Number(n).toFixed(d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

async function capitalApi(method, path, body) {
  const headers = { "X-CAP-API-KEY": API_KEY };
  if (session?.cst)           headers["CST"]             = session.cst;
  if (session?.securityToken) headers["X-SECURITY-TOKEN"] = session.securityToken;

  const res = await request(`${CAPITAL_BASE}${path}`, { method, headers }, body ?? null);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Capital ${res.status} ${method} ${path}: ${res.body.slice(0,200)}`);
  }
  return res.body ? JSON.parse(res.body) : {};
}

async function anthropicApi(payload) {
  const res = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
  }, payload);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Anthropic ${res.status}: ${res.body.slice(0,200)}`);
  }
  return JSON.parse(res.body);
}

async function telegramApi(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { method: "POST" }, {
      chat_id: TELEGRAM_CHAT, text: msg, parse_mode: "HTML",
    });
    log("📱 Telegram gesendet");
  } catch(e) { log(`⚠️ Telegram: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ════════════════════════════════════════════════════════════════
function calcIndicators(prices) {
  if (!prices || prices.length < 2) return {};
  const ma = n => prices.length >= n ? prices.slice(-n).reduce((a,b)=>a+b,0)/n : null;

  const period  = Math.min(14, prices.length - 1);
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const rs  = losses === 0 ? 100 : (gains/period) / (losses/period);
  const rsi = Math.round(100 - 100/(1+rs));
  return { ma5: ma(5), ma13: ma(13), ma21: ma(21), rsi };
}

// ════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════
async function authenticate() {
  log("🔐 Authentifiziere bei Capital.com…");
  const data = await capitalApi("POST", "/session", { identifier: IDENTIFIER, password: PASSWORD });
  session = { cst: data.clientSessionToken ?? data.cst, securityToken: data.securityToken };
  log("✅ Session aktiv");
}

// ════════════════════════════════════════════════════════════════
//  FETCH PRICES
// ════════════════════════════════════════════════════════════════
async function fetchPrices() {
  const out = {};
  for (const inst of WATCHLIST) {
    try {
      const data = await capitalApi("GET", `/markets/${inst.epic}`);
      const snap = data.snapshot ?? {};
      const mid  = snap.bid && snap.offer ? (snap.bid + snap.offer) / 2 : null;
      out[inst.epic] = { bid: snap.bid, offer: snap.offer, mid, name: inst.name, emoji: inst.emoji };
      if (mid) priceHistory[inst.epic] = [...(priceHistory[inst.epic] ?? []), mid].slice(-30);
    } catch(e) { log(`⚠️ ${inst.epic}: ${e.message}`); }
    await sleep(250);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
//  ACCOUNT + POSITIONS
// ════════════════════════════════════════════════════════════════
async function fetchAccountData() {
  const [a, p] = await Promise.allSettled([
    capitalApi("GET", "/accounts"),
    capitalApi("GET", "/positions"),
  ]);
  return {
    account:   a.status === "fulfilled" ? a.value.accounts?.[0] : null,
    positions: p.status === "fulfilled" ? p.value.positions ?? [] : [],
  };
}

// ════════════════════════════════════════════════════════════════
//  X SENTIMENT
// ════════════════════════════════════════════════════════════════
async function fetchXSentiment() {
  if (!ANTHROPIC_KEY) return "Kein Anthropic Key.";
  const data = await anthropicApi({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content:
      "Search financial news and X/Twitter for current sentiment on: Gold, Bitcoin, Ethereum, NVIDIA, S&P500, EUR/USD, Natural Gas, Silver. " +
      "Give a concise 3-sentence German summary of trader sentiment and any breaking news affecting prices."
    }],
  });
  return data.content?.find(b => b.type === "text")?.text ?? "Keine Daten.";
}

// ════════════════════════════════════════════════════════════════
//  CLAUDE AI BRAIN
// ════════════════════════════════════════════════════════════════
async function askClaudeBrain({ marketData, positions, balance }) {
  if (!ANTHROPIC_KEY) return { decisions: [], marketSummary: "", riskLevel: "MEDIUM" };

  const enriched = {};
  for (const [epic, d] of Object.entries(marketData)) {
    enriched[epic] = { ...d, ...calcIndicators(priceHistory[epic] ?? []) };
  }

  const prompt =
`You are an autonomous trading AI managing a CHF ${TOTAL_CAPITAL} live portfolio (1:1 leverage) on Capital.com.

BALANCE: CHF ${fmt(balance)}
MAX PER POSITION: CHF ${fmt(TOTAL_CAPITAL * MAX_POS_PCT)}

MARKET DATA + INDICATORS:
${JSON.stringify(enriched, null, 2)}

OPEN POSITIONS:
${JSON.stringify(positions.map(p => ({
  epic: p.market?.epic,
  direction: p.position?.direction,
  size: p.position?.dealSize,
  openLevel: p.position?.openLevel,
  upl: p.position?.upl,
  dealId: p.position?.dealId,
})), null, 2)}

FUNDAMENTALS:
${JSON.stringify(EARNINGS_CONTEXT, null, 2)}

X/TWITTER SENTIMENT:
${xSentiment}

RULES:
- Max 18% per instrument
- Diversify across asset classes
- RSI >70 = overbought (SELL signal), <30 = oversold (BUY signal)
- MA5 > MA13 = bullish trend, MA5 < MA13 = bearish trend
- Only trade when 2+ signals agree
- Consider spread cost (bid/offer difference)

Respond ONLY with valid JSON, no markdown:
{"decisions":[{"epic":"GOLD","action":"BUY","size":0.5,"confidence":82,"reason":"Kurze deutsche Begründung"}],"marketSummary":"2-3 Sätze Deutsch","riskLevel":"LOW"}

Only BUY or SELL decisions. Omit HOLDs.`;

  const data = await anthropicApi({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw   = data.content?.find(b => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    log(`⚠️ JSON Parse Fehler: ${clean.slice(0,100)}`);
    return { decisions: [], marketSummary: "", riskLevel: "MEDIUM" };
  }
}

// ════════════════════════════════════════════════════════════════
//  EXECUTE TRADE
// ════════════════════════════════════════════════════════════════
async function executeTrade(decision, positions) {
  const { epic, action, size, confidence, reason } = decision;
  const inst        = WATCHLIST.find(w => w.epic === epic);
  const existingPos = positions.find(p => p.market?.epic === epic);
  const existingDir = existingPos?.position?.direction;

  if (existingDir === action) {
    log(`↩️  ${epic}: ${action} bereits offen – skip`);
    return;
  }

  // Close opposite
  if (existingPos) {
    const dealId = existingPos.position?.dealId;
    const upl    = existingPos.position?.upl ?? 0;
    try {
      await capitalApi("DELETE", `/positions/${dealId}`);
      log(`${upl >= 0 ? "✅" : "❌"} CLOSE ${existingDir} ${epic} | P&L: CHF ${fmt(upl)}`);
      await telegramApi(upl >= 0
        ? `🟢 <b>GEWINN!</b>\n${inst?.emoji} ${inst?.name}\n+CHF ${fmt(upl)}\n${reason}`
        : `🔴 <b>VERLUST</b>\n${inst?.emoji} ${inst?.name}\n-CHF ${fmt(Math.abs(upl))}\n${reason}`);
    } catch(e) { log(`❌ Close ${epic}: ${e.message}`); }
    await sleep(400);
  }

  // Open new
  const tradeSize = Math.max(0.1, Math.min(size, TOTAL_CAPITAL * MAX_POS_PCT));
  try {
    await capitalApi("POST", "/positions", {
      epic, direction: action, size: tradeSize,
      guaranteedStop: false, trailingStop: false,
    });
    const e = action === "BUY" ? "🟢" : "🔴";
    log(`${e} ${action} ${epic} | Größe:${tradeSize} | ${confidence}% | ${reason}`);
    await telegramApi(`${e} <b>TRADE</b>\n${inst?.emoji} ${inst?.name}\n${action} · ${tradeSize}\n${confidence}% Konfidenz\n${reason}`);
  } catch(e) { log(`❌ Open ${epic}: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  MAIN TICK
// ════════════════════════════════════════════════════════════════
async function tick() {
  cycle++;
  log(`\n━━━ ZYKLUS #${cycle} ━━━`);
  try {
    if (!session || cycle % 720 === 0) await authenticate();

    log("📊 Lade Marktpreise…");
    const marketData = await fetchPrices();

    const { account, positions } = await fetchAccountData();
    const balance = account?.balance?.balance ?? TOTAL_CAPITAL;
    log(`💰 Balance: CHF ${fmt(balance)} | Positionen: ${positions.length}`);

    if (cycle % 5 === 1) {
      log("🐦 Lese Markt-Sentiment…");
      try {
        xSentiment = await fetchXSentiment();
        log(`✅ Sentiment geladen`);
      } catch(e) { log(`⚠️ Sentiment: ${e.message}`); }
    }

    log("🧠 KI analysiert…");
    const brain = await askClaudeBrain({ marketData, positions, balance });
    log(`🎯 ${brain.decisions?.length ?? 0} Aktionen | Risiko: ${brain.riskLevel}`);
    if (brain.marketSummary) log(`📝 ${brain.marketSummary}`);

    for (const d of (brain.decisions ?? [])) {
      if (d.confidence >= MIN_CONFIDENCE) {
        await executeTrade(d, positions);
        await sleep(600);
      } else {
        log(`⏭️  ${d.epic}: Konfidenz zu niedrig (${d.confidence}%)`);
      }
    }

    log(`✅ Zyklus #${cycle} fertig. Nächster in ${POLL_MS/1000}s`);
  } catch(e) {
    log(`❌ FEHLER: ${e.message}`);
    if (e.message.includes("401") || e.message.includes("403")) {
      session = null;
      log("🔄 Session reset");
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════
async function main() {
  log("⚡ NeuralTrade Bot startet…");
  log(`📡 API: ${CAPITAL_BASE}`);
  log(`⏱️  Intervall: ${POLL_MS/1000}s`);

  const missing = [];
  if (!API_KEY)       missing.push("CAPITAL_API_KEY");
  if (!IDENTIFIER)    missing.push("CAPITAL_IDENTIFIER");
  if (!PASSWORD)      missing.push("CAPITAL_PASSWORD");
  if (!ANTHROPIC_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    console.error(`❌ Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
    process.exit(1);
  }

  await telegramApi("🤖 <b>NeuralTrade gestartet</b>\n⚡ Läuft 24/7 auf Railway\n⏱️ Alle 30 Sekunden");
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
