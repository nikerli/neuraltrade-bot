// ════════════════════════════════════════════════════════════════
//  NEURALTRADE BOT  –  Node.js Backend für Railway
//  Capital.com Live API · Claude AI Brain · Volle Autonomie
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
const POLL_MS        = 10_000;
const MAX_POS_PCT    = 0.18;
const MIN_CONFIDENCE = 65;
const TOTAL_CAPITAL  = 50;

// ── State ─────────────────────────────────────────────────────
let session      = null;
let priceHistory = {};   // { epic: [prices…] }
let cycle        = 0;
let newsContext  = "";   // latest market news from Claude web search
let activeEpics  = [];   // epics the AI chose this cycle

// ════════════════════════════════════════════════════════════════
//  NATIVE HTTP
// ════════════════════════════════════════════════════════════════
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + (parsed.search ?? ""),
      method:   options.method ?? "GET",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
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
  if (res.status < 200 || res.status >= 300)
    throw new Error(`Capital ${res.status} ${method} ${path}: ${res.body.slice(0,200)}`);
  const parsed = res.body ? JSON.parse(res.body) : {};
  parsed._resHeaders = res.headers;
  return parsed;
}

async function anthropicApi(payload) {
  const res = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
  }, payload);
  if (res.status < 200 || res.status >= 300)
    throw new Error(`Anthropic ${res.status}: ${res.body.slice(0,200)}`);
  return JSON.parse(res.body);
}

