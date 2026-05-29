import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { fetchInvestorData } from './kis-api.js';

const app = express();
const PORT = process.env.PORT || 3000;
const YAHOO_BASE = 'https://query1.finance.yahoo.com';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check for Cloud Run
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 네이버 증권 검색 (한글 지원)
async function searchNaver(query) {
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock&count=10`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json();
  return (data.items || []).map(item => ({
    symbol: item.code + (item.typeCode === 'KOSDAQ' ? '.KQ' : '.KS'),
    shortname: item.name,
    longname: item.name,
    exchange: item.typeName,
    exchDisp: item.typeName,
    typeDisp: 'Equity',
    quoteType: 'EQUITY',
    isYahooFinance: false,
  }));
}

// 종목 검색 (Yahoo + Naver)
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json({ results: [] });

    // Yahoo Finance 검색
    const results = [];
    try {
      const url = `${YAHOO_BASE}/v1/finance/search?q=${encodeURIComponent(query)}`;
      const yRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await yRes.json();
      const yahooResults = (data.quotes || []).filter(q => q.symbol);
      results.push(...yahooResults);
    } catch (_) {}

    // Naver 검색 (한글 등 보완)
    try {
      const naverResults = await searchNaver(query);
      applyKoreanNames(results, naverResults);
      // 중복 제거 (symbol 기준)
      const existingSymbols = new Set(results.map(r => r.symbol));
      for (const nr of naverResults) {
        if (!existingSymbols.has(nr.symbol)) {
          results.push(nr);
        }
      }
    } catch (_) {}

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 종목 상세 정보
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    const chartUrl = `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=1mo`;
    const chartRes = await fetch(chartUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const chartData = await chartRes.json();

    if (chartData.chart?.error) {
      throw new Error(chartData.chart.error.description || 'Quote not found');
    }

    const result = chartData.chart.result[0];
    const meta = result.meta;
    const quotes = result.indicators.quote[0];
    const closePrices = quotes.close.filter(c => c != null);
    const volumes = quotes.volume ? quotes.volume.filter(v => v != null) : [];

    // 직전일 종가 = 마지막 완료된 거래일 종가
    const lastClose = closePrices[closePrices.length - 1];
    const prevClose = closePrices.length >= 2 ? closePrices[closePrices.length - 2] : (meta.chartPreviousClose || lastClose);

    // 장중이면 regularMarketPrice 사용, 아니면 마지막 종가
    const currentPrice = meta.regularMarketPrice || lastClose;
    const change = currentPrice - prevClose;
    const changePercent = (change / prevClose) * 100;

    // 한국 종목은 네이버에서 한글명 조회
    let krName = meta.shortName || meta.symbol;
    if ((symbol.endsWith('.KS') || symbol.endsWith('.KQ')) && meta.symbol) {
      try {
        const naverResults = await searchNaver(symbol.replace(/\.(KS|KQ)$/, ''));
        if (naverResults.length > 0 && naverResults[0].shortname) {
          krName = naverResults[0].shortname;
        }
      } catch (_) {}
    }

    res.json({
      symbol: meta.symbol,
      shortName: krName,
      longName: meta.longName || '',
      regularMarketPrice: currentPrice,
      regularMarketChange: change,
      regularMarketChangePercent: changePercent,
      regularMarketVolume: meta.regularMarketVolume || (volumes.length > 0 ? volumes[volumes.length - 1] : null),
      marketCap: null,
      currency: meta.currency || 'USD',
      exchangeName: meta.exchangeName || '',
    });
  } catch (err) {
    console.error('Quote error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 일별 상세 데이터 (최근 5거래일 OHLCV)
app.get('/api/detail/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const chartUrl = `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=10d`;
    const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const chartData = await chartRes.json();
    if (chartData.chart?.error) throw new Error(chartData.chart.error.description || 'Not found');

    const result = chartData.chart.result[0];
    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    // 최근 5영업일만 추출 (뒤에서부터 5개, null 제외)
    const days = [];
    for (let i = timestamps.length - 1; i >= 0 && days.length < 5; i--) {
      if (quote.close[i] == null) continue;
      const date = new Date(timestamps[i] * 1000);
      const prevClose = i > 0 && quote.close[i-1] != null ? quote.close[i-1] : quote.close[i];
      const change = quote.close[i] - prevClose;
      const changePercent = (change / prevClose) * 100;
      days.unshift({
        date: `${date.getMonth()+1}/${date.getDate()}`,
        close: quote.close[i],
        volume: quote.volume?.[i] || null,
        change,
        changePercent,
      });
    }

    res.json({ symbol, days });
  } catch (err) {
    console.error('Detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 투자자별 매매동향 (개인/외국인/기관 순매수) - KIS API
app.get('/api/investor/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await fetchInvestorData(symbol);
    res.json({ investor: data || [] });
  } catch (err) {
    console.error('Investor error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 스파크라인 데이터 (주봉 + 당일 틱)
app.get('/api/sparkline/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // 주봉 (일별, 최근 5거래일)
    const [weeklyRes, intradayRes] = await Promise.all([
      fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }),
      fetch(`${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=5m&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
    ]);

    const weeklyData = await weeklyRes.json();
    let weekly = [];
    if (!weeklyData.chart?.error) {
      const wq = weeklyData.chart.result[0].indicators.quote[0];
      weekly = (wq.close || []).filter(c => c != null);
    }

    const intradayData = await intradayRes.json();
    let intraday = [];
    if (!intradayData.chart?.error) {
      const iq = intradayData.chart.result[0].indicators.quote[0];
      intraday = (iq.close || []).filter(c => c != null);
    }

    res.json({ weekly, intraday });
  } catch (err) {
    console.error('Sparkline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 지수 정보 (코스피, 코스닥, 나스닥, S&P500)
const INDEX_SYMBOLS = ['^KS11', '^KQ11', '^IXIC', '^GSPC'];
const INDEX_NAMES = { '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ', '^IXIC': 'NASDAQ', '^GSPC': 'S&P500' };

app.get('/api/indices', async (req, res) => {
  try {
    const results = await Promise.all(INDEX_SYMBOLS.map(async (sym) => {
      try {
        const chartUrl = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
        const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const chartData = await chartRes.json();
        if (chartData.chart?.error) return null;

        const result = chartData.chart.result[0];
        const meta = result.meta;
        const quotes = result.indicators.quote[0];
        const closePrices = quotes.close.filter(c => c != null);

        const lastClose = closePrices[closePrices.length - 1];
        const prevClose = closePrices.length >= 2 ? closePrices[closePrices.length - 2] : (meta.chartPreviousClose || lastClose);
        const currentPrice = meta.regularMarketPrice || lastClose;
        const change = currentPrice - prevClose;
        const changePercent = (change / prevClose) * 100;

        return {
          symbol: sym,
          name: INDEX_NAMES[sym] || meta.shortName || '',
          price: currentPrice,
          change,
          changePercent,
        };
      } catch {
        return null;
      }
    }));

    res.json({ indices: results.filter(Boolean) });
  } catch (err) {
    console.error('Indices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- 주식예측 스크리너 (내일 급등 예상) ----
const NAVER_LIST_URL = 'https://m.stock.naver.com/api/stocks/marketValue';

function parseNaverNum(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/,/g, ''));
}

async function fetchNaverPage(market, page) {
  const url = `${NAVER_LIST_URL}/${market}?page=${page}&pageSize=100`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Naver ${market} HTTP ${res.status}`);
  return res.json();
}

// 한글명 보정 맵 (네이버가 영어로 표시하는 종목)

// 검색 결과에서 Naver 이름으로 Yahoo 이름 덮어쓰기
function applyKoreanNames(results, naverResults) {
  const naverMap = new Map();
  for (const nr of naverResults) {
    const code = nr.symbol ? nr.symbol.replace(/\.(KS|KQ)$/, '') : null;
    if (code) naverMap.set(nr.symbol, { name: nr.shortname, code });
  }
  for (const r of results) {
    const nr = naverMap.get(r.symbol);
    if (nr && nr.name) {
      if (/[가-힣]/.test(nr.name)) {
        r.shortname = nr.name;
        r.longname = nr.name;
      }
    }
  }
}

// RSI(5) 계산
function calcRSI(closes, period = 5) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 이동평균선 계산
function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// MFI (Money Flow Index) — 거래량 반영 과매도/과매수
function calcMFI(ohlc, period = 14) {
  if (ohlc.length < period + 1) return 50;
  let positive = 0, negative = 0;
  for (let i = ohlc.length - period; i < ohlc.length; i++) {
    const tp = (ohlc[i].h + ohlc[i].l + ohlc[i].c) / 3;
    const prevTp = (ohlc[i-1].h + ohlc[i-1].l + ohlc[i-1].c) / 3;
    const mf = tp * ohlc[i].v;
    if (tp > prevTp) positive += mf;
    else negative += mf;
  }
  if (negative === 0) return 100;
  const ratio = positive / negative;
  return 100 - 100 / (1 + ratio);
}

// ---- 뉴스 감성 분석 (Google News RSS) ----
const POSITIVE_KEYWORDS = ['급등', '상승', '호재', '실적개선', '수주', '신고가', '목표가상향', '순매수', '자사주', '배당', '실적호조', '반등', '증가', '흑자', '강세', '돌파'];
const NEGATIVE_KEYWORDS = ['급락', '하락', '악재', '실적부진', '목표가하향', '순매도', '경고', '하한가', '손절', '추락', '약세', '감소', '적자', '침체', '위기'];

async function fetchNewsData(stockName) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(stockName + ' 주식')}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { count: 0, sentiment: 0, titles: [] };
    const xml = await res.text();

    // RSS <item> 단위로 분할
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    let score = 0;
    const titles = [];
    for (const item of items) {
      const titleMatch = item.match(/<title>(.*?)<\/title>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');
      titles.push(title);
      const lower = title.toLowerCase();

      for (const kw of POSITIVE_KEYWORDS) {
        if (lower.includes(kw)) { score++; break; }
      }
      for (const kw of NEGATIVE_KEYWORDS) {
        if (lower.includes(kw)) { score--; break; }
      }
    }
    // -5~+5 범위 클램핑
    const clamped = Math.max(-5, Math.min(5, score));
    return { count: items.length, sentiment: clamped, titles };
  } catch (_) {
    return { count: 0, sentiment: 0, titles: [] };
  }
}

// 순위 기반 점수화 헬퍼 (1등=1/n, 꼴찌=0)
function rankScores(arr, key, higherIsBetter) {
  const n = arr.length;
  const entries = arr.map((item, i) => ({ val: item[key], i }));
  const valid = entries.filter(e => e.val != null);
  const nulls = entries.filter(e => e.val == null);
  valid.sort((a, b) => higherIsBetter ? b.val - a.val : a.val - b.val);
  const scores = new Array(n);
  valid.forEach((e, idx) => { scores[e.i] = (idx + 1) / n; });
  nulls.forEach(e => { scores[e.i] = 0; });
  return scores;
}

// ---- LLM 뉴스 검증 (Anthropic 호환 API) ----
function extractTextFromContent(content) {
  if (!Array.isArray(content)) return null;
  // 모든 블록(text + thinking)의 텍스트를 합쳐서 반환
  const parts = content.map(c => {
    if (c.type === 'text') return c.text || '';
    if (c.type === 'thinking') return c.thinking || '';
    return '';
  }).filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function callAnthropic(messages, systemPrompt, maxTokens = 4000) {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-sonnet-4-20250514';
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return null;

  const doFetch = async (extraHeaders) => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages,
      }),
    });
    if (!res.ok) return { error: res.status, text: null };
    const data = await res.json();
    const text = extractTextFromContent(data.content);
    return { error: null, text };
  };

  let result = await doFetch({ Authorization: `Bearer ${apiKey}` });
  if (result.error === 401) {
    result = await doFetch({ 'x-api-key': apiKey });
  }
  if (result.error) {
    console.error(`LLM API error: ${result.error}`);
    return null;
  }
  return result.text;
}

async function assessNewsWithLLM(stocksWithNews) {
  if (!stocksWithNews || stocksWithNews.length === 0) return null;

  const entries = stocksWithNews.map((s, i) => {
    const titles = (s.newsTitles || []).slice(0, 10); // 최대 10개 기사
    return `STOCK ${i+1}: ${s.name} (${s.symbol})\nTITLES:\n${titles.map(t => `- ${t}`).join('\n')}`;
  }).join('\n\n');

  const systemPrompt = 'You are a Korean financial news analyst. Respond with ONLY a valid JSON array. No explanations, no markdown, no code blocks.';
  const userPrompt = `Analyze these Korean stocks' recent news headlines. For each stock, rate:
1) fakeNewsRisk (0.0-1.0): Are news titles exaggerated or fake? 0=genuine, 1=clearly fake
2) catalystExhausted (0.0-1.0): Is good news already priced in? 0=fresh catalyst, 1=fully exhausted

${entries}

Output ONLY a JSON array, nothing else:
[{"stockIndex":1,"fakeNewsRisk":0.0,"catalystExhausted":0.0,"reasoning":"간단한 한국어 이유"}, ...]`;

  try {
    const response = await callAnthropic([{ role: 'user', content: userPrompt }], systemPrompt);
    if (!response) return null;
    // JSON 배열 추출 (thinking+text 통합 텍스트에서)
    const jsonMatch = response.match(/\[\s*\{.*\}\s*\]/s);
    const toParse = jsonMatch
      ? jsonMatch[0]
      : response.replace(/```json?\s*/gi, '').replace(/```\s*$/g, '').trim();
    const assessments = JSON.parse(toParse);
    if (!Array.isArray(assessments)) return null;
    return assessments;
  } catch (err) {
    console.error('LLM assessment error:', err.message);
    return null;
  }
}

app.get('/api/screener', async (req, res) => {
  try {
    // 1. Naver에서 KOSPI/KOSDAQ 상위 400종목씩 가져오기
    const [k1, k2, k3, k4, q1, q2, q3, q4] = await Promise.all([
      fetchNaverPage('KOSPI', 1), fetchNaverPage('KOSPI', 2),
      fetchNaverPage('KOSPI', 3), fetchNaverPage('KOSPI', 4),
      fetchNaverPage('KOSDAQ', 1), fetchNaverPage('KOSDAQ', 2),
      fetchNaverPage('KOSDAQ', 3), fetchNaverPage('KOSDAQ', 4),
    ]);

    const candidates = [
      ...(k1.stocks || []).map(s => ({ ...s, market: 'KOSPI' })),
      ...(k2.stocks || []).map(s => ({ ...s, market: 'KOSPI' })),
      ...(k3.stocks || []).map(s => ({ ...s, market: 'KOSPI' })),
      ...(k4.stocks || []).map(s => ({ ...s, market: 'KOSPI' })),
      ...(q1.stocks || []).map(s => ({ ...s, market: 'KOSDAQ' })),
      ...(q2.stocks || []).map(s => ({ ...s, market: 'KOSDAQ' })),
      ...(q3.stocks || []).map(s => ({ ...s, market: 'KOSDAQ' })),
      ...(q4.stocks || []).map(s => ({ ...s, market: 'KOSDAQ' })),
    ];

    // 2. 1차 필터: 등락률 -15%~+5%, 거래량 50만주 이상 (급등 제외, 급락+거래량 급종목 대상)
    const filtered = candidates.filter(s => {
      const ratio = parseNaverNum(s.fluctuationsRatio);
      const vol = parseNaverNum(s.accumulatedTradingVolumeRaw);
      return ratio >= -15 && ratio <= 5 && vol >= 500000;
    });

    // 3. Yahoo OHLCV 분석 (최대 60종목, 병렬 5개씩)
    const scored = [];
    const batchSize = 5;
    for (let i = 0; i < filtered.length && scored.length < 60; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);
      await Promise.all(batch.map(async (s) => {
        try {
          const code = s.stockCode || s.itemCode;
          const suffix = s.market === 'KOSPI' ? '.KS' : '.KQ';
          const symbol = code + suffix;

          const chartUrl = `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=30d`;
          const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!chartRes.ok) return;
          const chart = await chartRes.json();
          if (chart.chart?.error) return;

          const q = chart.chart.result[0].indicators.quote[0];
          const ohlc = [];
          for (let i = 0; i < q.close.length; i++) {
            if (q.close[i] != null && q.open[i] != null && q.high[i] != null && q.low[i] != null && q.volume[i] != null) {
              ohlc.push({ o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
            }
          }
          if (ohlc.length < 5) return;

          const today = ohlc[ohlc.length - 1];
          const prev = ohlc[ohlc.length - 2];

          // 지표 계산
          const changePct = parseNaverNum(s.fluctuationsRatio);
          const closes = ohlc.map(d => d.c);
          const rsi5 = calcRSI(closes, 5);
          const rangePos = (today.c - today.l) / (today.h - today.l || 1);

          // 거래량비율 (오늘 / 최근 5일 평균)
          const recentVols = ohlc.slice(-6, -1).map(d => d.v);
          const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
          const volRatio = avgVol > 0 ? today.v / avgVol : 1;

          // 연속 하락일수
          let downDays = 0;
          for (let j = ohlc.length - 1; j > 0; j--) {
            if (ohlc[j].c < ohlc[j - 1].c) downDays++;
            else break;
          }

          // 갭분석
          const gapPct = prev.c > 0 ? (today.o - prev.c) / prev.c * 100 : 0;

          // ==== 점수 계산 ====
          // 1) 반등패턴 (0~35): 하락했는데 고점에 가깝게 마감 = 반등신호
          let revScore;
          if (changePct < 0) {
            revScore = rangePos * 35;
          } else {
            revScore = Math.max(0, 35 - changePct * 3);
          }

          // 2) RSI 점수 (0~25): 낮을수록 과매도 반등 가능성
          let rsiScore;
          if (rsi5 < 30) rsiScore = 25;
          else if (rsi5 < 40) rsiScore = 20;
          else if (rsi5 < 50) rsiScore = 12;
          else if (rsi5 < 60) rsiScore = 6;
          else if (rsi5 < 70) rsiScore = 2;
          else rsiScore = 0;

          // 3) 거래량 급증 (0~20): 높을수록 기관 매수 의심
          let volScore;
          if (volRatio > 3.0) volScore = 20;
          else if (volRatio > 2.0) volScore = 16;
          else if (volRatio > 1.5) volScore = 10;
          else if (volRatio > 1.2) volScore = 5;
          else volScore = 0;

          // 4) 하락 연속 (0~12): 많이 떨어질수록 반등 확률
          const downScore = Math.min(downDays * 4, 12);

          // 5) 갭 분석 (0~8): 하락갭+장중회복 = 강한 반등
          let gapScore = 4;
          if (gapPct < -0.5 && today.c > today.o) gapScore = 8;
          else if (gapPct > 0.5 && today.c < today.o) gapScore = 0;

          // 6) 변동성 확대
          const recentRanges = ohlc.slice(-6, -1).map(d => d.h - d.l);
          const avgRange = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
          const volExpansion = avgRange > 0 ? (today.h - today.l) / avgRange : 1;
          let volExpScore;
          if (volExpansion > 2.0) volExpScore = 10;
          else if (volExpansion > 1.5) volExpScore = 7;
          else if (volExpansion > 1.2) volExpScore = 4;
          else volExpScore = 0;

          // 7) 단기 모멘텀
          const twoDaysAgo = ohlc.length >= 3 ? ohlc[ohlc.length - 3].c : prev.c;
          const twoDayChange = twoDaysAgo > 0 ? (today.c - twoDaysAgo) / twoDaysAgo * 100 : 0;
          let momentumScore;
          if (twoDayChange < -5) momentumScore = 5;
          else if (twoDayChange < -3) momentumScore = 4;
          else if (twoDayChange < -1) momentumScore = 2;
          else momentumScore = 0;

          // 8) 이동평균선 분석 (0~15점)
          const ma5 = calcMA(closes, 5);
          const ma20 = calcMA(closes, 20);
          let maReversalScore = 0, maStretchScore = 0;
          if (ma5 !== null && ma20 !== null) {
            const prevClose = ohlc.length >= 2 ? ohlc[ohlc.length - 2].c : null;
            // 5MA 돌파: 최근 2일内 종가가 5MA 위로 올라왔는가
            if (prevClose !== null && today.c > ma5 && prevClose <= ma5) {
              maReversalScore = 8;
            } else if (today.c > ma5) {
              maReversalScore = 3;
            }
            // 20MA 대비 스트레치: 적정 낙폭(-3~-15%) = 반등 가능성
            const dist20 = (today.c - ma20) / ma20 * 100;
            if (dist20 < -3 && dist20 >= -15) maStretchScore = 7;
            else if (dist20 < -15) maStretchScore = 2;
            else if (dist20 < -1) maStretchScore = 3;
          }
          const maScore = maReversalScore + maStretchScore;

          // MA 정렬도 (모멘텀 트랙용): 양수 = 5MA 상회
          const maAlignPct = ma5 != null ? (today.c - ma5) / ma5 * 100 : 0;
          // 20MA 거리 (반등 트랙용): 음수 = 20MA 하회 (stretched)
          const maDistPct = ma20 != null ? (today.c - ma20) / ma20 * 100 : 0;

          // 9) MFI (0~10점): 거래량 반영 과매도
          const mfi = calcMFI(ohlc, 14);
          let mfiScore;
          if (mfi < 20) mfiScore = 10;
          else if (mfi < 30) mfiScore = 7;
          else if (mfi < 40) mfiScore = 4;
          else if (mfi < 50) mfiScore = 2;
          else mfiScore = 0;

          // 변동성 방향 (모멘텀 트랙용): 상승+변동성↑ = 양수
          const volExpDirection = volExpansion * Math.sign(changePct);

          const baseScore = Math.round((revScore + rsiScore + volScore + downScore + gapScore) * 10) / 10;

          scored.push({
            symbol,
            name: s.stockName,
            price: parseNaverNum(s.closePriceRaw),
            change: parseNaverNum(s.compareToPreviousClosePriceRaw),
            changePercent: changePct,
            volume: parseNaverNum(s.accumulatedTradingVolumeRaw),
            volumeRatio: Math.round(volRatio * 10) / 10,
            upDays: 0,
            market: s.market,
            marketValue: parseNaverNum(s.marketValueRaw),
            score: baseScore,
            rsi: Math.round(rsi5),
            rangePos: Math.round(rangePos * 100),
            downDays,
            gapPct: Math.round(gapPct * 10) / 10,
            volExpansion: Math.round(volExpansion * 10) / 10,
            volExpScore,
            momentumScore,
            maScore,
            mfi: Math.round(mfi),
            mfiScore,
            // 순위 기반 듀얼 트랙용 원시값
            twoDayChange: Math.round(twoDayChange * 10) / 10,
            maDistPct: Math.round(maDistPct * 10) / 10,
            maAlignPct: Math.round(maAlignPct * 10) / 10,
            gapScore,
            volExpDirection: Math.round(volExpDirection * 10) / 10,
            newsCount: 0,
            newsSentiment: 0,
          });
        } catch (_) {}
      }));
    }

    // 4. 순위 기반 듀얼 트랙 점수 계산
    const n = scored.length;
    if (n === 0) return res.json({ stocks: [] });

    // 반등 트랙 (낮은 원시값 = 좋음)
    const rsiRank = rankScores(scored, 'rsi', false);
    const momRank = rankScores(scored, 'twoDayChange', false);
    const maDistRank = rankScores(scored, 'maDistPct', false);
    const downRank = rankScores(scored, 'downDays', true);
    const gapRank = rankScores(scored, 'gapScore', true);

    // 모멘텀 트랙 (높은 원시값 = 좋음)
    const volRank = rankScores(scored, 'volumeRatio', true);
    const maAlignRank = rankScores(scored, 'maAlignPct', true);
    const mfiRank = rankScores(scored, 'mfi', true);
    const volDirRank = rankScores(scored, 'volExpDirection', true);
    const rangeRank = rankScores(scored, 'rangePos', true);

    for (let i = 0; i < n; i++) {
      const s = scored[i];
      const reboundAvg = (rsiRank[i] + momRank[i] + maDistRank[i] + downRank[i] + gapRank[i]) / 5;
      const momentumAvg = (volRank[i] + maAlignRank[i] + mfiRank[i] + volDirRank[i] + rangeRank[i]) / 5;

      let ts, tn;
      if (reboundAvg >= momentumAvg) {
        ts = reboundAvg; tn = '반등';
        if (s.rsi > 50) ts -= 0.15;
        if ((s.volumeRatio || 0) < 0.5) ts -= 0.10;
      } else {
        ts = momentumAvg; tn = '모멘텀';
        if ((s.volumeRatio || 0) < 0.8) ts -= 0.15;
        if (s.downDays >= 3) ts -= 0.10;
      }

      s.trackScore = Math.round(Math.max(0, ts) * 100);
      s.trackName = tn;
    }

    // 상위 30종목 → 뉴스 감성 분석
    scored.sort((a, b) => b.trackScore - a.trackScore);
    const topCandidates = scored.slice(0, 30);

    await Promise.all(topCandidates.map(async (s) => {
      try {
        const news = await fetchNewsData(s.name);
        s.newsCount = news.count;
        s.newsSentiment = news.sentiment;
        s.newsTitles = news.titles.slice(0, 10);
        const newsScore = Math.max(0, Math.min(10, (s.newsSentiment + 5) * 1));
        s.finalScore = Math.round((s.trackScore + newsScore) * 10) / 10;
      } catch (_) {
        s.finalScore = s.trackScore;
      }
    }));

    // 5. 상위 10종목 → LLM 검증 (newsTitles는 이미 step 4에서 확보)
    topCandidates.sort((a, b) => b.finalScore - a.finalScore);
    const llmCandidates = topCandidates.slice(0, 10).filter(s => s.newsCount > 0);

    if (llmCandidates.length > 0) {
      const assessments = await assessNewsWithLLM(
        llmCandidates.map(s => ({ name: s.name, symbol: s.symbol, newsTitles: s.newsTitles }))
      );

      if (assessments) {
        const adjMap = new Map();
        for (const a of assessments) {
          if (a.stockIndex >= 1 && a.stockIndex <= llmCandidates.length) {
            const adjustment = -((a.fakeNewsRisk || 0) * 10 + (a.catalystExhausted || 0) * 5);
            adjMap.set(llmCandidates[a.stockIndex - 1].symbol, {
              llmFakeNewsRisk: a.fakeNewsRisk || 0,
              llmCatalystExhausted: a.catalystExhausted || 0,
              llmAdjustment: Math.round(adjustment * 10) / 10,
              llmReasoning: a.reasoning || '',
            });
          }
        }
        for (const s of topCandidates) {
          const adj = adjMap.get(s.symbol);
          if (adj) {
            s.llmFakeNewsRisk = adj.llmFakeNewsRisk;
            s.llmCatalystExhausted = adj.llmCatalystExhausted;
            s.llmAdjustment = adj.llmAdjustment;
            s.llmReasoning = adj.llmReasoning;
            s.finalScore = Math.round((s.finalScore + adj.llmAdjustment) * 10) / 10;
          } else {
            s.llmFakeNewsRisk = 0; s.llmCatalystExhausted = 0; s.llmAdjustment = 0;
          }
        }
      } else {
        llmCandidates.forEach(s => { s.llmFakeNewsRisk = 0; s.llmCatalystExhausted = 0; s.llmAdjustment = 0; });
      }
    }
    topCandidates.forEach(s => { if (s.llmFakeNewsRisk == null) { s.llmFakeNewsRisk = 0; s.llmCatalystExhausted = 0; s.llmAdjustment = 0; }});

    topCandidates.sort((a, b) => b.finalScore - a.finalScore);
    const result = topCandidates.slice(0, 20).map(({ newsTitles, ...rest }) => rest);
    res.json({ stocks: result });
  } catch (err) {
    console.error('Screener error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 뉴스 분석 (글로벌 20 + 국내 20 → 토픽 → 섹터 → 관련 종목)
// ============================================================
const SECTOR_STOCKS = {
  '반도체': [
    { name: '삼성전자', symbol: '005930.KS' }, { name: 'SK하이닉스', symbol: '000660.KS' }, { name: 'DB하이텍', symbol: '000990.KS' },
  ],
  '2차전지': [
    { name: 'LG에너지솔루션', symbol: '373220.KS' }, { name: '삼성SDI', symbol: '006400.KS' }, { name: '포스코퓨처엠', symbol: '003670.KS' },
  ],
  '자동차': [
    { name: '현대차', symbol: '005380.KS' }, { name: '기아', symbol: '000270.KS' }, { name: '현대모비스', symbol: '012330.KS' },
  ],
  '조선': [
    { name: 'HD한국조선해양', symbol: '009540.KS' }, { name: '삼성중공업', symbol: '010140.KS' }, { name: '한화오션', symbol: '042660.KS' },
  ],
  'AI·소프트웨어': [
    { name: 'NAVER', symbol: '035420.KS' }, { name: '카카오', symbol: '035720.KS' }, { name: '크래프톤', symbol: '259960.KS' }, { name: '엔씨소프트', symbol: '036570.KQ' },
  ],
  '바이오·제약': [
    { name: '삼성바이오로직스', symbol: '207940.KS' }, { name: '셀트리온', symbol: '068270.KS' }, { name: '유한양행', symbol: '000100.KS' },
  ],
  '금융·지주': [
    { name: 'KB금융', symbol: '105560.KS' }, { name: '신한지주', symbol: '055550.KS' }, { name: '하나금융지주', symbol: '086790.KS' },
  ],
  '에너지·화학': [
    { name: 'LG화학', symbol: '051910.KS' }, { name: 'SK이노베이션', symbol: '096770.KS' }, { name: '한화솔루션', symbol: '009830.KS' },
  ],
  '건설·인프라': [
    { name: '현대건설', symbol: '000720.KS' }, { name: '대우건설', symbol: '047040.KS' }, { name: 'GS건설', symbol: '006360.KS' }, { name: '두산에너빌리티', symbol: '034020.KS' },
  ],
  '통신·미디어': [
    { name: 'SK텔레콤', symbol: '017670.KS' }, { name: 'KT', symbol: '030200.KS' }, { name: 'LG유플러스', symbol: '032640.KS' },
  ],
  '방산·항공': [
    { name: '한화에어로스페이스', symbol: '012450.KS' }, { name: 'LIG넥스원', symbol: '079550.KS' }, { name: '한국항공우주', symbol: '047810.KS' },
  ],
  '유통·소비재': [
    { name: '신세계', symbol: '004170.KS' }, { name: '롯데쇼핑', symbol: '023530.KS' }, { name: '쿠팡', symbol: 'CPNG' },
  ],
  '철강·소재': [
    { name: '포스코홀딩스', symbol: '005490.KS' }, { name: '현대제철', symbol: '004020.KS' }, { name: '고려아연', symbol: '010130.KS' },
  ],
  '전기·전자': [
    { name: 'LG전자', symbol: '066570.KS' }, { name: '삼성전기', symbol: '009150.KS' }, { name: 'LG디스플레이', symbol: '034220.KS' },
  ],
  '음식료·담배': [
    { name: 'CJ제일제당', symbol: '097950.KS' }, { name: '오리온', symbol: '271560.KS' }, { name: 'KT&G', symbol: '033780.KS' },
  ],
  '엔터·게임': [
    { name: '하이브', symbol: '352820.KS' }, { name: 'JYP Ent.', symbol: '035900.KQ' }, { name: '넷마블', symbol: '251270.KS' },
  ],
  '헬스케어·의료': [
    { name: '삼성바이오로직스', symbol: '207940.KS' }, { name: '셀트리온', symbol: '068270.KS' }, { name: 'SK바이오사이언스', symbol: '302440.KQ' },
  ],
};

const NEWS_RSS_FEEDS = {
  global: [
    { url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', label: 'Global Top' },
    { url: 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnBA?hl=en-US&gl=US&ceid=US:en', label: 'Global Business' },
    { url: 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnBA?hl=en-US&gl=US&ceid=US:en', label: 'Global Tech' },
  ],
  domestic: [
    { url: 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', label: '국내 종합' },
    { url: 'https://news.google.com/rss/search?q=%EC%A6%9D%EC%8B%9C+%EA%B2%BD%EC%A0%9C&hl=ko&gl=KR&ceid=KR:ko', label: '국내 증시' },
    { url: 'https://news.google.com/rss/search?q=%EC%9E%AC%EB%AC%BC+%EC%82%B0%EC%97%85&hl=ko&gl=KR&ceid=KR:ko', label: '국내 산업' },
  ],
};

async function fetchRssTitles(url, maxItems = 15) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [];
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const item of items) {
      const titleMatch = item.match(/<title>(.*?)<\/title>/);
      if (!titleMatch) continue;
      let title = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
      // Google News RSS 자체 타이틀 제외
      if (title && !title.includes('Google News') && !title.startsWith('Top stories') && !title.startsWith('Business')) {
        titles.push(title);
      }
      if (titles.length >= maxItems) break;
    }
    return titles;
  } catch (_) {
    return [];
  }
}

let newsAnalysisCache = { data: null, time: 0 };
const NEWS_CACHE_TTL = 10 * 60 * 1000; // 10분

app.get('/api/news-analysis', async (req, res) => {
  try {
    // 캐시 확인
    if (Date.now() - newsAnalysisCache.time < NEWS_CACHE_TTL && newsAnalysisCache.data) {
      return res.json(newsAnalysisCache.data);
    }

    // 1. RSS 수집 (병렬)
    const [globalRss1, globalRss2, globalRss3, domRss1, domRss2, domRss3] = await Promise.all([
      fetchRssTitles(NEWS_RSS_FEEDS.global[0].url, 12),
      fetchRssTitles(NEWS_RSS_FEEDS.global[1].url, 10),
      fetchRssTitles(NEWS_RSS_FEEDS.global[2].url, 10),
      fetchRssTitles(NEWS_RSS_FEEDS.domestic[0].url, 12),
      fetchRssTitles(NEWS_RSS_FEEDS.domestic[1].url, 10),
      fetchRssTitles(NEWS_RSS_FEEDS.domestic[2].url, 10),
    ]);

    // 중복 제거 및 20개씩 추출
    const globalAll = [...new Set([...globalRss1, ...globalRss2, ...globalRss3])].slice(0, 20);
    const domesticAll = [...new Set([...domRss1, ...domRss2, ...domRss3])].slice(0, 20);

    if (globalAll.length === 0 && domesticAll.length === 0) {
      return res.json({ globalNews: [], domesticNews: [], topics: [] });
    }

    // 2. LLM 분석
    const sectorNames = Object.keys(SECTOR_STOCKS);
    const systemPrompt = 'You are a Korean financial news analyst. Respond with ONLY a valid JSON array. No explanations, no markdown, no code blocks.';
    const userPrompt = `You are analyzing today's top news for Korean stock market impact.

Identify 5-10 major topics/themes from these news headlines. For each topic, map it to 1-3 Korean stock market sectors and indicate whether it's bullish(호재) or bearish(악재) for that sector.

Available sectors (exact match required — pick from this list only): ${sectorNames.join(', ')}

=== GLOBAL NEWS (${globalAll.length}) ===
${globalAll.map((t, i) => `${i+1}. ${t}`).join('\n')}

=== DOMESTIC NEWS (${domesticAll.length}) ===
${domesticAll.map((t, i) => `${i+1}. ${t}`).join('\n')}

Output a JSON array:
[{"topic":"topic name in Korean","sourceType":"global"|"domestic"|"both","sectors":[{"name":"sector name","sentiment":"호재"|"악재"|"중립","reason":"Korean explanation"}]}]`;

    const llmResponse = await callAnthropic([{ role: 'user', content: userPrompt }], systemPrompt, 3000);
    let topics = [];
    if (llmResponse) {
      try {
        const jsonMatch = llmResponse.match(/\[\s*\{.*\}\s*\]/s);
        const toParse = jsonMatch ? jsonMatch[0] : llmResponse.replace(/```json?\s*/gi, '').replace(/```\s*$/g, '').trim();
        topics = JSON.parse(toParse);
        if (!Array.isArray(topics)) topics = [];
      } catch (err) {
        console.error('News analysis LLM parse error:', err.message);
        topics = [];
      }
    }

    // 3. 섹터별 관련 종목 매핑 (유연한 이름 매칭)
    function matchSector(inputName) {
      // 1) 정확히 일치
      if (SECTOR_STOCKS[inputName]) return SECTOR_STOCKS[inputName];
      // 2) 우리 키가 입력에 포함됨 (예: "방산" → "방산·항공")
      for (const [key, stocks] of Object.entries(SECTOR_STOCKS)) {
        if (inputName.includes(key) || key.includes(inputName)) return stocks;
      }
      // 3) 공백/특수문자 제거 후 비교
      const normalize = s => s.replace(/[\s···/\\,;&]/g, '');
      const normInput = normalize(inputName);
      for (const [key, stocks] of Object.entries(SECTOR_STOCKS)) {
        if (normalize(key) === normInput) return stocks;
      }
      // 4) 부분 단어 매칭 (첫 단어 기준)
      const inputFirst = inputName.split(/[\s···/\\,;&]/)[0];
      if (inputFirst) {
        for (const [key, stocks] of Object.entries(SECTOR_STOCKS)) {
          if (key.startsWith(inputFirst) || inputFirst.startsWith(key)) return stocks;
        }
      }
      return [];
    }

    for (const topic of topics) {
      if (topic.sectors && Array.isArray(topic.sectors)) {
        for (const sector of topic.sectors) {
          sector.stocks = matchSector(sector.name);
        }
      }
    }

    const result = { globalNews: globalAll, domesticNews: domesticAll, topics };
    newsAnalysisCache = { data: result, time: Date.now() };
    res.json(result);
  } catch (err) {
    console.error('News analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});
