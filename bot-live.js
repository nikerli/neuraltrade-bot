// ════════════════════════════════════════════════════════════════
//  NEURALTRADE BOT  –  Node.js Backend für Railway
//  Capital.com Live API · Claude AI Brain · Telegram Alerts
// ════════════════════════════════════════════════════════════════

const CAPITAL_BASE   = process.env.CAPITAL_BASE ?? "https://api-capital.backend-capital.com/";
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

// ── Watchlist ────────────────────────────────────────────────────
const WATCHLIST = [
  { epic: "GOLD",    name: "Gold",       emoji: "🥇" },
  { epic: "SILVER",  name: "Silber",     emoji: "🥈" },
  { epic: "BTCUSD",  name: "Bitcoin",    emoji: "₿"  },
  { epic: "ETHUSD",  name: "Ethereum",   emoji: "Ξ"  },
  { epic: "EURUSD",  name: "EUR/USD",    emoji: "💶" },
  { epic: "US500",   name: "S&P 500",    emoji: "📈" },
  { epic: "NVDA",    name: "NVIDIA",     emoji: "🤖" },
  { epic: "NATGAS",  name: "Erdgas",     emoji: "⛽" },
];

const EARNINGS_CONTEXT = {
  NVDA:   "NVIDIA Q1 2026: Beat estimates +12%, Revenue $26B, EPS $0.96. AI demand surging.",
  US500:  "S&P500 Q1 2026: 78% beat EPS. Tech sector outperforming.",
  BTCUSD: "BTC Halving April 2024 complete. ETF inflows $35B+ YTD.",
  GOLD:   "Gold at highs – central bank buying + geopolitical tension.",
  EURUSD: "ECB rates steady. USD weakening on Fed pivot expectations.",
};

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════
let session      = null;   // { cst, securityToken }
let priceHistory = {};     // { epic: [prices…] }
let cycle        = 0;
let xSentiment   = "";

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
const fmt  = (n, d=2) => n == null ? "–" : Number(n).toFixed(d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log  = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function capitalApi(method, path, body) {
  const headers = {
    "Content-Type":    "application/json",
    "X-CAP-API-KEY":   API_KEY,
  };
  if (session?.cst)           headers["CST"]               = session.cst;
  if (session?.securityToken) headers["X-SECURITY-TOKEN"]   = session.securityToken;

  const res = await fetch(`${CAPITAL_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Capital ${res.status} ${path}: ${text.slice(0,300)}`);
  return text ? JSON.parse(text) : {};
}

// ════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ════════════════════════════════════════════════════════════════
function calcIndicators(prices) {
  if (!prices || prices.length < 2) return {};
  const ma = n => prices.length >= n ? prices.slice(-n).reduce((a,b)=>a+b,0)/n : null;

  let gains = 0, losses = 0;
  const period = Math.min(14, prices.length - 1);
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period, avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = Math.round(100 - 100 / (1 + rs));

  return { ma5: ma(5), ma13: ma(13), ma21: ma(21), rsi };
}

// ════════════════════════════════════════════════════════════════
//  TELEGRAM
// ════════════════════════════════════════════════════════════════
async function telegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: "HTML" }),
    });
    log(`📱 Telegram gesendet`);
  } catch (e) { log(`⚠️ Telegram Fehler: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  AUTHENTICATE
// ════════════════════════════════════════════════════════════════
async function authenticate() {
  log("🔐 Authentifiziere bei Capital.com…");
  const data = await capitalApi("POST", "/session", { identifier: IDENTIFIER, password: PASSWORD });
  session = {
    cst:           data.clientSessionToken ?? data.cst,
    securityToken: data.securityToken,
  };
  log("✅ Session aktiv");
}

// ════════════════════════════════════════════════════════════════
//  FETCH PRICES
// ════════════════════════════════════════════════════════════════
async function fetchPrices() {
  const marketData = {};
  for (const inst of WATCHLIST) {
    try {
      const data = await capitalApi("GET", `/markets/${inst.epic}`);
      const snap = data.snapshot ?? {};
      const mid = snap.bid && snap.offer ? (snap.bid + snap.offer) / 2 : null;
      marketData[inst.epic] = { bid: snap.bid, offer: snap.offer, mid, name: inst.name, emoji: inst.emoji };
      if (mid) {
        priceHistory[inst.epic] = [...(priceHistory[inst.epic] ?? []), mid].slice(-30);
      }
    } catch (e) { log(`⚠️ ${inst.epic}: ${e.message}`); }
    await sleep(200);
  }
  return marketData;
}

// ════════════════════════════════════════════════════════════════
//  FETCH POSITIONS & ACCOUNT
// ════════════════════════════════════════════════════════════════
async function fetchAccountData() {
  const [accRes, posRes] = await Promise.allSettled([
    capitalApi("GET", "/accounts"),
    capitalApi("GET", "/positions"),
  ]);
  const account   = accRes.status  === "fulfilled" ? accRes.value.accounts?.[0]  : null;
  const positions = posRes.status  === "fulfilled" ? posRes.value.positions ?? [] : [];
  return { account, positions };
}

// ════════════════════════════════════════════════════════════════
//  X/TWITTER SENTIMENT  (via Claude web search)
// ════════════════════════════════════════════════════════════════
async function fetchXSentiment() {
  if (!ANTHROPIC_KEY) return "Kein Anthropic Key – Sentiment übersprungen.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "x-api-key":     ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Search X/Twitter and financial news RIGHT NOW for sentiment on: Gold, Bitcoin, Ethereum, NVIDIA, S&P500, EUR/USD, Natural Gas, Silver.
Give me a concise 3-sentence German summary of current trader sentiment. Include any breaking news that could affect prices.`,
      }],
    }),
  });
  const data = await res.json();
  return data.content?.find(b => b.type === "text")?.text ?? "Keine Daten.";
}