async function telegramApi(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { method: "POST" },
      { chat_id: TELEGRAM_CHAT, text: msg, parse_mode: "HTML" }
    );
    log("📱 Telegram gesendet");
  } catch(e) { log(`⚠️ Telegram: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════
async function authenticate() {
  log("🔐 Authentifiziere bei Capital.com…");
  const data = await capitalApi("POST", "/session", { identifier: IDENTIFIER, password: PASSWORD });
  const h = data._resHeaders ?? {};
  const cst           = h["cst"]             ?? data.clientSessionToken ?? data.cst;
  const securityToken = h["x-security-token"] ?? data.securityToken;
  session = { cst, securityToken };
  log(`✅ Session aktiv | CST: ${cst ? cst.slice(0,8)+"…" : "FEHLT"}`);
  if (!cst || !securityToken) throw new Error("Session-Tokens fehlen – prüfe API Key");
}

// ════════════════════════════════════════════════════════════════
//  STEP 1 – KI WÄHLT INSTRUMENTE (web search)
// ════════════════════════════════════════════════════════════════
async function aiPickInstruments() {
  log("🌐 KI sucht beste Handelsmöglichkeiten…");
  const data = await anthropicApi({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content:
      `You are a trading AI. Search the web RIGHT NOW for:
      1. Breaking financial news and market-moving events today
      2. Best trading opportunities across ALL asset classes (crypto, forex, stocks, commodities, indices)
      3. Which instruments have the most momentum or volatility right now

      Based on what you find, return ONLY a JSON array of the 5-8 best Capital.com epic codes to trade right now.
      Use exact Capital.com epic codes like: GOLD, SILVER, BTCUSD, ETHUSD, EURUSD, GBPUSD, US500, GER40, NVDA, AAPL, TSLA, OIL_CRUDE, NATURALGAS, JPYUSD, XRPUSD, SOLUSD, etc.

      Also return a brief German news summary.

      Respond ONLY with this JSON (no markdown):
      {"epics":["GOLD","BTCUSD","NVDA"],"newsSummary":"Kurze deutsche Zusammenfassung der wichtigsten Nachrichten"}`
    }],
  });

  const text = data.content?.find(b => b.type === "text")?.text ?? "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    const result = JSON.parse(clean);
    newsContext = result.newsSummary ?? "";
    activeEpics = result.epics ?? [];
    log(`📰 News: ${newsContext.slice(0,80)}…`);
    log(`🎯 KI wählte ${activeEpics.length} Instrumente: ${activeEpics.join(", ")}`);
    return activeEpics;
  } catch(e) {
    log(`⚠️ Instrument-Auswahl fehlgeschlagen: ${e.message}`);
    // Fallback zu Standard-Instrumenten
    return ["GOLD", "BTCUSD", "EURUSD", "US500", "NVDA"];
  }
}

// ════════════════════════════════════════════════════════════════
//  STEP 2 – PREISE LADEN für gewählte Instrumente
// ════════════════════════════════════════════════════════════════
async function fetchPrices(epics) {
  const out = {};
  for (const epic of epics) {
    try {
      const data = await capitalApi("GET", `/markets/${epic}`);
      const snap = data.snapshot ?? {};
      const mid  = snap.bid && snap.offer ? (snap.bid + snap.offer) / 2 : null;
      out[epic] = { bid: snap.bid, offer: snap.offer, mid, spread: snap.offer - snap.bid };
      if (mid) priceHistory[epic] = [...(priceHistory[epic] ?? []), mid].slice(-50);
    } catch(e) { log(`⚠️ ${epic}: ${e.message}`); }
    await sleep(150);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ════════════════════════════════════════════════════════════════
function calcIndicators(prices) {
  if (!prices || prices.length < 2) return {};
  const ma = n => prices.length >= n ? prices.slice(-n).reduce((a,b)=>a+b,0)/n : null;
  const period = Math.min(14, prices.length - 1);
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const rs  = losses === 0 ? 100 : (gains/period)/(losses/period);
  const rsi = Math.round(100 - 100/(1+rs));
  const last = prices[prices.length-1];
  const prev = prices[prices.length-2];
  const change1 = prev ? ((last - prev) / prev * 100) : 0;
  return { ma5: ma(5), ma13: ma(13), ma21: ma(21), rsi, change1pct: change1.toFixed(3) };
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
//  STEP 3 – KI ENTSCHEIDET TRADES
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

LATEST MARKET NEWS (from web search):
${newsContext}

SELECTED INSTRUMENTS WITH LIVE PRICES + INDICATORS:
${JSON.stringify(enriched, null, 2)}

CURRENTLY OPEN POSITIONS:
${JSON.stringify(positions.map(p => ({
  epic: p.market?.epic,
  direction: p.position?.direction,
  size: p.position?.dealSize,
  openLevel: p.position?.openLevel,
  upl: p.position?.upl,
  dealId: p.position?.dealId,
})), null, 2)}

TRADING RULES:
- Max CHF ${fmt(TOTAL_CAPITAL * MAX_POS_PCT)} per position (18% of capital)
- Diversify across asset classes – don't put all capital in one type
- RSI >70 = overbought (lean SELL), RSI <30 = oversold (lean BUY)
- MA5 > MA13 = bullish momentum, MA5 < MA13 = bearish momentum
- Only trade when news + technical signals agree (2+ factors)
- Consider the spread cost vs expected move
- Set stopLoss and takeProfit as ABSOLUTE price levels (not %)
- For BUY: stopLoss below entry, takeProfit above entry (min 1.5:1 reward/risk)
- For SELL: stopLoss above entry, takeProfit below entry (min 1.5:1 reward/risk)

Respond ONLY with valid JSON (no markdown):
{
  "decisions": [
    {
      "epic": "GOLD",
      "action": "BUY",
      "size": 0.5,
      "confidence": 82,
      "reason": "Kurze Begründung auf Deutsch max 12 Wörter",
      "stopLoss": 1820.00,
      "takeProfit": 1965.00
    }
  ],
  "marketSummary": "2-3 Sätze Deutsch",
  "riskLevel": "LOW"
}

Only include BUY or SELL. Skip HOLD. Be decisive.`;

  const data = await anthropicApi({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const raw   = data.content?.find(b => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    log(`⚠️ JSON Parse: ${clean.slice(0,100)}`);
    return { decisions: [], marketSummary: "", riskLevel: "MEDIUM" };
  }
}

// ════════════════════════════════════════════════════════════════
//  STEP 4 – TRADES AUSFÜHREN
// ════════════════════════════════════════════════════════════════
async function executeTrade(decision, positions, balance) {
  const { epic, action, size, confidence, reason, stopLoss, takeProfit } = decision;
  const existingPos = positions.find(p => p.market?.epic === epic);
  const existingDir = existingPos?.position?.direction;

  if (existingDir === action) {
    log(`↩️  ${epic}: ${action} bereits offen – skip`);
    return;
  }

  // Close opposite position
  if (existingPos) {
    const dealId     = existingPos.position?.dealId;
    const upl        = existingPos.position?.upl ?? 0;
    const closedSize = existingPos.position?.dealSize;
    const openLevel  = existingPos.position?.openLevel;
    const closedVal  = closedSize && openLevel ? closedSize * openLevel : null;
    try {
      await capitalApi("DELETE", `/positions/${dealId}`);
      const win = upl >= 0;
      log(`${win ? "✅" : "❌"} CLOSE ${existingDir} ${epic} | P&L: CHF ${fmt(upl)}`);
      const newSaldo = balance + upl;
      await telegramApi(
`${win ? "🟢" : "🔴"} <b>POSITION GESCHLOSSEN</b>

📊 <b>${epic}</b>
📍 War: ${existingDir}
📦 Anteile: ${closedSize}
${closedVal ? `💵 Wert: CHF ${fmt(closedVal)}` : ""}
${win ? `✅ Gewinn: +CHF ${fmt(upl)}` : `❌ Verlust: -CHF ${fmt(Math.abs(upl))}`}

💼 Aktueller Saldo: CHF ${fmt(newSaldo)}
💭 ${reason}`);
    } catch(e) { log(`❌ Close ${epic}: ${e.message}`); }
    await sleep(400);
  }

  // Open new position
  const tradeSize = Math.max(0.1, Math.min(size, TOTAL_CAPITAL * MAX_POS_PCT));
  const lastPrice = (priceHistory[epic] ?? []).slice(-1)[0] ?? 0;
  const tradeVal  = lastPrice ? tradeSize * lastPrice : null;

  const posBody = {
    epic, direction: action, size: tradeSize,
    guaranteedStop: false, trailingStop: false,
  };
  if (stopLoss)   posBody.stopLevel   = stopLoss;
  if (takeProfit) posBody.profitLevel = takeProfit;

  try {
    await capitalApi("POST", "/positions", posBody);
    const emoji    = action === "BUY" ? "🟢" : "🔴";
    const dirLabel = action === "BUY" ? "GEKAUFT" : "VERKAUFT (SHORT)";
    log(`${emoji} ${action} ${epic} | ${tradeSize} Stk | SL:${stopLoss} TP:${takeProfit} | ${confidence}%`);

    await telegramApi(
`${emoji} <b>${dirLabel}</b>

📊 <b>${epic}</b>
📍 Richtung: ${action}
📦 Anteile: ${tradeSize}
${tradeVal ? `💵 Wert: ~CHF ${fmt(tradeVal)}` : ""}
🎯 Konfidenz: ${confidence}%
🛑 Stop Loss: ${stopLoss ? fmt(stopLoss, 4) : "–"}
✅ Take Profit: ${takeProfit ? fmt(takeProfit, 4) : "–"}

💼 Aktueller Saldo: CHF ${fmt(balance)}
💭 ${reason}`);
  } catch(e) { log(`❌ Open ${epic}: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  MAIN TICK
// ════════════════════════════════════════════════════════════════
async function tick() {
  cycle++;
  log(`\n━━━ ZYKLUS #${cycle} ━━━`);
  try {
    // Re-auth every 6h
    if (!session || cycle % 2160 === 0) await authenticate();

    // Every 6 cycles (~1min): KI wählt Instrumente neu via Web Search
    let epicsToTrade = activeEpics.length ? activeEpics : ["GOLD","BTCUSD","EURUSD","US500","NVDA"];
    if (cycle % 6 === 1) {
      try { epicsToTrade = await aiPickInstruments(); }
      catch(e) { log(`⚠️ Instrument-Auswahl: ${e.message}`); }
    }

    // Preise laden
    const marketData = await fetchPrices(epicsToTrade);

    // Account + Positionen
    const { account, positions } = await fetchAccountData();
    const balance = account?.balance?.balance ?? TOTAL_CAPITAL;
    log(`💰 Balance: CHF ${fmt(balance)} | Pos: ${positions.length} | Instrumente: ${epicsToTrade.join(",")}`);

    // KI entscheidet Trades
    log("🧠 KI analysiert…");
    const brain = await askClaudeBrain({ marketData, positions, balance });
    log(`🎯 ${brain.decisions?.length ?? 0} Trades | Risiko: ${brain.riskLevel}`);
    if (brain.marketSummary) log(`📝 ${brain.marketSummary}`);

    // Trades ausführen
    for (const d of (brain.decisions ?? [])) {
      if (d.confidence >= MIN_CONFIDENCE) {
        await executeTrade(d, positions, balance);
        await sleep(500);
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
  if (missing.length) { console.error(`❌ Fehlende Vars: ${missing.join(", ")}`); process.exit(1); }

  await telegramApi("🤖 <b>NeuralTrade gestartet</b>\n⚡ Läuft 24/7 auf Railway\n🧠 KI wählt Instrumente selbst\n⏱️ Analysiert alle 10 Sekunden");
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
