/* Market Pulse layout check: paste-run in the browser on Market_Pulse(.html) after it has loaded.
   Clicks every watchlist row and every chart period, opens "What's moving the market", and reports:
   page side-scroll, watchlist column misalignment, cut-off names, overlapping / clipped / too-small chart labels,
   overflowing card text, and the Live-today tab vs filter alignment. Returns { width, problems: [...] }. */
(async () => {
  const P = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const R = e => e.getBoundingClientRect();
  const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const svgCheck = (root, where) => {
    root.querySelectorAll('svg').forEach(svg => {
      const sb = R(svg), T = [...svg.querySelectorAll('text')];
      T.forEach(t => {
        const b = R(t);
        if (b.height && b.height < 10) P.push(`${where}: label "${t.textContent}" too small (${b.height.toFixed(1)}px)`);
        if (b.left < sb.left - 1 || b.right > sb.right + 1 || b.top < sb.top - 1 || b.bottom > sb.bottom + 1) P.push(`${where}: label "${t.textContent}" goes outside the chart`);
      });
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (hit(R(T[i]), R(T[j]))) P.push(`${where}: "${T[i].textContent}" overlaps "${T[j].textContent}"`);
      if (sb.right > R(svg.closest('.card,.nkc') || document.body).right + 1) P.push(`${where}: chart wider than its card`);
    });
  };
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) P.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${W})`);
  // watchlist
  const head = [...document.querySelectorAll('.wlh span')], row = document.querySelector('.wr');
  if (row) [...row.children].forEach((c, i) => { if (i && Math.abs(R(c).right - R(head[i]).right) > 1.5) P.push(`watchlist column ${i} not aligned with its header`); });
  document.querySelectorAll('.wr .n').forEach(n => { if (n.scrollWidth > n.clientWidth + 1) P.push(`watchlist name cut off: ${n.textContent}`); });
  document.querySelectorAll('.wr').forEach(r => { if (R(r).height > 34) P.push(`watchlist row on two lines: ${r.querySelector('.n').textContent}`); });
  // live tab vs filters
  const dot = document.querySelector('#tabLive .live-dot'), chip = document.querySelector('#lchips button');
  if (dot && chip && Math.abs(R(dot).left - R(chip).left) > 4) P.push(`Live today tab (${R(dot).left|0}) not lined up with filters (${R(chip).left|0})`);
  if (chip && R(chip).top - R(document.querySelector('.tabs')).bottom < 4) P.push('filters touch the tab line');
  // every row × every period
  const names = [...document.querySelectorAll('.wr .n')].map(n => n.textContent);
  for (const nm of names) {
    [...document.querySelectorAll('.wr')].find(b => b.querySelector('.n').textContent === nm).click(); await wait(60);
    const who = document.getElementById('perfWho'), tiles = document.getElementById('tiles');
    if (hit(R(who), R(tiles))) P.push(`${nm}: title overlaps the return boxes`);
    const wb = who.querySelector('b'); if (wb && wb.scrollWidth > wb.clientWidth + 1) P.push(`${nm}: title cut off`);
    for (const k of ['1W', '1M', '3M', '6M', 'YTD', '1Y']) {
      const t = document.querySelector(`.tile[data-r="${k}"]`); if (!t) continue; t.click(); await wait(40);
      const pc = document.getElementById('pchart');
      if (!pc.querySelector('svg') && !/Not enough history/.test(pc.textContent)) P.push(`${nm} ${k}: no chart (${pc.textContent.trim()})`);
      svgCheck(pc, `${nm} ${k}`);
      if (R(pc).right > R(document.getElementById('perf')).right + 1) P.push(`${nm} ${k}: chart sticks out of the panel`);
    }
  }
  // what's moving the market, opened
  const why = document.getElementById('why'), was = why.open; why.open = true; await wait(400);
  svgCheck(document.getElementById('whyBody'), 'What\'s moving');
  document.querySelectorAll('#whyBody .nkc').forEach(c => { if (c.scrollWidth > c.clientWidth + 1) P.push(`What's moving: "${c.querySelector('h5').textContent}" content wider than its card`); });
  document.querySelectorAll('#whyBody .dvb span:first-child').forEach(s => { if (R(s).height > 20) P.push(`sector name wraps: ${s.textContent}`); });
  if (document.documentElement.scrollWidth > W + 1) P.push('page scrolls sideways with the panel open');
  why.open = was;
  return { width: W, problems: [...new Set(P)] };
})()
