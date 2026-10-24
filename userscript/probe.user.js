// ==UserScript==
// @name         DLsite 購入履歴 診断（product.json の項目名を調べる）
// @description  product.json の項目名と、複数の作品番号をまとめて渡せるかを調べる。通信は、合計 3 回。
// @version      0.3.0
// @match        https://www.dlsite.com/*/mypage/userbuy*
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const clip = (s, n = 2500) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n}文字)` : s);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const btn = document.createElement('button');
  btn.textContent = '診断 2 を実行';
  btn.style.cssText = 'position:fixed;right:12px;bottom:80px;z-index:2147483647;padding:12px 16px;border-radius:12px;border:0;background:#1d6fd6;color:#fff;font-weight:700;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  document.body.appendChild(btn);
  const out = document.createElement('div');
  out.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;max-height:45vh;overflow:auto;background:#fff;color:#000;border:2px solid #1d6fd6;border-radius:10px;padding:10px;font:12px/1.4 monospace;display:none;white-space:pre-wrap';
  document.body.appendChild(out);
  const say = (t) => { out.style.display = 'block'; out.textContent = t; };

  // 値は、短い型の情報だけにする（文字列は先頭だけ）。
  const brief = (v) => (typeof v === 'string' ? clip(v, 40) : v);

  const getJSON = async (url) => {
    const t0 = performance.now();
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, bytes: text.length, ms: Math.round(performance.now() - t0), json };
  };

  async function run() {
    btn.disabled = true;
    const report = { script: 'userbuy probe 0.3.0', at: new Date().toISOString() };
    const idRe = /\/product_id\/([A-Z]{2}\d+)/;
    const section = (location.pathname.match(/^\/([^/]+)\//) || [])[1] || 'home-touch';
    const origin = location.origin;

    // 1) 一覧: 1 件ぶんの li 全体と、ページ送りの URL（全文）
    const li = document.querySelector('li.gift_work, .buy_work_list li');
    report.firstLi = li ? clip(li.outerHTML.replace(/\s+/g, ' '), 3500) : null;
    report.liCount = document.querySelectorAll('.buy_work_list li').length;
    report.pager = [...document.querySelectorAll('a')].filter((a) => /\/userbuy\//.test(a.href) && /^\d+$|次/.test(a.textContent.trim())).slice(0, 8)
      .map((a) => ({ text: a.textContent.trim(), href: a.href.replace(origin, '') }));

    const ids = [...new Set([...document.querySelectorAll('a[href]')].map((a) => (a.href.match(idRe) || [])[1]).filter(Boolean))];
    report.ids = ids.length;
    if (!ids.length) { report.note = '購入履歴の一覧ページで実行してください。'; return finish(report); }

    // 2) product.json 1 件: 項目名の一覧と、人名・タイトルらしい項目の中身
    say('診断中…（1/3）product.json 1 件');
    const one = await getJSON(`${origin}/${section}/api/=/product.json?workno=${ids[0]}`);
    const item = Array.isArray(one.json) ? one.json[0] : one.json;
    report.one = { status: one.status, ms: one.ms, isArray: Array.isArray(one.json), keys: item ? Object.keys(item) : null };
    if (item) {
      const pick = {};
      for (const k of Object.keys(item)) {
        if (/name|title|creat|voice|illust|author|writer|scenario|music|maker|circle|work_type|category|genre|regist|date/i.test(k)) pick[k] = item[k] && typeof item[k] === 'object' ? clip(JSON.stringify(item[k]), 600) : brief(item[k]);
      }
      report.one.picked = pick;
    }
    await delay(2000);

    // 3) まとめ取り: 先頭 20 件をカンマ区切りで
    say('診断中…（2/3）product.json まとめ取り');
    const batch = ids.slice(0, 20);
    const many = await getJSON(`${origin}/${section}/api/=/product.json?workno=${batch.join(',')}`);
    report.batch = { asked: batch.length, status: many.status, bytes: many.bytes, ms: many.ms, isArray: Array.isArray(many.json), returned: Array.isArray(many.json) ? many.json.length : (many.json ? Object.keys(many.json).length : 0) };
    if (Array.isArray(many.json)) report.batch.sameOrder = many.json.map((x) => x.workno).join() === batch.join();
    await delay(2000);

    // 4) 一覧の次のページ（URL の形の確認だけ。取得はしない）
    say('診断中…（3/3）まとめ');
    finish(report);
  }

  function finish(report) {
    const json = JSON.stringify(report, null, 2);
    say(json);
    btn.textContent = 'コピー';
    btn.disabled = false;
    btn.onclick = async () => { try { await navigator.clipboard.writeText(json); btn.textContent = 'コピーしました'; } catch { btn.textContent = '長押しでコピー'; } };
  }

  btn.onclick = () => run().catch((e) => { say('エラー: ' + e); btn.disabled = false; });
})();
