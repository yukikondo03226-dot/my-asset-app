// ============================================================
// マイ資産アプリ バックエンドサーバー
// ------------------------------------------------------------
// このファイルが行うこと:
//   1. 保有銘柄・オルカンの保有状況を、JSONBin.ioという無料の外部保存
//      サービスに保存する。コードを更新して再デプロイしても、
//      Safariで開いてもホーム画面のアイコンから開いても、
//      いつも同じ内容が表示されます。
//   2. 松井証券の公開株価ページから、保有している日本株の
//      「今日に近い」株価・前日比・PER等を取得する
//      (※非公式な方法です。下の「注意」を必ずお読みください)
//   3. J-Quants から、同じ銘柄のPER/PBRの「約3ヶ月前時点」のデータや、
//      テクニカル分析(RSI・移動平均線)用の値動きの履歴を取得する
//   4. 三菱UFJアセットマネジメントの公開APIから、オルカンの
//      基準価額・純資産総額などを取得する(こちらは最新・公式データ)
//   5. NewsAPI から、保有銘柄や世界経済に関するニュース見出しを取得する
//      (AIによる要約・推測は行わず、見出しの一覧のみを返します)
//   6. 日経平均(松井証券)・USD/JPY(無料の為替API)などの市場指標を取得する
//
// ★重要な注意(2番について)
// 松井証券のページは公式にAPIを提供していないため、ページのHTMLを
// 直接読み取る「非公式スクレイピング」という方法を使っています。
//   - 正式に許可された使い方ではありません
//   - サイトのデザインが変わると、このプログラムが突然動かなくなる可能性があります
//   - 個人が少ない頻度(1日に数回程度)でアクセスする分には実務上大きな問題に
//     なるケースは少ないとされますが、リスクを理解した上でご利用ください
//   - 動かなくなった場合はエラーメッセージを教えてください。一緒に直しましょう
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;

// オルカン(eMAXIS Slim 全世界株式(オール・カントリー))の協会コード
const ORCAN_FUND_CODE = '0331418A';

// ------------------------------------------------------------
// 保有一覧表(JSONBin.ioという無料の外部保存サービスに保存します)
// サーバー内のファイルではなく外部に保存することで、コードを更新して
// 再デプロイしても、保有銘柄のデータが消えないようにしています。
// ------------------------------------------------------------
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';

const DEFAULT_HOLDINGS = {
  stocks: [
    { code: '7203', name: 'トヨタ自動車', shares: null, cost: null },
    { code: '6758', name: 'ソニーグループ', shares: null, cost: null },
    { code: '8306', name: '三菱UFJフィナンシャル・グループ', shares: null, cost: null }
  ],
  orcan: { principal: null, units: null }
};

async function loadHoldings() {
  try {
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`JSONBin 読み込みエラー: ${res.status} ${text}`);
    }
    const json = await res.json();
    const data = json.record;
    if (!data || !Array.isArray(data.stocks)) return DEFAULT_HOLDINGS;
    return data;
  } catch (e) {
    console.error('保有一覧表の読み込みに失敗しました:', e.message);
    return DEFAULT_HOLDINGS;
  }
}

