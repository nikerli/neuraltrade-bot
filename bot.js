// ════════════════════════════════════════════════════════════════
//  NEURALTRADE BOT  –  Regelbasiert (ohne KI)
//  Capital.com Live API · RSI + MA Crossover · Telegram Alerts
//
//  STRATEGIE (für Schulprojekt-Doku):
//  Ein Trade wird nur ausgelöst wenn MEHRERE Signale übereinstimmen.
//  Das reduziert Fehlsignale ("Confluence"-Prinzip).
//
//  KAUFSIGNAL (BUY) wenn:
//    - RSI < 35 (überverkauft) UND
//    - MA5 > MA13 (kurzfristiger Aufwärtstrend)
//  VERKAUFSIGNAL (SELL) wenn:
//    - RSI > 65 (überkauft) UND
//    - MA5 < MA13 (kurzfristiger Abwärtstrend)
//
//  Take Profit: automatisch 3% (kein Stop Loss gesetzt)
// ════════════════════════════════════════════════════════════════
import https from "https";
import http  from "http";

const CAPITAL_BASE   = process.env.CAPITAL_BASE ?? "https://api-capital.backend-capital.com/api/v1";
const API_KEY        = process.env.CAPITAL_API_KEY;
const IDENTIFIER     = process.env.CAPITAL_IDENTIFIER;
const PASSWORD       = process.env.CAPITAL_PASSWORD;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const POLL_MS        = 10_000;
const TOTAL_CAPITAL  = 50;
const MAX_POS_PCT    = 0.18;

// ── Strategie-Parameter (anpassbar) ───────────────────────────
const RSI_OVERSOLD   = 35;    // unter diesem Wert = Kaufzone
const RSI_OVERBOUGHT = 65;    // über diesem Wert = Verkaufszone
const STOP_LOSS_PCT  = 0.02;  // 2% Stop Loss
const TAKE_PROFIT_PCT = 0.03; // 3% Take Profit (1.5:1)
const MIN_HISTORY    = 14;    // Mindest-Datenpunkte für RSI

// ── Instrumente die der Bot beobachtet ────────────────────────
const WATCHLIST = [
  { epic: "GOLD",       name: "Gold",      emoji: "🥇" },
  { epic: "SILVER",     name: "Silber",    emoji: "🥈" },
  { epic: "BTCUSD",     name: "Bitcoin",   emoji: "₿"  },
  { epic: "ETHUSD",     name: "Ethereum",  emoji: "Ξ"  },
  { epic: "EURUSD",     name: "EUR/USD",   emoji: "💶" },
  { epic: "US500",      name: "S&P 500",   emoji: "📈" },
  { epic: "OIL_CRUDE",  name: "Rohöl",     emoji: "🛢️" },
];

// ── State ─────────────────────────────────────────────────────
let session      = null;
let priceHistory = {};
let cycle        = 0;

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

// ── Helpers ────────────────────────────────────────────────────
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

