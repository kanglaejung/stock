import https from 'https';

// KIS API는 SSL 인증서 검증 우회 필요 (자체 CA 사용)
const AGENT = new https.Agent({ rejectUnauthorized: false });
const BASE_URL = process.env.KIS_IS_REAL === 'true'
  ? 'https://openapi.koreainvestment.com:9443'
  : 'https://openapivts.koreainvestment.com:9443';

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

function parseSymbol(symbol) {
  const match = symbol.match(/^(\d{6})\.(KS|KQ)$/);
  if (!match) return null;
  return { code: match[1], market: match[2] === 'KQ' ? 'KQ' : 'J' };
}

function isConfigured() {
  const key = process.env.KIS_APPKEY;
  const secret = process.env.KIS_APPSECRET;
  return !!(key && secret && key !== 'your_appkey_here');
}

function jsonRequest(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE_URL);
    const opts = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      method, agent: AGENT,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data, json: () => JSON.parse(data) }); }
        catch { reject(new Error(`KIS parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  // 캐시된 토큰이 유효하면 즉시 반환
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  // 이미 진행 중인 토큰 발급이 있으면 함께 대기
  if (tokenPromise) return tokenPromise;

  const body = JSON.stringify({
    grant_type: 'client_credentials',
    appkey: process.env.KIS_APPKEY,
    appsecret: process.env.KIS_APPSECRET,
  });

  const doFetch = async (retries) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await jsonRequest('POST', '/oauth2/tokenP', body);
      if (res.ok) {
        const data = res.json();
        if (!data.access_token) throw new Error(`KIS auth failed: ${data.message || data.code || JSON.stringify(data)}`);
        cachedToken = data.access_token;
        tokenExpiresAt = Date.now() + (data.expires_in || 86400) * 1000 - 120000;
        tokenPromise = null;
        return cachedToken;
      }
      // rate limit (EGW00133: 1분당 1회) — 최대 60초 대기
      if (res.body && res.body.includes('EGW00133') && attempt < retries) {
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      throw new Error(`KIS auth HTTP ${res.status}: ${(res.body || '').slice(0, 100)}`);
    }
    throw new Error('KIS auth exhausted retries');
  };

  tokenPromise = doFetch(1);
  return tokenPromise;
}

// 투자자별 매매동향 (개인/외국인/기관 순매수)
export async function fetchInvestorData(symbol) {
  const parsed = parseSymbol(symbol);
  if (!parsed || !isConfigured()) return null;

  try {
    const token = await getToken();
    const today = new Date();
    const endDate = toYYYYMMDD(today);
    const startDate = toYYYYMMDD(new Date(today - 15 * 86400000));

    const path = '/uapi/domestic-stock/v1/quotations/inquire-investor'
      + `?FID_COND_MRKT_DIV_CODE=${parsed.market}`
      + `&FID_INPUT_ISCD=${parsed.code}`
      + `&FID_INPUT_DATE_1=${startDate}`
      + `&FID_INPUT_DATE_2=${endDate}`
      + `&FID_HOUR_CLS_CODE=00`;

    const res = await jsonRequest('GET', path, null, {
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
      tr_id: 'FHKST66410900',
    });

    if (!res.ok) throw new Error(`KIS API HTTP ${res.status}`);

    const data = await res.json();
    if (data.rt_cd !== '0') {
      if (data.msg1?.includes('없는 서비스 코드')) {
        console.error(`KIS: 투자자별매매동향(FHKST66410900) API가 활성화되지 않았습니다. apiportal.koreainvestment.com에서 신청해주세요.`);
      }
      throw new Error(data.msg1 || `KIS error ${data.msg_cd}`);
    }

    return (data.output || []).map(item => ({
      date: item.stck_bsop_date,
      close: parseFloat(item.stck_clpr) || 0,
      prsn: parseInt(item.prsn_ntby_qty, 10) || 0,
      frgn: parseInt(item.frgn_ntby_qty, 10) || 0,
      orgn: parseInt(item.orgn_ntby_qty, 10) || 0,
    }));
  } catch (err) {
    console.error(`KIS investor [${symbol}]:`, err.message);
    return null;
  }
}

// 서버 시작 시 미리 토큰 발급 (백그라운드)
if (isConfigured()) {
  getToken().then(() => console.log('KIS token ready')).catch(() => {});
}

function toYYYYMMDD(date) {
  return date.getFullYear()
    + String(date.getMonth() + 1).padStart(2, '0')
    + String(date.getDate()).padStart(2, '0');
}