async function saveHoldings(data) {
  const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSONBin 保存エラー: ${res.status} ${text}`);
  }
}

// 証券コード(4文字。数字だけでなく "212A" のような形式もあります)の末尾に
// 0 を付けるとJ-Quants用のコードになります(通常株式の場合)
function toJquantsCode(code) {
  return `${code}0`;
}

// 日付を YYYYMMDD 形式の文字列にする小さな道具
function toYyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// ------------------------------------------------------------
// J-Quants Freeプランは「1分あたり5回まで」というリクエスト制限があります。
// 銘柄数が増えても制限に引っかからないよう、J-Quantsへのリクエストは
// この関数を必ず通して、間隔を空けながら順番に実行します。
// ------------------------------------------------------------
const JQUANTS_MIN_INTERVAL_MS = 13000; // 1分5回制限に対して余裕を持たせた間隔
let jquantsChain = Promise.resolve();

function fetchJQuants(url) {
  const task = jquantsChain.then(async () => {
    const res = await fetch(url, { headers: { 'x-api-key': JQUANTS_API_KEY } });
    await new Promise((resolve) => setTimeout(resolve, JQUANTS_MIN_INTERVAL_MS));
    return res;
  });
  // 次のリクエストは、これの成功・失敗にかかわらず順番を待ちます
  jquantsChain = task.then(
    () => {},
    () => {}
  );
  return task;
}

// pagination_key が付いている間、続きのページを繰り返し取得してすべて集めます
async function fetchJQuantsAllPages(baseUrl) {
  let url = baseUrl;
  let allData = [];
  while (url) {
    const res = await fetchJQuants(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`J-Quants取得エラー: ${res.status} ${text}`);
    }
    const json = await res.json();
    allData = allData.concat(json.data || []);
    if (json.pagination_key) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      url = `${baseUrl}${sep}pagination_key=${encodeURIComponent(json.pagination_key)}`;
    } else {
      url = null;
    }
  }
  return allData;
}

// ------------------------------------------------------------
// J-Quantsのデータ(PER/PBR・テクニカル指標)は、画面を開くたびにリアル
// タイムで取りに行くとレート制限のせいで応答がとても遅くなってしまいます。
// そこで、バックグラウンドで定期的に(15分おきに)まとめて取得しておき、
// 画面からのリクエストには「その時点でのキャッシュ」を即座に返す方式にします。
// どのみちJ-Quantsのデータ自体が約3ヶ月前時点のものなので、多少の
// タイムラグ(数分〜15分程度)があっても実用上問題ありません。
// ------------------------------------------------------------
const jquantsCache = new Map(); // code -> { longTerm, longTermError, technical, technicalError, updatedAt }

async function refreshJQuantsCacheForCode(code) {
  const entry = jquantsCache.get(code) || {};

  try {
    entry.longTerm = await fetchLongTermIndicator(code);
    entry.longTermError = null;
  } catch (err) {
    entry.longTermError = err.message;
  }

  try {
    const bars = await fetchPriceHistory(code);
    entry.technical = computeTechnicals(bars);
    entry.technicalError = entry.technical ? null : '計算に十分な期間のデータが取得できませんでした';
  } catch (err) {
    entry.technicalError = err.message;
  }

  entry.updatedAt = new Date().toISOString();
  jquantsCache.set(code, entry);
  return entry;
}

async function refreshJQuantsCacheAll() {
  try {
    const holdings = await loadHoldings();
    for (const s of holdings.stocks) {
      await refreshJQuantsCacheForCode(s.code);
    }
  } catch (err) {
    console.error('J-Quantsキャッシュの更新に失敗しました:', err.message);
  }
}

// サーバー起動時に1回実行し、その後は15分おきに自動更新します
refreshJQuantsCacheAll();
setInterval(refreshJQuantsCacheAll, 15 * 60 * 1000);

// ------------------------------------------------------------
// J-Quants: 指定した銘柄コードの「約3ヶ月前時点」のPER/PBRを取得
// これは「今日の値段」ではなく、指標の長期的な推移を見るための参考値です。
// 無料プランでは直近12週間より前のデータしか取れないため、
// 少し過去にさかのぼった期間を指定して、その中の一番新しいものを使います。
// ------------------------------------------------------------
async function fetchLongTermIndicator(code) {
  const jquantsCode = toJquantsCode(code);
  const today = new Date();
  const to = new Date(today);
  to.setDate(to.getDate() - 84); // 12週間(84日)前
  const from = new Date(to);
  from.setDate(from.getDate() - 21); // 土日・祝日を考慮して3週間分の幅を持たせる

  const fromStr = toYyyymmdd(from);
  const toStr = toYyyymmdd(to);

  const valuationData = (
    await fetchJQuantsAllPages(
      `https://api.jquants.com/v2/equities/valuation?code=${jquantsCode}&from=${fromStr}&to=${toStr}`
    )
  )
    .slice()
    .sort((a, b) => a.Date.localeCompare(b.Date));
  const latestValuation = valuationData[valuationData.length - 1];

  if (!latestValuation) {
    return null;
  }

  return {
    asOfDate: latestValuation.Date, // このデータが「いつ時点」のものか(約3ヶ月前になります)
    per: latestValuation.PER,
    pbr: latestValuation.PBR
  };
}

