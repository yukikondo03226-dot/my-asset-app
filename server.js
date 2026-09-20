// ============================================================
// マイ資産アプリ バックエンドサーバー
// ------------------------------------------------------------
// このファイルが行うこと:
//   1. 松井証券の公開株価ページから、保有している日本株の
//      「今日に近い」株価・前日比・PER等を取得する
//      (※非公式な方法です。下の「注意」を必ずお読みください)
//   2. J-Quants から、同じ銘柄のPER/PBRの「約3ヶ月前時点」のデータを取得する
//      (長期的な指標の推移を見るための参考値として使います)
//   3. 三菱UFJアセットマネジメントの公開APIから、オルカンの
//      基準価額・純資産総額などを取得する(こちらは最新・公式データ)
//   4. NewsAPI から、保有銘柄や世界経済に関するニュース見出しを取得する
//      (AIによる要約・推測は行わず、見出しの一覧のみを返します)
//
// ★重要な注意(1番について)
// 松井証券のページは公式にAPIを提供していないため、ページのHTMLを
// 直接読み取る「非公式スクレイピング」という方法を使っています。
//   - 正式に許可された使い方ではありません
//   - サイトのデザインが変わると、このプログラムが突然動かなくなる可能性があります
//   - 個人が少ない頻度(1日に数回程度)でアクセスする分には実務上大きな問題に
//     なるケースは少ないとされますが、リスクを理解した上でご利用ください
//   - 動かなくなった場合はエラーメッセージを教えてください。一緒に直しましょう
//
// プログラミングが分からなくても大丈夫です。
// 「STOCK_CODES」の部分だけ書き換えれば、保有銘柄を増減できます。
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;

// ------------------------------------------------------------
// 保有銘柄一覧(ここに追加・削除するだけで銘柄を増減できます)
//   jquantsCode: J-Quants用の5桁コード(証券コードの末尾に0を付けたもの)
//   yahooCode:   Yahoo!ファイナンス用の4桁の証券コード(そのまま)
// ------------------------------------------------------------
const STOCK_CODES = [
  { jquantsCode: '72030', yahooCode: '7203', name: 'トヨタ自動車' },
  { jquantsCode: '67580', yahooCode: '6758', name: 'ソニーグループ' },
  { jquantsCode: '83060', yahooCode: '8306', name: '三菱UFJフィナンシャル・グループ' }
];

// オルカン(eMAXIS Slim 全世界株式(オール・カントリー))の協会コード
const ORCAN_FUND_CODE = '0331418A';

// 日付を YYYYMMDD 形式の文字列にする小さな道具
function toYyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// ------------------------------------------------------------
// J-Quants: 指定した銘柄コードの「約3ヶ月前時点」のPER/PBRを取得
// これは「今日の値段」ではなく、指標の長期的な推移を見るための参考値です。
// 無料プランでは直近12週間より前のデータしか取れないため、
// 少し過去にさかのぼった期間を指定して、その中の一番新しいものを使います。
// ------------------------------------------------------------
async function fetchLongTermIndicator(code) {
  const today = new Date();
  const to = new Date(today);
  to.setDate(to.getDate() - 84); // 12週間(84日)前
  const from = new Date(to);
  from.setDate(from.getDate() - 21); // 土日・祝日を考慮して3週間分の幅を持たせる

  const fromStr = toYyyymmdd(from);
  const toStr = toYyyymmdd(to);

  const headers = { 'x-api-key': JQUANTS_API_KEY };

  const valuationRes = await fetch(
    `https://api.jquants.com/v2/equities/valuation?code=${code}&from=${fromStr}&to=${toStr}`,
    { headers }
  );

  if (!valuationRes.ok) {
    const text = await valuationRes.text();
    throw new Error(`J-Quants 指標取得エラー(銘柄${code}): ${valuationRes.status} ${text}`);
  }

  const valuationJson = await valuationRes.json();
  const valuationData = (valuationJson.data || []).slice().sort((a, b) => a.Date.localeCompare(b.Date));
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
  // 正しい場所が判明したので、ここから読み取ります
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
// APIエンドポイント(スマホアプリ側からはこのURLを呼び出します)
// ============================================================

// 保有株一覧: 松井証券ページの「今日に近い」株価 + J-Quantsの「約3ヶ月前」の指標
app.get('/api/stocks', async (req, res) => {
  try {
    const results = await Promise.all(
      STOCK_CODES.map(async (s) => {
        // どちらかが失敗しても、もう片方の結果は返せるようにそれぞれ個別にtry/catchします
        let current = null;
        let currentError = null;
        try {
          current = await scrapeStockPrice(s.yahooCode);
        } catch (err) {
          currentError = err.message;
        }

        let longTermIndicator = null;
        let longTermError = null;
        try {
          longTermIndicator = await fetchLongTermIndicator(s.jquantsCode);
        } catch (err) {
          longTermError = err.message;
        }

        return {
          name: s.name,
          code: s.yahooCode,
          current, // 今日に近い株価・PER/PBR(松井証券の公開ページ、非公式)
          currentError,
          longTermIndicator, // 約3ヶ月前時点のPER/PBR(J-Quants、公式・無料)
          longTermError
        };
      })
    );
    res.json({ stocks: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// オルカンの基準価額など
app.get('/api/orcan', async (req, res) => {
  try {
    const data = await fetchOrcanData();
    res.json({ orcan: data.value, debugRaw: data.value ? undefined : data.raw });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ニュース見出し一覧(保有銘柄名 + 世界経済 + 日本株、それぞれ数件ずつ)
app.get('/api/news', async (req, res) => {
  try {
    const keywords = [...STOCK_CODES.map((s) => s.name), '日本株', '世界経済'];
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

// 動作確認用トップページ
app.get('/', (req, res) => {
  res.send('マイ資産アプリ バックエンドAPI 稼働中です。/api/stocks, /api/orcan, /api/news をお試しください。');
});

app.listen(PORT, () => {
  console.log(`サーバーがポート${PORT}で起動しました`);
});