async function telegramApi(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { method: "POST" },
      { chat_id: TELEGRAM_CHAT, text: msg, parse_mode: "HTML" });
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
//  PREISE LADEN
// ════════════════════════════════════════════════════════════════
async function fetchPrices() {
  const out = {};
  for (const inst of WATCHLIST) {
    try {
      const data = await capitalApi("GET", `/markets/${inst.epic}`);
      const snap = data.snapshot ?? {};
      const mid  = snap.bid && snap.offer ? (snap.bid + snap.offer) / 2 : null;
      out[inst.epic] = { bid: snap.bid, offer: snap.offer, mid };
      if (mid) priceHistory[inst.epic] = [...(priceHistory[inst.epic] ?? []), mid].slice(-50);
    } catch(e) { log(`⚠️ ${inst.epic}: ${e.message}`); }
    await sleep(150);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
//  TECHNISCHE INDIKATOREN
// ════════════════════════════════════════════════════════════════
function calcIndicators(prices) {
  if (!prices || prices.length < 2) return null;
  const ma = n => prices.length >= n ? prices.slice(-n).reduce((a,b)=>a+b,0)/n : null;
  const period = Math.min(14, prices.length - 1);
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const rs  = losses === 0 ? 100 : (gains/period)/(losses/period);
  const rsi = Math.round(100 - 100/(1+rs));
  return { ma5: ma(5), ma13: ma(13), rsi };
}

// ════════════════════════════════════════════════════════════════
//  REGELBASIERTE STRATEGIE  ←  HERZSTÜCK (kein KI)
// ════════════════════════════════════════════════════════════════
function decideSignal(epic, prices) {
  if (!prices || prices.length < MIN_HISTORY) return null;  // zu wenig Daten
  const ind = calcIndicators(prices);
  if (!ind || ind.ma5 == null || ind.ma13 == null) return null;

  const { rsi, ma5, ma13 } = ind;
  const trendUp   = ma5 > ma13;
  const trendDown = ma5 < ma13;

  // KAUFSIGNAL: überverkauft + Aufwärtstrend
  if (rsi < RSI_OVERSOLD && trendUp) {
    return {
      action: "BUY",
      reason: `RSI ${rsi} (überverkauft) + MA5>MA13 (Aufwärtstrend)`,
      rsi, ma5, ma13,
    };
  }
  // VERKAUFSIGNAL: überkauft + Abwärtstrend
  if (rsi > RSI_OVERBOUGHT && trendDown) {
    return {
      action: "SELL",
      reason: `RSI ${rsi} (überkauft) + MA5<MA13 (Abwärtstrend)`,
      rsi, ma5, ma13,
    };
  }
  return null;  // kein klares Signal → nichts tun
}

// ════════════════════════════════════════════════════════════════
//  ACCOUNT + POSITIONEN
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
//  TRADE AUSFÜHREN
// ════════════════════════════════════════════════════════════════
async function executeTrade(epic, signal, positions, balance) {
  const inst        = WATCHLIST.find(w => w.epic === epic);
  const existingPos = positions.find(p => p.market?.epic === epic);
  const existingDir = existingPos?.position?.direction;
  const { action, reason } = signal;

  if (existingDir === action) {
    return; // schon offen in dieselbe Richtung
  }

  // Gegenposition schliessen
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

${inst?.emoji} <b>${inst?.name}</b> (${epic})
📍 War: ${existingDir}
📦 Anteile: ${closedSize}
${closedVal ? `💵 Wert: CHF ${fmt(closedVal)}` : ""}
${win ? `✅ Gewinn: +CHF ${fmt(upl)}` : `❌ Verlust: -CHF ${fmt(Math.abs(upl))}`}

💼 Aktueller Saldo: CHF ${fmt(newSaldo)}`);
    } catch(e) { log(`❌ Close ${epic}: ${e.message}`); }
    await sleep(400);
  }

  // Position-Grösse berechnen
  const lastPrice = (priceHistory[epic] ?? []).slice(-1)[0] ?? 0;
  if (!lastPrice) { log(`⚠️ ${epic}: kein Preis`); return; }

  const maxChf    = TOTAL_CAPITAL * MAX_POS_PCT;
  const tradeSize = Math.max(0.1, +(maxChf / lastPrice).toFixed(2));

  // Nur Take Profit – kein Stop Loss
  const takeProfit = action === "BUY"
    ? lastPrice * (1 + TAKE_PROFIT_PCT)
    : lastPrice * (1 - TAKE_PROFIT_PCT);

  const posBody = {
    epic, direction: action, size: tradeSize,
    guaranteedStop: false, trailingStop: false,
    profitLevel: +takeProfit.toFixed(4),
  };

  try {
    await capitalApi("POST", "/positions", posBody);
    const emoji    = action === "BUY" ? "🟢" : "🔴";
    const dirLabel = action === "BUY" ? "GEKAUFT" : "VERKAUFT (SHORT)";
    const tradeVal = tradeSize * lastPrice;
    log(`${emoji} ${action} ${epic} | ${tradeSize} Stk @ ${fmt(lastPrice,4)} | ${reason}`);
    await telegramApi(
`${emoji} <b>${dirLabel}</b>

${inst?.emoji} <b>${inst?.name}</b> (${epic})
📍 Richtung: ${action}
📦 Anteile: ${tradeSize}
💵 Wert: ~CHF ${fmt(tradeVal)}
✅ Take Profit: ${fmt(takeProfit, 4)}

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
    if (!session || cycle % 2160 === 0) await authenticate();

    // Preise laden
    const marketData = await fetchPrices();

    // Account + Positionen
    const { account, positions } = await fetchAccountData();
    const balance = account?.balance?.balance ?? TOTAL_CAPITAL;
    log(`💰 Balance: CHF ${fmt(balance)} | Offene Pos: ${positions.length}`);

    // Für jedes Instrument: Signal prüfen
    let signalsFound = 0;
    for (const inst of WATCHLIST) {
      const prices = priceHistory[inst.epic] ?? [];
      const signal = decideSignal(inst.epic, prices);
      if (signal) {
        signalsFound++;
        log(`📊 ${inst.epic}: ${signal.action} – ${signal.reason}`);
        await executeTrade(inst.epic, signal, positions, balance);
        await sleep(500);
      }
    }
    if (signalsFound === 0) {
      const ready = Object.values(priceHistory).filter(p => p.length >= MIN_HISTORY).length;
      log(`⏸  Kein Signal. (${ready}/${WATCHLIST.length} Instrumente mit genug Daten)`);
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
  log("⚡ NeuralTrade Bot startet… (Regelbasiert, ohne KI)");
  log(`📡 API: ${CAPITAL_BASE}`);
  log(`⏱️  Intervall: ${POLL_MS/1000}s`);
  log(`📐 Strategie: RSI(${RSI_OVERSOLD}/${RSI_OVERBOUGHT}) + MA5/MA13 Crossover`);

  const missing = [];
  if (!API_KEY)     missing.push("CAPITAL_API_KEY");
  if (!IDENTIFIER)  missing.push("CAPITAL_IDENTIFIER");
  if (!PASSWORD)    missing.push("CAPITAL_PASSWORD");
  if (missing.length) { console.error(`❌ Fehlende Vars: ${missing.join(", ")}`); process.exit(1); }

  await telegramApi("🤖 <b>NeuralTrade gestartet</b>\n📐 Regelbasiert (RSI + MA Crossover)\n⚡ Läuft 24/7 auf Railway\n⏱️ Prüft alle 10 Sekunden");
  await tick();
  setInterval(tick, POLL_MS);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