// ------------------------------------------------------------
// J-Quants: テクニカル分析用に、指定した銘柄の値動きの履歴(約3ヶ月前まで)を取得
// RSI・移動平均線の計算には多めの日数が必要なので、長めの期間を指定します。
// ------------------------------------------------------------
async function fetchPriceHistory(code) {
  const jquantsCode = toJquantsCode(code);
  const today = new Date();
  const to = new Date(today);
  to.setDate(to.getDate() - 84); // 12週間前(無料プランで取得できる一番新しい時期)
  const from = new Date(to);
  from.setDate(from.getDate() - 200); // 移動平均線(75日)の計算に十分な日数をさかのぼる

  const fromStr = toYyyymmdd(from);
  const toStr = toYyyymmdd(to);

  const data = await fetchJQuantsAllPages(
    `https://api.jquants.com/v2/equities/bars/daily?code=${jquantsCode}&from=${fromStr}&to=${toStr}`
  );
  return data.slice().sort((a, b) => a.Date.localeCompare(b.Date));
}

// RSI(相対力指数)を計算する(Wilderの方法、期間14日が標準)
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 単純移動平均線(SMA)を計算する
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ゴールデンクロス・デッドクロスを検出する(25日線と75日線)
function calcCrossSignal(closes) {
  if (closes.length < 77) return null;
  const ma25Today = calcSMA(closes, 25);
  const ma75Today = calcSMA(closes, 75);
  const closesYesterday = closes.slice(0, -1);
  const ma25Yesterday = calcSMA(closesYesterday, 25);
  const ma75Yesterday = calcSMA(closesYesterday, 75);
  if (ma25Today == null || ma75Today == null || ma25Yesterday == null || ma75Yesterday == null) return null;
  if (ma25Yesterday <= ma75Yesterday && ma25Today > ma75Today) return 'golden';
  if (ma25Yesterday >= ma75Yesterday && ma25Today < ma75Today) return 'dead';
  return null;
}

// 上のデータをまとめて、シグナル(タグ)とコメントを組み立てる
function computeTechnicals(bars) {
  if (!bars || bars.length < 20) return null;

  const closes = bars.map((b) => b.Close).filter((v) => v != null);
  const volumes = bars.map((b) => b.Volume).filter((v) => v != null);

  const rsi = calcRSI(closes, 14);
  const ma25 = calcSMA(closes, 25);
  const ma75 = calcSMA(closes, 75);
  const cross = calcCrossSignal(closes);

  const latestVolume = volumes.length ? volumes[volumes.length - 1] : null;
  const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null;
  const volumeRatioPct = latestVolume != null && avgVolume ? Math.round((latestVolume / avgVolume) * 100) : null;

  let signal = '中立';
  let comment = '目立ったシグナルは出ていません。';

  if (cross === 'golden') {
    signal = 'ゴールデンクロス';
    comment = '短期(25日)の移動平均線が長期(75日)を上抜けました。短期的な上昇モメンタムのシグナルとされています。';
  } else if (cross === 'dead') {
    signal = 'デッドクロス';
    comment = '短期(25日)の移動平均線が長期(75日)を下抜けました。短期的な下降モメンタムのシグナルとされています。';
  } else if (rsi != null && rsi >= 70) {
    signal = 'RSI高水準';
    comment = 'RSIが70以上で、一般的に「買われすぎ」とされる水準にあります。';
  } else if (rsi != null && rsi <= 30) {
    signal = 'RSI低水準';
    comment = 'RSIが30以下で、一般的に「売られすぎ」とされる水準にあります。';
  }

  return {
    asOfDate: bars[bars.length - 1].Date,
    rsi: rsi != null ? Math.round(rsi * 10) / 10 : null,
    ma25: ma25 != null ? Math.round(ma25 * 100) / 100 : null,
    ma75: ma75 != null ? Math.round(ma75 * 100) / 100 : null,
    volumeRatioPct,
    signal,
    comment
  };
}

