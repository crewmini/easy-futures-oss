// 웹 UI 단독 검증용 가짜 API (docs/api-contract.md v0.2). 실제 서버 대신 8790 포트.
// 실행: node web/dev/mock-api.mjs  → vite는 API_TARGET=http://localhost:8790 로 프록시
import http from 'node:http';
const PORT = 8790;
const contracts = {
  BTCUSDT: { symbol: 'BTCUSDT', contractSize: 0.001, pricePrecision: 0.1, volPrecision: 1, minVolume: 1, maxLeverage: 200 },
  ETHUSDT: { symbol: 'ETHUSDT', contractSize: 0.001, pricePrecision: 0.01, volPrecision: 1, minVolume: 1, maxLeverage: 200 },
};
const prices = { BTCUSDT: { last: 96010, mark: 96012, change24hPct: 1.2, updatedAt: Date.now() }, ETHUSDT: { last: 3120.5, mark: 3120.4, change24hPct: -0.8, updatedAt: Date.now() } };
// 실제 공개 시세로 동기화 (브라우저의 WS 직결 가격과 맞추기 위해)
async function syncPrices() { try { const r = await fetch('https://cloud-api.wooxpro.com/contract/public/details'); const j = await r.json(); for (const s of j?.data?.symbols ?? []) { if (prices[s.symbol] && s.index_price) { prices[s.symbol].last = Number(s.index_price); prices[s.symbol].mark = Number(s.index_price); prices[s.symbol].change24hPct = Number(s.change_24h) * 100; prices[s.symbol].updatedAt = Date.now(); } } } catch (e) { console.log('price sync failed', e.message); } tick(); }
syncPrices(); setInterval(syncPrices, 3000);
let settings = { mode: 'paper', maxLeverage: 10, maxAmountUsdt: 500, usdtKrw: 1380 };
let balance = 1000; let positions = []; let loggedIn = false; let hasKey = false;
const liq = (e, l, d) => d === 'long' ? e * (1 - 1 / l + 0.005) : e * (1 + 1 / l - 0.005);
function view(p) { const diff = p.direction === 'long' ? prices[p.symbol].mark - p.entryPrice : p.entryPrice - prices[p.symbol].mark; const pnl = diff * p.coinAmount; return { ...p, markPrice: prices[p.symbol].mark, unrealizedPnl: pnl, unrealizedPct: pnl / p.marginUsdt * 100 }; }
function tick() { for (const p of [...positions]) { const m = prices[p.symbol].mark; const hit = p.direction === 'long' ? (p.stopLossPrice && m <= p.stopLossPrice) || (p.takeProfitPrice && m >= p.takeProfitPrice) : (p.stopLossPrice && m >= p.stopLossPrice) || (p.takeProfitPrice && m <= p.takeProfitPrice); if (hit) close(p.symbol); } }
function close(symbol) { const p = positions.find((x) => x.symbol === symbol); if (!p) return; balance += p.marginUsdt + view(p).unrealizedPnl; positions = positions.filter((x) => x.symbol !== symbol); }
function state() { const ps = positions.map(view); const un = ps.reduce((a, p) => a + p.unrealizedPnl, 0); const pm = ps.reduce((a, p) => a + p.marginUsdt, 0); return { mode: settings.mode, connected: true, wallet: { currency: 'USDT', available: balance, equity: balance + pm + un, unrealized: un, positionMargin: pm }, positions: ps, contracts, prices, settings, serverTime: Date.now() }; }
const me = () => ({ loginId: 'test1', hasApiKey: hasKey, apiKeyPreview: hasKey ? 'abc123…' : null, mode: settings.mode });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c; const j = body ? JSON.parse(body) : {};
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = url.pathname, m = req.method;
  console.log(m, p, body.slice(0, 120));
  if (p === '/api/health') return send(200, { ok: true, serverTime: Date.now() });
  if (p === '/api/klines') { const out = []; let c = prices[url.searchParams.get('symbol')].last * 0.98; for (let i = 0; i < 96; i++) { c *= 1 + (Math.random() - 0.48) * 0.004; out.push({ t: Date.now() - (96 - i) * 900000, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); } return send(200, out); }
  if (p === '/api/auth/signup' || p === '/api/auth/login') { if (j.password === 'bad') return send(400, { error: '아이디 또는 비밀번호가 틀렸어요' }); loggedIn = true; return send(200, me()); }
  if (p === '/api/auth/logout') { loggedIn = false; return send(200, { ok: true }); }
  if (!loggedIn) return send(401, { error: '로그인이 필요해요' });
  if (p === '/api/auth/me') return send(200, me());
  if (p === '/api/keys' && m === 'PUT') { if (j.apiKey === 'bad') return send(400, { error: '거래소가 키를 거절했어요: internal auth error' }); hasKey = true; return send(200, { ok: true, apiKeyPreview: j.apiKey.slice(0, 6) + '…' }); }
  if (p === '/api/keys' && m === 'DELETE') { hasKey = false; settings.mode = 'paper'; return send(200, { ok: true }); }
  if (p === '/api/state') return send(200, state());
  if (p === '/api/settings' && m === 'GET') return send(200, settings);
  if (p === '/api/settings' && m === 'PUT') { if (j.mode === 'live' && !hasKey) return send(400, { error: '먼저 거래소 API 키를 연결해 주세요' }); settings = { ...settings, ...j }; return send(200, settings); }
  if (p === '/api/paper/reset') { balance = 1000; positions = []; return send(200, { ok: true }); }
  if (p === '/api/order/open') {
    const c = contracts[j.symbol], px = prices[j.symbol].last; const n = Math.floor(j.amountUsdt * j.leverage / (px * c.contractSize));
    if (n < 1) return send(400, { error: '금액이 너무 적어요' }); if (j.amountUsdt > balance) return send(400, { error: '쓸 수 있는 돈이 부족해요' });
    if (j.direction === 'long' ? j.stopLossPrice >= px : j.stopLossPrice <= px) return send(400, { error: '손절가는 현재가보다 ' + (j.direction === 'long' ? '낮아야' : '높아야') + ' 해요' });
    const ex = positions.find((x) => x.symbol === j.symbol); if (ex && ex.direction !== j.direction) return send(400, { error: '반대 방향 포지션이 있어요. 먼저 정리해 주세요' });
    const coin = n * c.contractSize; balance -= j.amountUsdt + coin * px * 0.0005;
    if (ex) { const tot = ex.coinAmount + coin; ex.entryPrice = (ex.entryPrice * ex.coinAmount + px * coin) / tot; ex.coinAmount = tot; ex.contracts += n; ex.marginUsdt += j.amountUsdt; ex.notionalUsdt = tot * ex.entryPrice; ex.stopLossPrice = j.stopLossPrice; ex.takeProfitPrice = j.takeProfitPrice ?? ex.takeProfitPrice; ex.liquidationPrice = liq(ex.entryPrice, ex.leverage, ex.direction); }
    else positions.push({ symbol: j.symbol, direction: j.direction, contracts: n, coinAmount: coin, entryPrice: px, markPrice: px, leverage: j.leverage, marginUsdt: j.amountUsdt, notionalUsdt: coin * px, unrealizedPnl: 0, unrealizedPct: 0, liquidationPrice: liq(px, j.leverage, j.direction), stopLossPrice: j.stopLossPrice, takeProfitPrice: j.takeProfitPrice ?? null, openedAt: Date.now() });
    return send(200, { orderId: String(Date.now()), contracts: n, coinAmount: coin, entryPrice: px });
  }
  if (p === '/api/position/close') { close(j.symbol); return send(200, { ok: true }); }
  if (p === '/api/position/tpsl') { const x = positions.find((q) => q.symbol === j.symbol); if (!x) return send(404, { error: '포지션이 없어요' }); if (j.stopLossPrice !== undefined) x.stopLossPrice = j.stopLossPrice; if (j.takeProfitPrice !== undefined) x.takeProfitPrice = j.takeProfitPrice; return send(200, { ok: true }); }
  send(404, { error: 'not found' });
}).listen(PORT, () => console.log('mock api on', PORT));
