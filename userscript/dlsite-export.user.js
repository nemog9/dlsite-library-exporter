// ==UserScript==
// @name         Hikidashi: DLsite 購入履歴を CSV に書き出す
// @description  DLsite の購入履歴（ボイス・コミック・CG など）を、Hikidashi（iOS アプリ）に取り込める CSV にする。iPhone の Safari + Userscripts 用。
// @version      0.1.0
// @homepageURL  https://github.com/nemog9/dlsite-library-exporter
// @downloadURL  https://raw.githubusercontent.com/nemog9/dlsite-library-exporter/main/userscript/dlsite-export.user.js
// @updateURL    https://raw.githubusercontent.com/nemog9/dlsite-library-exporter/main/userscript/dlsite-export.user.js
// @match        https://www.dlsite.com/*/mypage/userbuy*
// @run-at       document-idle
// @noframes
// ==/UserScript==

// 非公式のツールです。自分の購入履歴を、自分のブラウザの中だけで処理して、CSV にします。外部には何も送りません。
// 購入履歴の一覧を数ページずつ読み、作品ごとに DLsite の product.json（作品情報の JSON）から声優などを取ります。
// 負荷をかけないよう、1 件ずつ、間隔を空けて読み、拒否されたらその場で止めます（取得済みの分は、端末に覚えているので、続きから再開できます）。