// ------------------------------------------------------------
// 松井証券の株価ページ: 指定した銘柄コードの「今日に近い」株価・前日比・
// PER・配当利回りをページから読み取る(非公式スクレイピング)
// ログイン不要で公開されているページです。
// ------------------------------------------------------------
async function scrapeStockPrice(code) {
  const url = `https://finance.matsui.co.jp/stock/${code}/index`;

  const res = await fetch(url, {
    headers: {
      // 一般的なブラウザからのアクセスに見せるためのヘッダーです
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`株価ページの取得に失敗しました(銘柄${code}): ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  // タグを取り除いた本文テキストの中から、ラベルの直後にある数値を正規表現で探します
  const bodyText = $('body').text().replace(/\s+/g, ' ');

  const priceMatch = bodyText.match(/現在値\s*([0-9,]+\.?[0-9]*)/);
  const changeMatch = bodyText.match(/前日比\s*[▲△▼]?\s*([+\-−]?[0-9,]+\.?[0-9]*)\s*\(\s*[▲△▼]?\s*([+\-−]?[0-9.]+)\s*%\s*\)/);
  const perMatch = bodyText.match(/EPS\(PER\)\s*[0-9,.]+円\(([0-9.]+)倍\)/);
  const pbrMatch = bodyText.match(/BPS\(PBR\)\s*[0-9,.]+円\(([0-9.]+)倍\)/);
  const dividendMatch = bodyText.match(/予想配当利回り\s*([0-9.]+)%/);

  if (!priceMatch) {
    // ページの構成が変わって読み取れなかった場合。ここでエラーを出すことで、
    // 「サイレントに古いデータのまま」になることを防ぎます。
    throw new Error(
      `株価ページの構成が変わった可能性があります(銘柄${code})。このURL(${url})を開いて、実際の表示と見比べてみてください。`
    );
  }

  const toNumber = (s) => (s == null ? null : parseFloat(s.replace(/,/g, '').replace('−', '-')));

  return {
    fetchedAt: new Date().toISOString(), // 取得した時刻(この時点にかなり近い株価という意味です)
    close: toNumber(priceMatch[1]),
    change: changeMatch ? toNumber(changeMatch[1]) : null,
    changePct: changeMatch ? toNumber(changeMatch[2]) : null,
    per: perMatch ? parseFloat(perMatch[1]) : null,
    pbr: pbrMatch ? parseFloat(pbrMatch[1]) : null,
    dividendYield: dividendMatch ? parseFloat(dividendMatch[1]) : null
  };
}

// ------------------------------------------------------------
// 市場の経済指標: 日経平均(松井証券の指数ページ)とUSD/JPY(無料の為替API)
// ------------------------------------------------------------
async function scrapeNikkei() {
  const url = 'https://finance.matsui.co.jp/stock/.N225/daily-bar/index';

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) {
    throw new Error(`日経平均の取得に失敗しました: ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ');

  const priceMatch = bodyText.match(/現在値\s*([0-9,]+\.?[0-9]*)/);
  const changeMatch = bodyText.match(/前日比\s*[▲△▼]?\s*([+\-−]?[0-9,]+\.?[0-9]*)\s*\(\s*[▲△▼]?\s*([+\-−]?[0-9.]+)\s*%\s*\)/);

  if (!priceMatch) {
    throw new Error(`日経平均のページ構成が変わった可能性があります。このURL(${url})を開いて確認してください。`);
  }

  const toNumber = (s) => (s == null ? null : parseFloat(s.replace(/,/g, '').replace('−', '-')));

  return {
    label: '日経平均',
    value: toNumber(priceMatch[1]),
    change: changeMatch ? toNumber(changeMatch[1]) : null,
    changePct: changeMatch ? toNumber(changeMatch[2]) : null
  };
}

async function fetchUsdJpy() {
  // APIキー不要・登録不要の無料の為替レートAPIです(毎日更新)
  const url = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`為替レートの取得に失敗しました: ${res.status}`);
  }
  const json = await res.json();
  const rate = json && json.usd ? json.usd.jpy : null;
  if (rate == null) {
    throw new Error('為替レートのデータ形式が想定と違います');
  }
  return {
    label: 'USD/JPY',
    value: Math.round(rate * 100) / 100,
    change: null,
    changePct: null
  };
}

// ------------------------------------------------------------
// 三菱UFJアセットマネジメント公開API: オルカンの基準価額等を取得
// このAPIはAPIキー不要で、登録も不要です。
// ------------------------------------------------------------
async function fetchOrcanData() {
  const url = `https://developer.am.mufg.jp/fund_information_latest/association_fund_cd/${ORCAN_FUND_CODE}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`オルカンAPI取得エラー: ${res.status} ${text}`);
  }

  const json = await res.json();
  const value = json?.datasets?.[0] || null;

  if (value) {
    return { value, raw: null };
  }

  // 万が一また構造が変わった場合に備えて、レスポンス全体を返せるようにしておきます
  return { value: null, raw: json };
}

// ------------------------------------------------------------
// NewsAPI: キーワードに関するニュース見出しを取得(AI要約なし)
// 無料プランは24時間遅れの記事になりますが、見出し一覧としては問題ありません。
// ------------------------------------------------------------
async function fetchNewsFor(keyword) {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(keyword)}&language=jp&sortBy=publishedAt&pageSize=3&apiKey=${NEWSAPI_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NewsAPI取得エラー(${keyword}): ${res.status} ${text}`);
  }

  const json = await res.json();
  return (json.articles || []).map((a) => ({
    title: a.title,
    source: a.source ? a.source.name : null,
    publishedAt: a.publishedAt,
    url: a.url
  }));
}