// ════════════════════════════════════════════════════════════════
//  CLAUDE AI BRAIN
// ════════════════════════════════════════════════════════════════
async function askClaudeBrain({ marketData, positions, balance }) {
  if (!ANTHROPIC_KEY) {
    log("⚠️ Kein ANTHROPIC_API_KEY – KI übersprungen");
    return { decisions: [], marketSummary: "", riskLevel: "MEDIUM" };
  }

  const enriched = {};
  for (const [epic, d] of Object.entries(marketData)) {
    enriched[epic] = { ...d, ...calcIndicators(priceHistory[epic] ?? []) };
  }

  const prompt = `You are an autonomous trading AI managing a CHF ${TOTAL_CAPITAL} portfolio with 1:1 leverage on Capital.com.

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

FUNDAMENTALS & EARNINGS:
${JSON.stringify(EARNINGS_CONTEXT, null, 2)}

X/TWITTER SENTIMENT:
${xSentiment}

RULES:
- Never risk more than 18% per instrument
- Diversify across asset classes
- Use RSI: >70 overbought (consider SELL), <30 oversold (consider BUY)
- MA crossover: MA5 > MA13 = bullish, MA5 < MA13 = bearish
- Combine technical + sentiment + fundamental signals
- Only trade when signals align (2+ factors agree)

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "decisions": [
    {
      "epic": "GOLD",
      "action": "BUY",
      "size": 0.5,
      "confidence": 82,
      "reason": "Kurze Begründung auf Deutsch max 10 Wörter"
    }
  ],
  "marketSummary": "2-3 Sätze Marktüberblick auf Deutsch",
  "riskLevel": "LOW"
}

Only include epics with BUY or SELL. Omit HOLD. Be decisive.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const raw  = data.content?.find(b => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    log(`⚠️ JSON Parse Fehler: ${e.message} – Raw: ${clean.slice(0,200)}`);
    return { decisions: [], marketSummary: "", riskLevel: "MEDIUM" };
  }
}

// ════════════════════════════════════════════════════════════════
//  EXECUTE TRADE DECISION
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

  // Close opposite position first
  if (existingPos) {
    const dealId = existingPos.position?.dealId;
    const upl    = existingPos.position?.upl ?? 0;
    try {
      await capitalApi("DELETE", `/positions/${dealId}`);
      const emoji = upl >= 0 ? "✅" : "❌";
      log(`${emoji} CLOSE ${existingDir} ${epic} | P&L: CHF ${fmt(upl)}`);

      const tgMsg = upl >= 0
        ? `🟢 <b>GEWINN!</b>\n${inst?.emoji} ${inst?.name}\n💰 +CHF ${fmt(upl)}\n📝 ${reason}`
        : `🔴 <b>VERLUST</b>\n${inst?.emoji} ${inst?.name}\n💸 -CHF ${fmt(Math.abs(upl))}\n📝 ${reason}`;
      await telegram(tgMsg);
    } catch (e) {
      log(`❌ Close ${epic} fehlgeschlagen: ${e.message}`);
    }
    await sleep(400);
  }

  // Open new position
  const tradeSize = Math.max(0.1, Math.min(size, TOTAL_CAPITAL * MAX_POS_PCT));
  try {
    await capitalApi("POST", "/positions", {
      epic,
      direction:      action,
      size:           tradeSize,
      guaranteedStop: false,
      trailingStop:   false,
    });
    const emoji = action === "BUY" ? "🟢" : "🔴";
    log(`${emoji} ${action} ${epic} | Größe: ${tradeSize} | Konfidenz: ${confidence}% | ${reason}`);

    await telegram(
      `${emoji} <b>NEUER TRADE</b>\n${inst?.emoji} ${inst?.name} (${epic})\n📍 ${action} · Größe: ${tradeSize}\n🎯 Konfidenz: ${confidence}%\n💭 ${reason}`
    );
  } catch (e) {
    log(`❌ Open ${epic} fehlgeschlagen: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  MAIN TICK
// ════════════════════════════════════════════════════════════════
async function tick() {
  cycle++;
  log(`\n━━━ ZYKLUS #${cycle} ━━━`);

  try {
    // Re-authenticate every 6 hours (session expiry)
    if (!session || cycle % 720 === 0) await authenticate();

    // 1. Market prices
    log("📊 Lade Marktpreise…");
    const marketData = await fetchPrices();

    // 2. Account + positions
    const { account, positions } = await fetchAccountData();
    const balance = account?.balance?.balance ?? TOTAL_CAPITAL;
    log(`💰 Balance: CHF ${fmt(balance)} | Offene Pos: ${positions.length}`);

    // 3. X Sentiment every 5 cycles (~2.5min)
    if (cycle % 5 === 1) {
      log("🐦 Lese X/Twitter Sentiment…");
      xSentiment = await fetchXSentiment();
      log(`✅ Sentiment: ${xSentiment.slice(0,80)}…`);
    }

    // 4. Ask Claude
    log("🧠 KI analysiert Märkte…");
    const brain = await askClaudeBrain({ marketData, positions, balance });
    log(`🎯 KI: ${brain.decisions?.length ?? 0} Aktionen | Risiko: ${brain.riskLevel}`);
    if (brain.marketSummary) log(`📝 ${brain.marketSummary}`);

    // 5. Execute
    for (const decision of (brain.decisions ?? [])) {
      if (decision.confidence >= MIN_CONFIDENCE) {
        await executeTrade(decision, positions);
        await sleep(600);
      } else {
        log(`⏭️  ${decision.epic}: Konfidenz zu niedrig (${decision.confidence}%)`);
      }
    }

    log(`✅ Zyklus #${cycle} abgeschlossen. Nächster in ${POLL_MS/1000}s`);

  } catch (e) {
    log(`❌ FEHLER: ${e.message}`);
    // Reset session on auth errors
    if (e.message.includes("401") || e.message.includes("403")) {
      session = null;
      log("🔄 Session zurückgesetzt – wird beim nächsten Tick neu authentifiziert");
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════════════════════════
async function main() {
  log("⚡ NeuralTrade Bot startet…");
  log(`📡 API: ${CAPITAL_BASE}`);
  log(`⏱️  Intervall: ${POLL_MS/1000}s`);

  // Validate env
  const missing = [];
  if (!API_KEY)      missing.push("CAPITAL_API_KEY");
  if (!IDENTIFIER)   missing.push("CAPITAL_IDENTIFIER");
  if (!PASSWORD)     missing.push("CAPITAL_PASSWORD");
  if (!ANTHROPIC_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    console.error(`❌ Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
    process.exit(1);
  }

  await telegram("🤖 <b>NeuralTrade Bot gestartet</b>\n⚡ Läuft 24/7 auf Railway\n⏱️ Analysiert alle 30 Sekunden");

  // First tick immediately, then every 30s
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