(() => {
  'use strict';
  if (window.__hikidashiDlsiteExport) return;
  window.__hikidashiDlsiteExport = true;

  const PAGE_GAP = [800, 1600];      // 一覧ページを読む間隔（ミリ秒、この範囲でばらつかせる）
  const DETAIL_GAP = [500, 1000];    // 作品情報を読む間隔
  const SAVE_EVERY = 20;             // これだけ取れるたびに、端末へ保存する
  const CACHE_KEY = 'hikidashi.dlsiteexport.cache.v1';
  const HEADER = ['title', 'url', 'creators', 'thumbnail_url', 'category', 'note', 'favorite', 'hidden'];
  const ID_RE = /\/product_id\/([A-Z]{2}\d+)/;
  const CATEGORY = { SOU: 'ボイス', MNG: 'コミック', ICG: 'CG', MOV: '動画' };   // それ以外は DLsite の作品形式名のまま

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = ([lo, hi]) => delay(lo + Math.random() * (hi - lo));
  const pad = (n) => String(n).padStart(2, '0');

  // ---- CSV（dmm-exporter の csv.js と同じ内容） ----
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const buildCSV = (rows) => '﻿' + [HEADER.map(q).join(','),
    ...rows.map((r) => [r.title, r.url, r.creators.join('|'), r.thumbnail, r.category, r.note || '', r.favorite || '', r.hidden || ''].map(q).join(','))].join('\n') + '\n';

  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') endField();
      else if (ch === '\r') { endRow(); if (text[i + 1] === '\n') i++; }
      else if (ch === '\n') endRow();
      else field += ch;
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  const norm = (s) => (s || '').trim().toLowerCase();
  const ALIASES = {
    title: ['title', 'タイトル'], url: ['url'], creators: ['creators', 'クリエイター'],
    circle: ['サークル名', 'サークル', 'circle'], cv: ['声優', '作者', 'cv', 'actors'],
    thumbnail: ['thumbnail_url', 'thumbnail', 'サムネイル'], category: ['category', 'ジャンル', 'カテゴリ'],
    note: ['note', 'メモ'], favorite: ['favorite', 'お気に入り'], hidden: ['hidden', '非表示'],
  };
  const splitNames = (s) => (s || '').split(/[|｜,，、;；]/).map((x) => x.trim()).filter(Boolean);
  const dedupe = (names) => { const seen = new Set(); return names.filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); };
  const flag = (v) => { const t = norm(v); return ['1', 'true', 'yes', 'y', '○', 'はい'].includes(t) ? '1' : ['0', 'false', 'no', 'n'].includes(t) ? '0' : ''; };
  const productId = (url) => (url || '').match(ID_RE)?.[1] || '';

  /** 前回の CSV（Hikidashi の書き出し）→ 作品の配列。 */
  function readItems(text) {
    const rows = parseCSV(text);
    if (!rows.length) return [];
    const header = rows[0].map(norm);
    const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, header.findIndex((h) => ALIASES[k].map(norm).includes(h))]));
    if (idx.url < 0) return [];
    const get = (r, k) => (idx[k] >= 0 && idx[k] < r.length ? r[idx[k]] : '');
    return rows.slice(1).filter((r) => get(r, 'url')).map((r) => ({
      title: get(r, 'title').trim(), url: get(r, 'url').trim(),
      creators: dedupe([...splitNames(get(r, 'creators')), ...splitNames(get(r, 'circle')), ...splitNames(get(r, 'cv'))]),
      thumbnail: get(r, 'thumbnail').trim(), category: get(r, 'category').trim(),
      note: get(r, 'note'), favorite: flag(get(r, 'favorite')), hidden: flag(get(r, 'hidden')),
    }));
  }

  // ---- DLsite の読み取り ----
  const httpsURL = (u) => (u || '').replace(/^\/\//, 'https://').replace(/^http:/, 'https:');
  const SALE_TAG = /^(?:【[^】]*(?:期間限定|OFF|off|％|%|円|セール|SALE|sale|キャンペーン|割引)[^】]*】\s*)+/;
  const cleanTitle = (s) => ((s || '').replace(SALE_TAG, '').trim() || (s || '').trim());

  /** 購入履歴の 1 ページ分（HTML）→ 作品の配列（新しい購入が先頭）。 */
  function parseListPage(doc) {
    return [...doc.querySelectorAll('.buy_work_list li')].map((li) => {
      const a = li.querySelector('a[href*="/product_id/"]');
      const href = a?.getAttribute('href') || '';
      const id = href.match(ID_RE)?.[1];
      if (!id) return null;
      const maker = (li.querySelector('.maker_name')?.textContent || '').trim();
      const title = (a.getAttribute('title') || a.textContent || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      const genre = [...li.querySelectorAll('.work_genre span')].map((s) => s.textContent.trim()).filter((t) => t && !/^(R18|R15|全年齢)$/.test(t)).pop() || '';
      return { id, title, maker, genre, href: httpsURL(href).replace(/[?#].*$/, ''), thumbnail: httpsURL(li.querySelector('img')?.getAttribute('src')) };
    }).filter(Boolean);
  }

  /** product.json の 1 件（無ければ null）→ CSV の 1 行ぶん。 */
  function toEntry(item, d) {
    const cr = (() => { try { return typeof d?.creaters === 'string' ? JSON.parse(d.creaters) : (d?.creaters || {}); } catch { return {}; } })();
    const names = (k) => (Array.isArray(cr[k]) ? cr[k] : []).map((x) => (x?.name || '').trim()).filter(Boolean);
    const people = names('voice_by').length ? names('voice_by')
      : names('author_by').length ? names('author_by')
      : [...names('illust_by'), ...names('scenario_by')];
    const im = d?.image_main;
    const image = httpsURL(typeof im === 'string' ? im : im?.url) || item.thumbnail;
    const site = d?.site_id || '';
    return {
      t: cleanTitle(d?.work_name || item.title),
      u: site ? `https://www.dlsite.com/${site}/work/=/product_id/${item.id}.html` : item.href.replace('-touch', ''),
      c: dedupe([d?.maker_name || item.maker, ...people]),
      th: image,
      k: CATEGORY[d?.work_type] || d?.work_type_string || item.genre,
    };
  }

  // ---- 端末に覚える（取得済みの作品。拒否されて止まっても、続きから再開できる） ----
  const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } };
  const saveCache = (c) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* 保存できなくても続ける */ } };

  // ---- 画面 ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:12px;z-index:2147483647;background:#fff;color:#1c1c1e;border:2px solid #1d6fd6;border-radius:14px;padding:12px;font:14px/1.45 -apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">Hikidashi 書き出し（DLsite）</div>
    <div id="hk-msg" style="margin-bottom:8px;white-space:pre-wrap">購入履歴を CSV にします。</div>
    <div id="hk-bar" style="height:8px;background:#eee;border-radius:4px;overflow:hidden;margin-bottom:10px"><div id="hk-fill" style="height:100%;width:0;background:#1d6fd6"></div></div>
    <div id="hk-csv" style="margin-bottom:8px;font-size:13px;color:#555"></div>
    <div id="hk-btns" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    <input id="hk-file" type="file" accept=".csv,text/csv,text/plain,text/comma-separated-values" style="display:none">`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector('#' + id);
  const setMsg = (t) => { $('hk-msg').textContent = t; };
  const setProgress = (r) => { $('hk-fill').style.width = `${Math.round(Math.max(0, Math.min(1, r)) * 100)}%`; };
  const btn = (label, onClick, primary = true) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:10px 14px;border-radius:10px;border:${primary ? '0' : '1px solid #1d6fd6'};background:${primary ? '#1d6fd6' : '#fff'};color:${primary ? '#fff' : '#1d6fd6'};font-weight:700;font-size:14px`;
    b.addEventListener('click', onClick);
    return b;
  };
  const setButtons = (...bs) => { const c = $('hk-btns'); c.textContent = ''; bs.forEach((b) => c.appendChild(b)); };
  const fmtDuration = (sec) => {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `約 ${sec} 秒`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `約 ${m} 分 ${s} 秒` : `約 ${m} 分`;
  };

  let wakeLock = null;
  const keepAwake = async () => { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 使えなくても続ける */ } };
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

  let running = false;
  let cancelled = false;

  let prevRows = [];
  let prevName = '';
  const renderCsvState = () => {
    const el = $('hk-csv');
    el.textContent = '';
    const chooser = btn(prevRows.length ? '前回の CSV を選び直す' : '前回の CSV を選ぶ（任意）', () => $('hk-file').click(), false);
    chooser.style.padding = '6px 10px'; chooser.style.fontSize = '13px';
    el.appendChild(chooser);
    const label = document.createElement('span');
    label.style.marginLeft = '8px';
    label.textContent = prevRows.length ? `${prevName}（${prevRows.length} 件）` : '選ぶと、新しい作品だけを足して、お気に入りなども保てます。';
    el.appendChild(label);
  };
  $('hk-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      prevRows = readItems(await f.text());
      prevName = f.name;
      if (!prevRows.length) setMsg('この CSV から作品（url 列）を読み取れませんでした。');
    } catch { prevRows = []; setMsg('CSV を読み込めませんでした。'); }
    e.target.value = '';
    renderCsvState();
  });

  // ---- 進み具合の表示（1 秒ごとに更新する） ----
  const state = { phase: 'idle', started: 0, page: 0, pages: 0, found: 0, done: 0, total: 0, detailStart: 0 };
  let ticker = null;
  const render = () => {
    const elapsed = (Date.now() - state.started) / 1000;
    const dots = '.'.repeat(1 + (Math.floor(Date.now() / 1000) % 3));
    const fill = $('hk-fill');
    if (state.phase === 'list') {
      fill.classList.remove('hk-ind');
      setProgress(state.pages ? state.page / state.pages : 0);
      setMsg(`購入履歴を読み込み中${dots} ${state.page} / ${state.pages || '?'} ページ（${state.found} 件）\n経過 ${fmtDuration(elapsed)}\nこの画面を開いたままにしてください。`);
    } else if (state.phase === 'detail') {
      setProgress(state.total ? state.done / state.total : 0);
      const perItem = state.done ? (Date.now() - state.detailStart) / state.done : 0;
      const remain = state.done >= 5 ? `残り ${fmtDuration((state.total - state.done) * perItem / 1000)}` : '残り時間を計測中…';
      setMsg(`声優などを取得中${dots} ${state.done} / ${state.total} 件\n${remain}（経過 ${fmtDuration(elapsed)}）\nこの画面を開いたままにしてください。`);
    }
  };
  const startTicker = () => { stopTicker(); ticker = setInterval(render, 1000); };
  const stopTicker = () => { if (ticker) clearInterval(ticker); ticker = null; };

  // ---- 本体 ----
  async function run(onlyNew) {
    running = true; cancelled = false;
    await keepAwake();
    const cache = loadCache();
    const prevIds = new Set(prevRows.map((r) => productId(r.url)).filter(Boolean));
    const isKnown = (id) => prevIds.has(id) || (id in cache);
    const section = location.pathname.split('/')[1] || 'home-touch';
    const base = location.pathname.replace(/\/page\/\d+.*$/, '').replace(/\/$/, '');
    const started = Date.now();
    Object.assign(state, { phase: 'list', started, page: 0, pages: 0, found: 0, done: 0, total: 0, detailStart: 0 });
    setButtons(btn('中止', () => { cancelled = true; }, false));
    setProgress(0);
    startTicker(); render();

    // 1) 購入履歴を 1 ページずつ読む（新しい購入が先頭）
    const listed = [];                          // 新しい購入から順
    const seen = new Set();
    const total = parseInt((document.body.innerText.match(/([\d,]+)\s*件中/) || [])[1]?.replace(/,/g, '') || '0', 10);
    const perPage = document.querySelectorAll('.buy_work_list li').length || 50;
    state.pages = total ? Math.ceil(total / perPage) : 0;
    let blockedAt = '';
    for (let p = 1; !cancelled && (!state.pages || p <= state.pages); p++) {
      let items;
      if (p === 1 && !/\/page\/\d+/.test(location.pathname)) items = parseListPage(document);
      else {
        try {
          const res = await fetch(`${location.origin}${base}/page/${p}`, { credentials: 'include' });
          if (!res.ok) { blockedAt = `一覧の ${p} ページ目（HTTP ${res.status}）`; break; }
          items = parseListPage(new DOMParser().parseFromString(await res.text(), 'text/html'));
        } catch { blockedAt = `一覧の ${p} ページ目（通信エラー）`; break; }
      }
      state.page = p;
      if (!items.length) break;
      let hitKnown = false;
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        if (isKnown(it.id)) hitKnown = true;
        listed.push(it);
      }
      state.found = listed.length;
      render();
      if (onlyNew && hitKnown) break;           // 新着だけ: 取得済みの作品が出たページで止める（一覧は新しい順）
      await jitter(PAGE_GAP);
    }
    if (cancelled) { stopTicker(); return finish('中止しました。', null); }
    if (!listed.length) { stopTicker(); return finish(blockedAt ? `${blockedAt}で止まりました。しばらく待ってから、もう一度お試しください。` : '作品が見つかりませんでした。購入履歴の一覧ページで実行してください。', null); }

    // 2) まだ取っていない作品の情報を、1 件ずつ読む
    const todo = listed.filter((it) => !isKnown(it.id));
    Object.assign(state, { phase: 'detail', done: 0, total: todo.length, detailStart: Date.now() });
    render();
    let sinceSave = 0;
    for (const it of todo) {
      if (cancelled || blockedAt) break;
      try {
        const res = await fetch(`${location.origin}/${section}/api/=/product.json?workno=${it.id}`, { credentials: 'include' });
        const json = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => undefined) : undefined;
        if (!res.ok || json === undefined) { blockedAt = `作品情報（HTTP ${res.status}）`; break; }
        const d = Array.isArray(json) ? json[0] : json;
        cache[it.id] = toEntry(it, d || null);          // 取れなかった作品（販売終了など）は、一覧にある情報だけで作る
      } catch { blockedAt = '作品情報（通信エラー）'; break; }
      state.done++;
      if (++sinceSave >= SAVE_EVERY) { saveCache(cache); sinceSave = 0; }
      render();
      await jitter(DETAIL_GAP);
    }
    saveCache(cache);
    stopTicker();

    // 3) CSV を作る。既存の行はそのまま先頭に、新しい作品は古い順にして末尾へ（Hikidashi は行の順に番号を振るので、最後に買ったものが一番上に来る）。
    const fresh = listed.filter((it) => !prevIds.has(it.id) && cache[it.id]).map((it) => {
      const e = cache[it.id];
      return { title: e.t, url: e.u, creators: e.c, thumbnail: e.th, category: e.k };
    });
    const rows = [...prevRows, ...fresh.slice().reverse()];
    const csv = buildCSV(rows);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const baseName = prevName ? prevName.replace(/\.csv$/i, '').replace(/-\d{8}-\d{6}$/, '') : 'dlsite-library';
    const file = { csv, filename: `${baseName}-${stamp}.csv` };
    const elapsed = fmtDuration((Date.now() - started) / 1000);
    const fetchedAll = todo.every((it) => cache[it.id]);
    if (cancelled) return finish(`中止しました。ここまでの ${fresh.length} 件は、保存できます（取得済みの分は、端末に覚えています）。`, fresh.length ? file : null);
    if (blockedAt) return finish(`${blockedAt}で止まりました。ここまでの ${fresh.length} 件は、保存できます。\nしばらく（数十分〜数時間）待ってから「続きから」を押すと、残りだけを取得します。`, fresh.length ? file : null);
    if (!fresh.length) return finish('新しい作品はありませんでした。', null);
    finish(`完了！新しい作品 ${fresh.length} 件${fetchedAll ? '' : '（一部は取得できませんでした）'}${prevRows.length ? `（前回の ${prevRows.length} 件と合わせて計 ${rows.length} 件）` : ''}（${elapsed}）。\n下のボタンで保存し、Hikidashi の「設定 → CSV をインポート」で選んでください。`, file);
  }

  function finish(message, file) {
    running = false;
    try { wakeLock?.release(); } catch { /* 無視 */ }
    setMsg(message);
    setProgress(file ? 1 : 0);
    const buttons = [];
    if (file) {
      const blob = new Blob([file.csv], { type: 'text/csv;charset=utf-8' });
      buttons.push(btn('CSV を保存', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = file.filename;
        document.body.appendChild(a); a.click(); a.remove();
      }));
      if (navigator.canShare?.({ files: [new File([blob], file.filename, { type: 'text/csv' })] })) {
        buttons.push(btn('共有…', () => navigator.share({ files: [new File([blob], file.filename, { type: 'text/csv' })] }).catch(() => {}), false));
      }
    }
    buttons.push(btn('全件・続きから', () => run(false), !file), btn('新着だけ', () => run(true), false));
    buttons.push(btn('覚えた分を消す', () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* 無視 */ } setMsg('端末に覚えていた取得済みの作品を消しました。'); }, false));
    setButtons(...buttons);
  }

  renderCsvState();
  const cached = Object.keys(loadCache()).length;
  setMsg(`購入履歴を CSV にします。初回は「全件・続きから」（1,000 件で 25 分ほど）、2 回目以降は、前回の CSV を選んで「新着だけ」が速いです。${cached ? `\n端末に覚えている取得済みの作品: ${cached} 件` : ''}`);
  setButtons(btn('全件・続きから', () => run(false)), btn('新着だけ', () => run(true), false));
})();