// ============================================================
// 保有一覧表 API(追加・編集・削除)
// ============================================================

// 保有一覧表(銘柄+オルカン)をそのまま返す
app.get('/api/holdings', async (req, res) => {
  try {
    res.json(await loadHoldings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 銘柄を追加
app.post('/api/holdings/stocks', async (req, res) => {
  const { code, name, shares, cost } = req.body || {};

  if (!code || !/^[0-9A-Za-z]{4}$/.test(code)) {
    return res.status(400).json({ error: '証券コードは4文字(数字・アルファベット)で入力してください' });
  }
  if (!name) {
    return res.status(400).json({ error: '銘柄名を入力してください' });
  }

  try {
    const data = await loadHoldings();
    if (data.stocks.some((s) => s.code === code)) {
      return res.status(400).json({ error: 'その証券コードはすでに追加されています' });
    }

    data.stocks.push({
      code,
      name,
      shares: shares || null,
      cost: cost || null
    });
    await saveHoldings(data);
    // 追加した銘柄のJ-Quantsデータを、15分待たずにすぐ裏側で取得し始めます
    refreshJQuantsCacheForCode(code).catch((err) => {
      console.error(`銘柄追加時のキャッシュ更新に失敗しました(${code}):`, err.message);
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 銘柄の保有株数・取得単価を編集
app.put('/api/holdings/stocks/:code', async (req, res) => {
  const { code } = req.params;
  const { shares, cost } = req.body || {};

  try {
    const data = await loadHoldings();
    const target = data.stocks.find((s) => s.code === code);
    if (!target) {
      return res.status(404).json({ error: '指定された銘柄が見つかりません' });
    }

    target.shares = shares || null;
    target.cost = cost || null;
    await saveHoldings(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 銘柄を削除
app.delete('/api/holdings/stocks/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const data = await loadHoldings();
    data.stocks = data.stocks.filter((s) => s.code !== code);
    await saveHoldings(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// オルカンの保有状況(積立元本・保有口数)を保存
app.put('/api/holdings/orcan', async (req, res) => {
  const { principal, units } = req.body || {};
  try {
    const data = await loadHoldings();
    data.orcan = {
      principal: principal || null,
      units: units || null
    };
    await saveHoldings(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// データ取得 API(スマホアプリ側からはこのURLを呼び出します)
// ============================================================

// 保有株一覧: 松井証券ページの「今日に近い」株価(リアルタイム取得)
// + J-Quantsの「約3ヶ月前」の指標(バックグラウンドキャッシュから即座に返す)
// + 保有株数・取得単価から計算した評価額・評価損益
app.get('/api/stocks', async (req, res) => {
  try {
    const holdings = await loadHoldings();
    const results = await Promise.all(
      holdings.stocks.map(async (s) => {
        // 株価は松井証券のページからその都度リアルタイムで取得します(J-Quantsではないため)
        let current = null;
        let currentError = null;
        try {
          current = await scrapeStockPrice(s.code);
        } catch (err) {
          currentError = err.message;
        }

        // PER/PBR(約3ヶ月前時点)はJ-Quantsのバックグラウンドキャッシュから読みます
        const cached = jquantsCache.get(s.code);
        const longTermIndicator = cached ? cached.longTerm : null;
        const longTermError = cached
          ? cached.longTermError
          : 'まだデータを準備中です。追加してから数分後にもう一度開いてみてください。';

        // 保有株数・取得単価が入っていれば、評価額・評価損益を計算します
        let evaluation = null;
        if (s.shares && s.cost && current && current.close != null) {
          const evalValue = s.shares * current.close;
          const costValue = s.shares * s.cost;
          const pl = evalValue - costValue;
          evaluation = {
            evalValue,
            pl,
            plPct: (pl / costValue) * 100
          };
        }

        return {
          name: s.name,
          code: s.code,
          shares: s.shares,
          cost: s.cost,
          current, // 今日に近い株価・PER/PBR(松井証券の公開ページ、非公式)
          currentError,
          longTermIndicator, // 約3ヶ月前時点のPER/PBR(J-Quants、公式・無料)
          longTermError,
          evaluation // 評価額・評価損益(株数・取得単価がある場合のみ)
        };
      })
    );
    res.json({ stocks: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// オルカンの基準価額など + 積立元本・保有口数から計算した評価額・評価損益
app.get('/api/orcan', async (req, res) => {
  try {
    const holdings = await loadHoldings();
    const data = await fetchOrcanData();
    const o = data.value;

    let evaluation = null;
    if (o && holdings.orcan && holdings.orcan.principal && holdings.orcan.units) {
      // 基準価額は「1万口あたり」の金額なので、口数を1万で割ってから掛けます
      const evalValue = (holdings.orcan.units / 10000) * o.nav;
      const pl = evalValue - holdings.orcan.principal;
      evaluation = {
        evalValue,
        pl,
        plPct: (pl / holdings.orcan.principal) * 100
      };
    }

    res.json({
      orcan: o,
      holding: holdings.orcan || { principal: null, units: null },
      evaluation,
      debugRaw: o ? undefined : data.raw
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// テクニカル分析(RSI・移動平均線・出来高)※参考情報、売買の推奨ではありません
// バックグラウンドキャッシュから即座に返します(J-Quantsへその場ではアクセスしません)
app.get('/api/technicals', async (req, res) => {
  try {
    const holdings = await loadHoldings();
    const results = holdings.stocks.map((s) => {
      const cached = jquantsCache.get(s.code);
      return {
        name: s.name,
        code: s.code,
        technical: cached ? cached.technical : null,
        error: cached
          ? cached.technicalError
          : 'まだデータを準備中です。追加してから数分後にもう一度開いてみてください。'
      };
    });
    res.json({ technicals: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 市場の経済指標(日経平均・USD/JPY)
app.get('/api/market', async (req, res) => {
  const results = [];
  try {
    results.push(await scrapeNikkei());
  } catch (err) {
    results.push({ label: '日経平均', error: err.message });
  }
  try {
    results.push(await fetchUsdJpy());
  } catch (err) {
    results.push({ label: 'USD/JPY', error: err.message });
  }
  res.json({ market: results });
});

// ニュース見出し一覧(保有銘柄名 + 世界経済 + 日本株、それぞれ数件ずつ)
app.get('/api/news', async (req, res) => {
  try {
    const holdings = await loadHoldings();
    const keywords = [...holdings.stocks.map((s) => s.name), '日本株', '世界経済'];
    const results = {};
    for (const kw of keywords) {
      results[kw] = await fetchNewsFor(kw);
    }
    res.json({ news: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 動作確認用(トップページは public/index.html が表示されます)
app.get('/status', (req, res) => {
  res.send('マイ資産アプリ バックエンドAPI 稼働中です。/api/stocks, /api/orcan, /api/news をお試しください。');
});

app.listen(PORT, () => {
  console.log(`サーバーがポート${PORT}で起動しました`);
});
