/* Press Room mockup behaviour: one chart with three modes (Navigate / Edit / Timing),
   in-place word timing with drag-anywhere and chart zoom, the zoomable navigation bar with loop ranges,
   the locked "not analyzed" state, and PDF export.
   Builds on mockup-core.js (window.ChordBuddyMock). Still a mockup: nothing is saved anywhere. */
document.addEventListener('DOMContentLoaded', function () {
  'use strict';
  const M = window.ChordBuddyMock;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const root = document.documentElement;
  const T = M.TOTAL, BAR = M.SONG.barSeconds, BEAT = BAR / 4;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const keyOf = (e) => `${e.si}-${e.ri}-${e.bi}-${e.ci}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- little helpers ----------
  let toastTimer;
  function toast(msg) {
    $('#toast-text').textContent = msg; $('#toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2400);
  }
  let saveTimer;
  function saving() {
    const s = $('#saved'); s.classList.add('busy'); s.querySelector('em').textContent = 'Saving…';
    clearTimeout(saveTimer); saveTimer = setTimeout(() => { s.classList.remove('busy'); s.querySelector('em').textContent = 'Saved'; }, 650);
  }
  const typing = (el) => el && el.closest && el.closest('input,textarea,[contenteditable="plaintext-only"],[contenteditable="true"]');

  // ---------- Song model: chords per bar, and every lyric word with a musical position ----------
  // A word's pos is measured in beats from the start of its line (row). Chord-anchored words sit on
  // their chord; pinned words were placed by hand; everything else spreads out evenly between them.
  const rows = [];
  M.SONG.sections.forEach((sec, si) => sec.rows.forEach((r, ri) => {
    const bars = r.bars.map((b) => ({ chords: b.map((c, ci) => ({ label: typeof c === 'string' ? c : c[0], onset: (ci * 4) / b.length })) }));
    const nPass = Math.max(0, ...r.bars.flat().map((c) => (typeof c === 'string' ? 0 : c.length - 1)));
    const row = { si, ri, reps: r.reps || 1, bars, lanes: [], idx: rows.length, target: 0 };
    for (let p = 0; p < nPass; p++) {
      const toks = [];
      r.bars.forEach((b, bi) => b.forEach((c, ci) => {
        if (typeof c === 'string') return;
        (c[p + 1] || '').trim().split(/\s+/).filter(Boolean).flatMap((w) => w.split(/(?<=-)/))
          .forEach((w, wi) => toks.push({ w, pos: bi * 4 + (ci * 4) / b.length, pinned: false, anchor: wi === 0 }));
      }));
      row.lanes.push(arrange(toks, bars.length * 4));
    }
    rows.push(row);
  }));
  function arrange(toks, len) {
    const fixed = toks.map((t) => t.pinned || t.anchor);
    let i = 0;
    while (i < toks.length) {
      if (fixed[i]) { i++; continue; }
      let j = i; while (j < toks.length && !fixed[j]) j++;
      const a = i > 0 ? toks[i - 1].pos : 0, b = j < toks.length ? toks[j].pos : len;
      const n = j - i; for (let k = 0; k < n; k++) toks[i + k].pos = a + ((k + 1) * (b - a)) / (n + 1);
      i = j;
    }
    return toks;
  }
  const rowOf = (si, ri) => rows.find((r) => r.si === si && r.ri === ri);
  function rowStart(r, p) {
    const e = M.events.find((x) => x.si === r.si && x.ri === r.ri && x.bi === 0 && x.ci === 0 && x.pass === p)
      || M.events.find((x) => x.si === r.si && x.ri === r.ri && x.bi === 0 && x.ci === 0);
    return e ? e.start : 0;
  }
  const wordTime = (r, p, pos) => rowStart(r, p) + pos * BEAT;
  const barNo = (r, bi, p = 0) => Math.floor(rowStart(r, p) / BAR + 1e-6) + 1 + bi;
  function chunkSpan(r, bi, ci) {
    const ch = r.bars[bi].chords, start = bi * 4 + ch[ci].onset;
    const end = ci + 1 < ch.length ? bi * 4 + ch[ci + 1].onset : (bi + 1) * 4;
    return [start, bi === r.bars.length - 1 && ci === ch.length - 1 ? Infinity : end];
  }
  const wordsIn = (r, p, bi, ci) => { const [a, b] = chunkSpan(r, bi, ci); return (r.lanes[p] || []).map((t, i) => ({ t, i })).filter(({ t }) => t.pos >= a - 1e-6 && t.pos < b - 1e-6); };
  const joinWords = (list, fn) => list.map((x, k) => fn(x) + (k < list.length - 1 && !x.t.w.endsWith('-') ? ' ' : '')).join('');
  // Keep the playback events (chord highlight) in step with chord edits.
  function rebuildBarEvents(r, bi) {
    const bar = r.bars[bi];
    for (let p = 0; p < r.reps; p++) {
      const idx = M.events.findIndex((e) => e.si === r.si && e.ri === r.ri && e.bi === bi && e.pass === p);
      if (idx < 0) continue;
      let n = 0; while (M.events[idx + n] && M.events[idx + n].si === r.si && M.events[idx + n].ri === r.ri && M.events[idx + n].bi === bi && M.events[idx + n].pass === p) n++;
      const s = M.events[idx].start, barNoV = M.events[idx].barNo;
      const fresh = bar.chords.map((c, ci) => ({ si: r.si, ri: r.ri, bi, ci, pass: p, label: c.label, start: s + c.onset * BEAT, end: s + (ci + 1 < bar.chords.length ? bar.chords[ci + 1].onset : 4) * BEAT, barNo: barNoV }));
      M.events.splice(idx, n, ...fresh);
    }
  }

  // ---------- Rendering: one chart, drawn for the current mode ----------
  let tz = 2, snap = 0.5, scope = 'one';
  const TZ = [0.75, 1, 1.5, 2, 3, 4, 6];
  const beatPx = () => 32 * tz;
  function render() {
    const mode = root.dataset.mode, chart = $('#chart');
    chart.style.setProperty('--bp', beatPx() + 'px'); chart.style.setProperty('--sp', beatPx() * snap + 'px');
    chart.innerHTML = M.SONG.sections.map((sec, si) => `<section class="sec" data-sec="${si}" data-name="${sec.name.toLowerCase()}">
      <header class="sec-head"><span class="sec-num">${String(si + 1).padStart(2, '0')}</span><h3 class="sec-name"${mode === 'edit' ? ' contenteditable="plaintext-only"' : ''}>${esc(sec.name)}</h3><span class="sec-time">${M.fmt(M.sectionSpans[si].start)}</span></header>
      ${rows.filter((r) => r.si === si).map((r) => (mode === 'timing' ? timingRow(r) : compactRow(r, mode))).join('')}</section>`).join('');
    M.markLineStarts();
    if (mode === 'timing') stagger();
    lastWk = null; pageBreaks(); M.update(true);
  }
  function tail(bar, r, isLast) { return isLast ? `<span class="tail">${bar}${r.reps > 1 ? `<span class="repeat" title="Played ${r.reps} times">(×${r.reps})</span>` : ''}</span>` : bar; }
  function compactRow(r, mode) {
    const passes = r.lanes.length, edit = mode === 'edit';
    const labels = passes > 1 ? `<span class="pass-labels">${r.lanes.map((_, p) => `<span data-pass="${p}" class="${edit && p === r.target ? 'target' : ''}">${p + 1}</span>`).join('')}</span>` : '';
    const bars = r.bars.map((b, bi) => tail(`<div class="bar${bi === r.bars.length - 1 ? ' last' : ''}" data-bi="${bi}">${labels}${b.chords.map((c, ci) => {
      const lyr = r.lanes.map((_, p) => {
        const ws = wordsIn(r, p, bi, ci);
        return edit ? `<span class="lyr" data-pass="${p}" data-ph="…" contenteditable="plaintext-only">${esc(joinWords(ws, (x) => x.t.w))}</span>`
          : `<span class="lyr" data-pass="${p}">${joinWords(ws, (x) => `<span class="w" data-wk="${r.idx}-${p}-${x.i}" data-t="${wordTime(r, p, x.t.pos)}">${esc(x.t.w)}</span>`)}</span>`;
      }).join('');
      return `<span class="chunk" data-k="${r.si}-${r.ri}-${bi}-${ci}"><button class="chord" data-chord="${esc(c.label)}">${M.chordHTML(c.label)}</button>${lyr}${edit ? '<button class="add-chord" title="Add a chord after this one">+</button>' : ''}</span>`;
    }).join('')}</div>`, r, bi === r.bars.length - 1)).join('');
    const addL = edit && !passes ? `<button class="add-lyrics" data-r="${r.idx}">${M.icon('text')}Add lyrics</button>` : '';
    return `<div class="row${passes ? ' has-lyrics' : ''}" data-row="${r.si}-${r.ri}" data-ri="${r.idx}" data-passes="${passes}"><div class="bars">${bars}${addL}</div></div>`;
  }
  function timingRow(r) {
    const bp = beatPx(), lanesN = Math.max(1, r.lanes.length);
    const bars = r.bars.map((b, bi) => {
      const no = r.reps > 1 ? Array.from({ length: r.reps }, (_, p) => barNo(r, bi, p)).join(' · ') : barNo(r, bi);
      const chords = b.chords.map((c, ci) => `<span class="chunk tchord" data-k="${r.si}-${r.ri}-${bi}-${ci}" style="left:${c.onset * bp}px"><span class="chord">${M.chordHTML(c.label)}</span></span>`).join('');
      const lanes = Array.from({ length: lanesN }, (_, p) => {
        const chips = (r.lanes[p] || []).map((t, i) => (t.pos >= bi * 4 - 1e-6 && t.pos < bi * 4 + 4 - 1e-6)
          ? `<span class="wchip${t.pinned ? ' pinned' : ''}${t.anchor && !t.pinned ? ' anchor' : ''}" data-wk="${r.idx}-${p}-${i}" data-r="${r.idx}" data-p="${p}" data-i="${i}" style="left:${(t.pos - bi * 4) * bp}px" title="${t.pinned ? 'Pinned · click to release' : t.anchor ? 'Sits on its chord · drag to move' : 'Spread automatically · drag to pin'}"><span class="pinb">${M.icon('pin')}</span>${esc(t.w)}</span>` : '').join('');
        return `<div class="tlane${r.lanes[p] ? '' : ' empty'}" data-r="${r.idx}" data-p="${p}" data-label="${lanesN > 1 ? p + 1 : ''}">${chips}</div>`;
      }).join('');
      return tail(`<div class="bar tbar${bi === r.bars.length - 1 ? ' last' : ''}" data-r="${r.idx}" data-bi="${bi}" style="width:${4 * bp}px"><span class="tno">${no}</span><div class="tchords">${chords}</div>${lanes}</div>`, r, bi === r.bars.length - 1);
    }).join('');
    return `<div class="row trow${r.lanes.length ? ' has-lyrics' : ''}" data-row="${r.si}-${r.ri}" data-ri="${r.idx}" data-passes="${r.lanes.length}"><div class="bars">${bars}</div></div>`;
  }
  // Words that would collide inside a measure stack onto extra rows instead of overlapping.
  function stagger() {
    $$('.tlane').forEach((lane) => {
      const chips = $$('.wchip', lane).sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
      const right = []; let max = 0;
      chips.forEach((c) => {
        const l = parseFloat(c.style.left); let row = 0;
        while (right[row] !== undefined && l < right[row] + 4) row++;
        right[row] = l + c.offsetWidth; max = Math.max(max, row);
        c.style.top = 4 + row * 27 + 'px'; c.style.setProperty('--row', row);
      });
      lane.style.height = 32 + max * 27 + 'px';
    });
  }

  // ---------- modes ----------
  function setMode(m) {
    const was = root.dataset.mode;
    root.dataset.mode = m;
    const desk = $('#desk');
    if (m === 'nav') desk.setAttribute('data-autoscroll', '18'); else desk.removeAttribute('data-autoscroll');
    keepPlace(() => render());
    if (was === 'timing' && m !== 'timing' && timingTouched) { toast('Timing saved. Words now sit under the chords they fall within.'); timingTouched = false; }
  }
  // Re-render without losing your place: keep the section nearest the top of the view where it was.
  function keepPlace(fn, anchorEl) {
    const desk = $('#desk'), dr = desk.getBoundingClientRect();
    const ref = anchorEl || $$('#chart .sec').find((s) => s.getBoundingClientRect().bottom > dr.top + 10);
    const key = ref && (ref.dataset.k ? `.bar[data-r="${ref.dataset.r}"][data-bi="${ref.dataset.bi}"]` : `.sec[data-sec="${ref.dataset.sec}"]`);
    const off = ref ? ref.getBoundingClientRect().top - dr.top : 0;
    fn();
    const again = key && $(key); if (again) desk.scrollTop += again.getBoundingClientRect().top - dr.top - off;
  }
  $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
  document.addEventListener('keydown', (ev) => {
    if (typing(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === 'n') setMode('nav'); else if (k === 'e') setMode('edit'); else if (k === 't') setMode('timing');
    else if (root.dataset.mode === 'timing' && (k === '=' || k === '+')) zoomChart(1); else if (root.dataset.mode === 'timing' && k === '-') zoomChart(-1);
  });
  function segment(id, onPick) {
    $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => { $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); onPick(b); }));
  }
  segment('scope', (b) => scope = b.dataset.scope);
  segment('snap', (b) => { snap = +b.dataset.snap; $('#chart').style.setProperty('--sp', beatPx() * snap + 'px'); });

  // ---------- chart zoom (Timing) ----------
  function zoomChart(dir, anchorBar) {
    const i = TZ.indexOf(tz), ni = clamp(i + dir, 0, TZ.length - 1); if (ni === i) return;
    tz = TZ[ni]; $('#tz-label').textContent = tz + '×';
    keepPlace(() => render(), anchorBar ? Object.assign(anchorBar, {}) : undefined);
  }
  $('#tz-in').onclick = () => zoomChart(1); $('#tz-out').onclick = () => zoomChart(-1);
  $('#desk').addEventListener('wheel', (ev) => {
    if (root.dataset.mode !== 'timing' || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    const bar = ev.target.closest('.tbar'); zoomChart(ev.deltaY < 0 ? 1 : -1, bar ? { dataset: { k: 1, r: bar.dataset.r, bi: bar.dataset.bi }, getBoundingClientRect: () => bar.getBoundingClientRect() } : undefined);
  }, { passive: false });

  // ---------- Timing: drag any word anywhere ----------
  let timingTouched = false;
  const beatName = (b) => `Beat ${+(b + 1).toFixed(3)}`;
  function hit(x, y) {
    const bar = document.elementsFromPoint(x, y).find((el) => el.classList && el.classList.contains('tbar'));
    if (!bar) return null;
    const lanes = $$('.tlane', bar);
    const lane = lanes.find((l) => { const r = l.getBoundingClientRect(); return y >= r.top && y <= r.bottom; })
      || lanes.reduce((best, l) => { const r = l.getBoundingClientRect(), d = Math.abs(y - (r.top + r.bottom) / 2); return !best || d < best.d ? { l, d } : best; }, null)?.l;
    if (!lane) return null;
    const r = rows[+bar.dataset.r], bi = +bar.dataset.bi, p = +lane.dataset.p, lr = lane.getBoundingClientRect();
    const beat = clamp(Math.round(((x - lr.left) / beatPx()) / snap) * snap, 0, 4 - snap);
    return { r, p, bi, beat, pos: bi * 4 + beat, lane, x: beat * beatPx(), label: `Bar ${barNo(r, bi, Math.min(p, r.reps - 1))} · ${beatName(beat)}` };
  }
  let edgeTimer = null, edgeDir = 0;
  function edgeScroll(y) {
    const d = $('#desk').getBoundingClientRect();
    edgeDir = y < d.top + 50 ? -1 : y > d.bottom - 50 ? 1 : 0;
    if (edgeDir && !edgeTimer) edgeTimer = setInterval(() => $('#desk').scrollBy(0, edgeDir * 14), 30);
    if (!edgeDir && edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; }
  }
  document.addEventListener('pointerdown', (ev) => {
    const chip = ev.target.closest('.wchip');
    if (!chip || root.dataset.mode !== 'timing' || ev.button !== 0) return;
    ev.preventDefault();
    const r = rows[+chip.dataset.r], p = +chip.dataset.p, i = +chip.dataset.i, tok = r.lanes[p][i];
    const x0 = ev.clientX, y0 = ev.clientY, offX = ev.clientX - chip.getBoundingClientRect().left;
    let moved = false, ghost, mark, target = null;
    const move = (e) => {
      if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      if (!moved) {
        moved = true; chip.classList.add('lifted');
        ghost = chip.cloneNode(true); ghost.classList.add('ghost'); document.body.append(ghost);
        mark = document.createElement('div'); mark.className = 'drop-mark';
        root.classList.add('dragging');
      }
      ghost.style.left = e.clientX - offX + 'px'; ghost.style.top = e.clientY - 16 + 'px';
      target = hit(e.clientX - offX + 6, e.clientY);
      if (target) { if (mark.parentElement !== target.lane) target.lane.append(mark); mark.style.left = target.x + 'px'; mark.dataset.t = target.label; }
      else mark.remove();
      edgeScroll(e.clientY);
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      clearInterval(edgeTimer); edgeTimer = null; root.classList.remove('dragging');
      if (ghost) ghost.remove(); if (mark) mark.remove(); chip.classList.remove('lifted');
      if (!moved) {
        if (tok.pinned) { tok.pinned = false; arrange(r.lanes[p], r.bars.length * 4); timingTouched = true; saving(); keepPlace(render); toast(`“${tok.w}” released: it spreads out on its own again`); }
        else toast('Drag the word to any beat, in any measure or line');
        return;
      }
      if (!target) return;
      r.lanes[p].splice(i, 1);
      while (target.r.lanes.length <= target.p) target.r.lanes.push([]);
      const lane = target.r.lanes[target.p];
      Object.assign(tok, { pos: target.pos, pinned: true, anchor: false });
      let k = lane.findIndex((t) => t.pos > target.pos + 1e-6); if (k < 0) k = lane.length;
      lane.splice(k, 0, tok);
      arrange(r.lanes[p], r.bars.length * 4); arrange(lane, target.r.bars.length * 4);
      timingTouched = true; saving(); keepPlace(render);
      const flashEl = $(`.wchip[data-r="${target.r.idx}"][data-p="${target.p}"][data-i="${k}"]`); if (flashEl) flashEl.classList.add('flash');
      toast(`“${tok.w}” pinned to ${target.label}${target.r !== r ? ' (moved to another line)' : ''}`);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });

  // ---------- clicks: Navigate jumps, Edit edits ----------
  document.addEventListener('click', (ev) => {
    if (root.classList.contains('locked') || !ev.target.closest('.page')) return;
    const mode = root.dataset.mode;
    if (mode === 'nav') {
      const w = ev.target.closest('.w'); if (w) return M.seek(+w.dataset.t + 0.001);
      const chunk = ev.target.closest('.chunk');
      if (chunk) {
        const row = chunk.closest('.row'), lyr = ev.target.closest('.lyr');
        const pass = lyr ? +lyr.dataset.pass : row.hasAttribute('data-cur') ? +row.dataset.cur : 0;
        const e = M.events.find((x) => keyOf(x) === chunk.dataset.k && x.pass === pass) || M.events.find((x) => keyOf(x) === chunk.dataset.k);
        if (e) M.seek(e.start + 0.001);
        return;
      }
      const head = ev.target.closest('.sec-head');
      if (head) M.seek(M.sectionSpans[+head.closest('.sec').dataset.sec].start + 0.001);
      return;
    }
    if (mode === 'edit') {
      const add = ev.target.closest('.add-chord'); if (add) return addChord(add.closest('.chunk'));
      const addL = ev.target.closest('.add-lyrics');
      if (addL) { const r = rows[+addL.dataset.r]; r.lanes.push([]); render(); $(`.row[data-ri="${r.idx}"] .lyr`)?.focus(); return; }
      const chord = ev.target.closest('.chord'); if (chord) return editChord(chord);
      const pl = ev.target.closest('.pass-labels span');
      if (pl) { const row = pl.closest('.row'); rows[+row.dataset.ri].target = +pl.dataset.pass; $$('.pass-labels span', row).forEach((s) => s.classList.toggle('target', s.dataset.pass === pl.dataset.pass)); toast(`Editing pass ${+pl.dataset.pass + 1} of this line`); }
    }
  });

  // ---------- Edit: chords, lyrics, sections (all in place) ----------
  const chunkRef = (chunk) => { const [si, ri, bi, ci] = chunk.dataset.k.split('-').map(Number); return { r: rowOf(si, ri), si, ri, bi, ci }; };
  function editChord(btn, isNew) {
    const old = btn.dataset.chord, chunk = btn.closest('.chunk'), { r, bi, ci } = chunkRef(chunk);
    const inp = document.createElement('input');
    inp.className = 'chord-input'; inp.value = old; inp.setAttribute('list', 'chord-list'); inp.setAttribute('aria-label', 'Chord');
    inp.style.width = Math.max(2.4, old.length * 0.72 + 1.2) + 'em';
    btn.replaceWith(inp); inp.focus(); inp.select();
    let finished = false;
    const finish = (commit) => {
      if (finished) return; finished = true;
      const v = inp.value.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
      inp.replaceWith(btn);
      if (isNew && (!commit || !v)) { r.bars[bi].chords.splice(ci, 1); rebuildBarEvents(r, bi); return render(); }
      if (!commit || !v || v === old) return;
      let changed = 1;
      r.bars[bi].chords[ci].label = v; btn.dataset.chord = v; btn.innerHTML = M.chordHTML(v);
      M.events.forEach((e) => { if (e.si === r.si && e.ri === r.ri && e.bi === bi && e.ci === ci && (scope === 'all' || r.reps < 2 || e.pass === r.target)) e.label = v; });
      if (scope === 'all' && !isNew) {
        const name = M.SONG.sections[r.si].name;
        rows.forEach((o) => {
          if (o === r || M.SONG.sections[o.si].name !== name || o.ri !== r.ri) return;
          const c = o.bars[bi] && o.bars[bi].chords[ci]; if (!c || c.label !== old) return;
          c.label = v; changed++;
          M.events.forEach((e) => { if (e.si === o.si && e.ri === o.ri && e.bi === bi && e.ci === ci) e.label = v; });
          const ob = $(`.chunk[data-k="${o.si}-${o.ri}-${bi}-${ci}"] .chord`); if (ob) { ob.dataset.chord = v; ob.innerHTML = M.chordHTML(v); ob.classList.add('flash'); }
        });
      }
      btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
      saving(); M.update(true);
      if (isNew) return toast(`Added ${v}`);
      toast(scope === 'all' ? `${old} → ${v} in ${changed} matching place${changed > 1 ? 's' : ''}` : r.reps > 1 ? `${old} → ${v} for pass ${r.target + 1} only (the other pass keeps ${old})` : `${old} → ${v}`);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }
  function addChord(chunk) {
    const { r, bi, ci } = chunkRef(chunk), ch = r.bars[bi].chords;
    const a = ch[ci].onset, b = ci + 1 < ch.length ? ch[ci + 1].onset : 4;
    if (b - a < 0.5) return toast('No room for another chord here. Try Timing to move things first.');
    const onset = Math.round(((a + b) / 2) / 0.5) * 0.5;
    ch.splice(ci + 1, 0, { label: '', onset }); rebuildBarEvents(r, bi); render();
    editChord($(`.chunk[data-k="${r.si}-${r.ri}-${bi}-${ci + 1}"] .chord`), true);
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('.lyr,.sec-name')) { ev.preventDefault(); ev.target.blur(); } });
  let before = '';
  document.addEventListener('focusin', (ev) => { if (ev.target.matches('.lyr,.sec-name')) before = ev.target.textContent; });
  document.addEventListener('focusout', (ev) => {
    const el = ev.target; if (!el.matches('.lyr,.sec-name') || el.textContent === before) return;
    if (el.matches('.sec-name')) { const si = +el.closest('.sec').dataset.sec; M.SONG.sections[si].name = el.textContent.trim() || M.SONG.sections[si].name; saving(); return; }
    // Retype a lyric chunk: its words are replaced; the first sits on the chord, the rest spread out.
    const { r, bi, ci } = chunkRef(el.closest('.chunk')), p = +el.dataset.pass, lane = r.lanes[p];
    const [a] = chunkSpan(r, bi, ci), old = wordsIn(r, p, bi, ci).map((x) => x.t);
    old.forEach((t) => lane.splice(lane.indexOf(t), 1));
    const fresh = el.textContent.trim().split(/\s+/).filter(Boolean).flatMap((w) => w.split(/(?<=-)/)).map((w, wi) => ({ w, pos: a, pinned: false, anchor: wi === 0 }));
    let k = lane.findIndex((t) => t.pos > a - 1e-6); if (k < 0) k = lane.length;
    lane.splice(k, 0, ...fresh); arrange(lane, r.bars.length * 4);
    saving(); M.markLineStarts();
  });

  // ---------- current word follows playback (Navigate and Timing) ----------
  let lastWk = null;
  M.onUpdate((t, e) => {
    const r = rowOf(e.si, e.ri), lane = r && r.lanes[e.pass]; let wk = null;
    if (lane && lane.length) {
      const rel = (t - rowStart(r, e.pass)) / BEAT; let k = -1;
      lane.forEach((tk, i) => { if (tk.pos <= rel + 1e-6) k = i; });
      if (k >= 0) wk = `${r.idx}-${e.pass}-${k}`;
    }
    if (wk === lastWk) return;
    $$('.wnow').forEach((n) => n.classList.remove('wnow'));
    if (wk) $$(`[data-wk="${wk}"]`).forEach((n) => n.classList.add('wnow'));
    lastWk = wk;
  });

  // ---------- Navigation bar: zoom, pan, follow, loop range ----------
  const lane = $('#lane'), thumb = $('#thumb'), ov = $('#ov');
  let z = 1, vs = 0, follow = true;
  const ZL = [1, 1.5, 2, 3, 4, 6, 8, 12];
  function applyView() {
    z = clamp(z, 1, 12); vs = clamp(vs, 0, 1 - 1 / z);
    root.style.setProperty('--z', z); root.style.setProperty('--vs', vs);
    thumb.style.left = vs * 100 + '%'; thumb.style.width = 100 / z + '%';
    $('#span-label').textContent = z === 1 ? 'Whole song' : `${M.fmt(vs * T)}–${M.fmt((vs + 1 / z) * T)}`;
    root.classList.toggle('z2', z >= 2); root.classList.toggle('z4', z >= 4);
  }
  (function grid() {
    let h = ''; const bars = Math.round(T / BAR);
    for (let b = 0; b < bars; b++) {
      h += `<i class="${b % 4 === 0 ? 'm4' : ''}" style="left:${(b * BAR / T) * 100}%"><b>${b + 1}</b></i>`;
      for (let q = 1; q < 4; q++) h += `<i class="bt" style="left:${((b * BAR + q * BEAT) / T) * 100}%"></i>`;
    }
    $('#bargrid').innerHTML = h;
    $('#ovblocks').innerHTML = M.sectionSpans.map((s) => `<i class="ovblk" data-name="${s.name.toLowerCase()}" style="left:${(s.start / T) * 100}%;width:${((s.end - s.start) / T) * 100}%"></i>`).join('');
  })();
  const tAt = (x) => { const r = lane.getBoundingClientRect(); return clamp((vs + ((x - r.left) / r.width) / z) * T, 0, T - 0.01); };
  const snapT = (t) => { const q = z >= 3 ? BEAT : BAR; return Math.round(t / q) * q; };
  function setRange(a, b) {
    let s = snapT(Math.min(a, b)), e = snapT(Math.max(a, b));
    if (e - s < BEAT) e = s + (z >= 3 ? BEAT : BAR);
    M.state.loopRange = { start: clamp(s, 0, T), end: clamp(e, 0, T) };
  }
  function renderRange() {
    const st = M.state, cur = M.sectionSpans.find((x) => x.si === st.lastSec);
    const r = st.loopRange || (st.loop ? cur : null), el = $('#range'), ovr = $('#ovrange');
    el.classList.toggle('show', !!r); ovr.style.display = r ? 'block' : 'none';
    if (!r) return;
    el.classList.toggle('off', !st.loop);
    el.style.left = ovr.style.left = (r.start / T) * 100 + '%';
    el.style.width = ovr.style.width = ((r.end - r.start) / T) * 100 + '%';
    const b1 = Math.floor(r.start / BAR + 1e-6) + 1, b2 = Math.ceil(r.end / BAR - 1e-6);
    $('#range-text').textContent = st.loopRange ? `${st.loop ? 'Loop' : 'Range'} · bar${b1 === b2 ? '' : 's'} ${b1}${b1 === b2 ? '' : '–' + b2}` : `Looping ${r.name}`;
  }
  lane.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.blk,.range-tag')) return;
    const h = ev.target.closest('.range .h')?.dataset.h || 'new';
    const x0 = ev.clientX, t0 = tAt(x0); let moved = false;
    lane.setPointerCapture(ev.pointerId);
    const move = (e) => {
      if (!moved && Math.abs(e.clientX - x0) < 5) return; moved = true;
      const t = tAt(e.clientX), r = M.state.loopRange;
      if (h === 'new') setRange(t0, t); else if (h === 'l' && r) setRange(t, r.end); else if (r) setRange(r.start, t);
      renderRange();
    };
    const up = () => {
      lane.removeEventListener('pointermove', move); lane.removeEventListener('pointerup', up);
      if (!moved && h === 'new') return M.seek(t0);
      if (moved) { M.state.loop = true; $('#loop').classList.add('on'); renderRange(); toast($('#range-text').textContent + ' — playback will repeat it'); }
    };
    lane.addEventListener('pointermove', move); lane.addEventListener('pointerup', up);
  });
  lane.addEventListener('dblclick', (ev) => {
    const b = ev.target.closest('.blk'); if (!b) return;
    const s = M.sectionSpans[+b.dataset.sec]; M.state.loopRange = { start: s.start, end: s.end }; M.state.loop = true; $('#loop').classList.add('on'); renderRange(); toast(`Looping ${s.name}`);
  });
  $('#range-clear').addEventListener('click', (ev) => { ev.stopPropagation(); M.state.loopRange = null; M.state.loop = false; $('#loop').classList.remove('on'); renderRange(); });
  lane.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) { zoomTo(z * (ev.deltaY < 0 ? 1.25 : 0.8), ((ev.clientX - lane.getBoundingClientRect().left) / lane.clientWidth) / z + vs); }
    else { vs += ((ev.deltaX || ev.deltaY) / lane.clientWidth) / z; follow = false; $('#follow').classList.remove('on'); applyView(); }
  }, { passive: false });
  function zoomTo(nz, centre) {
    const p = M.state.time / T, visible = p >= vs && p <= vs + 1 / z;
    const c = centre ?? (visible ? p : vs + 0.5 / z);
    z = clamp(nz, 1, 12); vs = c - 0.5 / z; applyView();
  }
  $('#zoom-in').onclick = () => zoomTo(ZL.find((x) => x > z + 0.01) || 12);
  $('#zoom-out').onclick = () => zoomTo([...ZL].reverse().find((x) => x < z - 0.01) || 1);
  const pan = (d) => { vs += d * 0.25 / z; follow = false; $('#follow').classList.remove('on'); applyView(); };
  $('#pan-l').onclick = () => pan(-1); $('#pan-r').onclick = () => pan(1);
  $('#follow').onclick = () => { follow = !follow; $('#follow').classList.toggle('on', follow); if (follow) { vs = M.state.time / T - 0.1 / z; applyView(); } };
  thumb.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation(); thumb.setPointerCapture(ev.pointerId);
    const r = thumb.getBoundingClientRect(), w = ov.clientWidth, x0 = ev.clientX, vs0 = vs, z0 = z;
    const edge = ev.clientX - r.left < 9 ? 'l' : r.right - ev.clientX < 9 ? 'r' : 'pan';
    follow = false; $('#follow').classList.remove('on');
    const move = (e) => {
      const d = (e.clientX - x0) / w;
      if (edge === 'pan') vs = vs0 + d;
      else if (edge === 'l') { const right = vs0 + 1 / z0, left = clamp(vs0 + d, 0, right - 1 / 12); z = 1 / (right - left); vs = left; }
      else { const right = clamp(vs0 + 1 / z0 + d, vs0 + 1 / 12, 1); z = 1 / (right - vs0); vs = vs0; }
      applyView();
    };
    const up = () => { thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); };
    thumb.addEventListener('pointermove', move); thumb.addEventListener('pointerup', up);
  });
  ov.addEventListener('pointerdown', (ev) => { if (ev.target === thumb) return; const r = ov.getBoundingClientRect(); vs = (ev.clientX - r.left) / r.width - 0.5 / z; follow = false; $('#follow').classList.remove('on'); applyView(); });

  M.onUpdate((t) => {
    const p = t / T;
    if (follow && z > 1 && (p < vs || p > vs + 0.92 / z)) { vs = p - 0.08 / z; applyView(); }
    const bar = Math.floor(t / BAR) + 1, beat = (t % BAR) / BEAT + 1;
    $('#badge').textContent = `Bar ${bar} · Beat ${beat.toFixed(2)}`;
    const s = M.sectionSpans.find((x) => t >= x.start && t < x.end) || M.sectionSpans[0];
    const band = $('#curband'); band.style.left = (s.start / T) * 100 + '%'; band.style.width = ((s.end - s.start) / T) * 100 + '%';
    renderRange();
  });

  // speed
  $$('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    M.state.rate = clamp(Math.round((M.state.rate + +b.dataset.speed * 0.05) * 100) / 100, 0.5, 1.25);
    $('#rate').textContent = Math.round(M.state.rate * 100) + '%'; $('#speed').classList.toggle('slowed', M.state.rate < 1);
  }));
  $('#master').addEventListener('input', (e) => $('#master-out').textContent = e.target.value);

  // ---------- Mixer strips (meter + fader side by side, label under) ----------
  $$('.stem').forEach((s) => {
    const track = document.createElement('div'); track.className = 'track';
    track.append(s.querySelector('.meter'), s.querySelector('.fader')); s.querySelector('.stem-icon').after(track);
    const lab = document.createElement('div'); lab.className = 'strip-label'; lab.textContent = s.querySelector('.stem-name').textContent.replace(' guitar', ' gtr'); s.append(lab);
  });
  $$('.presets button').forEach((b) => b.addEventListener('click', () => {
    $$('.presets button').forEach((x) => x.classList.toggle('on', x === b));
    const muteMap = { 'Full band': [], Karaoke: [0], 'No guitars': [1, 2], Rhythm: [0, 1, 5, 6] }[b.textContent] || [];
    $$('.stem').forEach((s, i) => { s.classList.toggle('muted', muteMap.includes(i)); s.classList.remove('soloed'); });
  }));

  // ---------- Library: songs that aren't analyzed are locked ----------
  $$('.song').forEach((s) => { if (s.dataset.status !== 'ready') s.querySelector('.song-len').outerHTML = `<span class="lk" title="Not ready yet">${M.icon('lock')}</span>`; });
  let fake;
  function lock(song) {
    const st = song.dataset.status, title = song.querySelector('strong').textContent;
    root.classList.add('locked'); M.setPlaying(false); clearInterval(fake);
    $$('[data-bind="title"]').forEach((n) => n.textContent = title);
    $('.chips').style.visibility = 'hidden';
    renderLock(st === 'busy' ? 62 : -1);
    $('#lock-cta').onclick = () => {
      if (song.dataset.status === 'busy') { song.dataset.status = 'new'; song.querySelector('small').textContent = 'Not analyzed yet'; return renderLock(-1); }
      song.dataset.status = 'busy'; let pct = 0;
      fake = setInterval(() => {
        pct += 7; song.querySelector('small').textContent = `Analyzing… ${Math.min(pct, 100)}%`; renderLock(pct);
        if (pct >= 100) { clearInterval(fake); song.dataset.status = 'ready'; song.querySelector('small').textContent = 'D major · 120 BPM'; song.querySelector('.lk')?.remove(); unlock(); toast(`${title} is ready (demo shows the sample chart)`); }
      }, 220);
    };
  }
  function renderLock(pct) {
    const steps = [['Separate seven stems', 0, 55], ['Transcribe chords & rhythm', 55, 90], ['Build the chord chart', 90, 100]];
    $('#lock-title').textContent = pct < 0 ? 'Not analyzed yet' : 'Analyzing…';
    $('#lock-copy').textContent = pct < 0 ? 'Chord Buddy needs to listen first. Analysis builds the chord chart and the seven practice stems; playback unlocks when both are ready.' : 'You can keep practicing other songs while this runs. Nothing is lost if you cancel.';
    $('#lock-steps').innerHTML = steps.map(([name, a, b]) => {
      const cls = pct < 0 ? 'wait' : pct >= b ? 'done' : pct >= a ? 'run' : 'wait';
      const inner = cls === 'run' ? `<span class="bar-p"><i style="width:${((pct - a) / (b - a)) * 100}%"></i></span>` : '';
      return `<div class="step ${cls}">${M.icon(cls === 'done' ? 'check' : cls === 'run' ? 'clock' : 'lock')}${name}${inner}</div>`;
    }).join('');
    $('#lock-cta').innerHTML = pct < 0 ? `${M.icon('sparkle')}Analyze song` : `${M.icon('x')}Cancel analysis`;
  }
  function unlock(title) {
    root.classList.remove('locked'); clearInterval(fake);
    if (title) $$('[data-bind="title"]').forEach((n) => n.textContent = title);
    $('.chips').style.visibility = '';
  }
  document.addEventListener('click', (ev) => {
    const s = ev.target.closest('.song'); if (!s) return;
    if (s.dataset.status === 'ready') unlock(s.querySelector('strong').textContent); else lock(s);
  });

  // ---------- Themes, PDF, page breaks ----------
  $$('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => { root.dataset.theme = b.dataset.themePick; $$('[data-theme-pick]').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#export-pdf').addEventListener('click', () => { if (root.dataset.mode === 'timing') setMode('nav'); window.print(); });
  function pageBreaks() {
    const page = $('#page'); if (!page) return;
    page.style.setProperty('--pw', page.clientWidth + 'px');
    $$('.pbreak', page).forEach((b) => b.remove());
    const ph = (page.clientWidth * 11) / 8.5;
    for (let y = ph, n = 2; y < page.scrollHeight - 40; y += ph, n++) page.insertAdjacentHTML('beforeend', `<div class="pbreak" style="top:${y}px"><span>PAGE ${n}</span></div>`);
  }
  window.addEventListener('resize', () => { pageBreaks(); applyView(); });
  if (document.fonts) document.fonts.ready.then(pageBreaks);

  applyView(); pageBreaks(); setMode('nav'); M.update(true);
});
