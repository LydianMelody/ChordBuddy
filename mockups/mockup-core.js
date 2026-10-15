/* Chord Buddy mockups — shared demo data, icons and fake playback.
   Every design page loads this file and styles the markup it produces.
   Nothing here talks to the real app; it only simulates a song playing. */
(function () {
  'use strict';

  // ---------- Icons (24x24 stroke icons, hand-written) ----------
  const F = 'fill="currentColor" stroke="none"';
  const ICONS = {
    play: `<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" ${F}/>`,
    pause: `<rect x="6" y="5" width="4.2" height="14" rx="1.2" ${F}/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" ${F}/>`,
    rewind: `<path d="M11.5 6.5v11L4 12zM20 6.5v11L12.5 12z" ${F}/>`,
    ffwd: `<path d="M12.5 6.5v11L20 12zM4 6.5v11l7.5-5.5z" ${F}/>`,
    loop: '<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-2a4 4 0 0 1 4-4h12"/><path d="M7 21.5l-3-3 3-3"/><path d="M20 12.5v2a4 4 0 0 1-4 4H4"/>',
    volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.3a8.2 8.2 0 0 1 0 11.4"/>',
    mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    undo: '<path d="M9 13.5L4.5 9 9 4.5"/><path d="M4.5 9H14a5.5 5.5 0 0 1 0 11h-3"/>',
    redo: '<path d="M15 13.5L19.5 9 15 4.5"/><path d="M19.5 9H10a5.5 5.5 0 0 0 0 11h3"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
    upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 20h14"/>',
    sparkle: '<path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    note: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.1" fill="currentColor"/><circle cx="4.5" cy="12" r="1.1" fill="currentColor"/><circle cx="4.5" cy="18" r="1.1" fill="currentColor"/>',
    grip: `<circle cx="9" cy="6" r="1.3" ${F}/><circle cx="15" cy="6" r="1.3" ${F}/><circle cx="9" cy="12" r="1.3" ${F}/><circle cx="15" cy="12" r="1.3" ${F}/><circle cx="9" cy="18" r="1.3" ${F}/><circle cx="15" cy="18" r="1.3" ${F}/>`,
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
    drum: '<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M9 3.5l3 5M17 3l-3.5 5.5"/>',
    bass: '<path d="M13 11l7.5-7.5"/><path d="M19 2.5l2.5 2.5"/><path d="M12.6 11.4a3.3 3.3 0 0 0-4.6-.4c-.9.9-.9 1.9-2 2.4C4.6 14 3 14.8 3 16.8 3 19 5 21 7.2 21c2 0 2.8-1.6 3.4-3 .5-1.1 1.5-1.1 2.4-2a3.3 3.3 0 0 0-.4-4.6z"/><path d="M7.5 15.5l1.5 1.5"/>',
    guitar: '<path d="M14 10l6.5-6.5"/><path d="M18.5 2l3.5 3.5"/><path d="M13.6 10.4a4 4 0 0 0-5.5-.3c-.8.8-.7 1.9-1.9 2.4C4.6 13.1 3 14 3 16.3 3 18.8 5.2 21 7.7 21c2.3 0 3.2-1.6 3.8-3.2.5-1.2 1.6-1.1 2.4-1.9a4 4 0 0 0-.3-5.5z"/><circle cx="9" cy="15" r="1.4"/>',
    bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
    piano: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 5v14M12 5v14M16.5 5v14"/><path d="M6 5h3v7.5H6zM15 5h3v7.5h-3z" fill="currentColor"/>',
    wave: '<path d="M2 12h2.5l2-5.5 3 11 3-13 3 14 2.5-9 1.5 2.5H22"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    metronome: '<path d="M9 3h6l4.5 17.5h-15z"/><path d="M12 15.5l5.5-10"/><path d="M6.8 15.5h10.4"/>',
    chart: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M7.5 8.5h3M7.5 12.5h9M7.5 16.5h6"/><path d="M14 8.5h2.5"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
    score: '<path d="M3 6h18M3 10h18M3 14h18M3 18h18"/><circle cx="9" cy="16" r="2" fill="currentColor"/><path d="M11 16V7"/>',
    midi: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 8h5M9 12h6M13 16h5" stroke-width="2.6"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    more: `<circle cx="5" cy="12" r="1.6" ${F}/><circle cx="12" cy="12" r="1.6" ${F}/><circle cx="19" cy="12" r="1.6" ${F}/>`,
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    stand: '<path d="M4 4h16v9H4z"/><path d="M12 13v8M8 21h8M7.5 7.5h9M7.5 10h6"/>',
    turtle: '<path d="M5 15.5a7 7 0 0 1 14 0z"/><path d="M19 15.5h1.5a1.5 1.5 0 0 0 0-3H19M7 15.5v2.5M17 15.5v2.5"/><path d="M9 10l3 2.5 3-2.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16 7l2.5 2.5M18.5 4.5l2 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.3" fill="currentColor"/>',
    pin: '<path d="M9 3.5h6l-1 5.5 3.5 3.5h-11L10 9z"/><path d="M12 12.5V21"/>',
    pointer: '<path d="M6 3.5l12 7-5.2 1.6L10 17.5z"/><path d="M13 12.5l4.5 6"/>',
    minus: '<path d="M5 12h14"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    magnet: '<path d="M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0z"/><path d="M5 8h4M15 8h4"/>',
    wand: '<path d="M4 20L15 9"/><path d="M13.5 7.5l3 3"/><path d="M18 3v3M16.5 4.5h3M20 9v2M19 10h2M9 3v2M8 4h2"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
    cursorText: '<path d="M9 4h6M9 20h6M12 4v16"/>',
    printer: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
    cassette: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8" cy="11.5" r="2"/><circle cx="16" cy="11.5" r="2"/><path d="M10 11.5h4M6 19l1.5-3.5h9L18 19"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ---------- Demo song (original placeholder lyrics) ----------
  const SONG = {
    title: 'Marshmallow Comet',
    artist: 'Demo recording',
    key: 'D major', bpm: 120, meter: '4/4',
    barSeconds: 2,
    sections: [
      { name: 'Intro', rows: [{ bars: [['D', 'A'], ['G', 'D'], ['Bm', 'G'], ['D', 'A']] }] },
      { name: 'Verse', rows: [{ reps: 2, bars: [
        [['D', 'Marshmallow', 'Candy-colored'], ['A', 'comet,', 'rocket,']],
        [['G', 'spinning past the', 'humming as it'], ['D', 'moon,', 'goes,']],
        [['Bm', 'trailing glitter', 'leaving every'], ['G', 'sugar', 'starlight']],
        [['D', 'singing out of', 'rosy as a'], ['A', 'tune.', 'rose.']],
      ] }] },
      { name: 'Chorus', rows: [
        { reps: 2, bars: [[['G', 'Oh, sweet', 'Oh, so']], [['D', 'fluffy', 'gooey']], [['A', 'fire in the', 'nobody knows']], [['F#', 'sky!', 'why!']]] },
        { bars: [[['F#7', 'Whoa-oh!']]] },
      ] },
      { name: 'Interlude', rows: [{ bars: [['D', 'A'], ['G', 'D'], ['Bm', 'G'], ['D', 'A']] }] },
      { name: 'Chorus', rows: [
        { reps: 2, bars: [[['G', 'Oh, sweet', 'Oh, so']], [['D', 'fluffy', 'gooey']], [['A', 'fire in the', 'nobody knows']], [['F#', 'sky!', 'why!']]] },
        { bars: [[['F#7', 'Whoa-oh!']]] },
      ] },
      { name: 'Outro', rows: [{ bars: [['D', 'A'], ['G', 'D'], [['D', 'Home.']]] }] },
    ],
  };
  const LIBRARY = {
    setlists: [
      { name: 'Default', count: 6 },
      { name: 'Friday gig', count: 4 },
      { name: 'Sunday practice', count: 3 },
    ],
    songs: [
      { title: 'Marshmallow Comet', meta: 'D major · 120 BPM', status: 'ready', len: '1:18' },
      { title: 'Lighthouse Waltz', meta: 'G major · 3/4', status: 'ready', len: '3:42' },
      { title: 'Velvet Freeway', meta: 'Analyzing… 62%', status: 'busy', len: '4:05' },
      { title: 'Pocket Full of Rain', meta: 'B♭ major · 84 BPM', status: 'ready', len: '2:58' },
      { title: 'Saturday Static', meta: 'Not analyzed yet', status: 'new', len: '3:11' },
      { title: 'Paper Moon Parade', meta: 'E minor · 96 BPM', status: 'ready', len: '3:27' },
    ],
  };
  const STEMS = [
    ['Vocals', 'mic', 0.85], ['Lead guitar', 'bolt', 0.7], ['Rhythm guitar', 'guitar', 0.6],
    ['Bass', 'bass', 0.8], ['Drums', 'drum', 0.75], ['Piano', 'piano', 0.55], ['Other', 'wave', 0.4],
  ];

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function chordHTML(label) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(label);
    if (!m) return `<span class="root">${label}</span>`;
    const acc = m[2] === '#' ? '♯' : m[2] === 'b' ? '♭' : '';
    return `<span class="root">${m[1]}${acc ? `<span class="acc">${acc}</span>` : ''}</span>${m[3] ? `<span class="q">${m[3]}</span>` : ''}`;
  }

  // ---------- Chart ----------
  const events = []; const sectionSpans = [];
  function buildTimeline() {
    let t = 0;
    SONG.sections.forEach((sec, si) => {
      const start = t;
      sec.rows.forEach((row, ri) => {
        const reps = row.reps || 1;
        for (let pass = 0; pass < reps; pass++) {
          row.bars.forEach((bar, bi) => {
            const d = SONG.barSeconds / bar.length;
            bar.forEach((chunk, ci) => {
              const c = typeof chunk === 'string' ? [chunk] : chunk;
              events.push({ si, ri, bi, ci, pass, label: c[0], start: t, end: t + d, barNo: 0 });
              t += d;
            });
          });
        }
      });
      sectionSpans.push({ name: sec.name, start, end: t, si });
    });
    let bar = 0, last = -1;
    events.forEach((e) => { const k = Math.floor(e.start / SONG.barSeconds + 1e-6); if (k !== last) { bar++; last = k; } e.barNo = bar; });
    return t;
  }
  const TOTAL = buildTimeline();

  function renderChart(el, opts = {}) {
    const passLabel = opts.passLabel || ((p) => `${p + 1}`);
    el.innerHTML = SONG.sections.map((sec, si) => {
      const span = sectionSpans[si];
      const rows = sec.rows.map((row, ri) => {
        const reps = row.reps || 1;
        const lyric = row.bars.some((b) => b.some((c) => typeof c !== 'string'));
        const passes = lyric ? Math.max(...row.bars.flat().map((c) => (typeof c === 'string' ? 0 : c.length - 1))) : 0;
        const gutter = passes > 1 ? `<span class="pass-labels">${Array.from({ length: passes }, (_, p) => `<span data-pass="${p}">${passLabel(p)}</span>`).join('')}</span>` : '';
        const rep = reps > 1 ? `<span class="repeat" title="Played ${reps} times">(×${reps})</span>` : '';
        const bars = row.bars.map((bar, bi) => { const isLast = bi === row.bars.length - 1; const html = `<div class="bar${isLast ? ' last' : ''}">${gutter}${bar.map((chunk, ci) => {
          const c = typeof chunk === 'string' ? [chunk] : chunk;
          const lyr = c.slice(1).map((w, p) => `<span class="lyr" data-pass="${p}">${w}</span>`).join('');
          return `<span class="chunk" data-k="${si}-${ri}-${bi}-${ci}"><button class="chord" data-chord="${c[0]}" title="Edit chord">${chordHTML(c[0])}</button>${lyr}</span>`;
        }).join('')}</div>`; return isLast ? `<span class="tail">${html}${rep}</span>` : html; }).join('');
        return `<div class="row${lyric ? ' has-lyrics' : ''}" data-row="${si}-${ri}" data-passes="${passes}"><div class="bars">${bars}</div></div>`;
      }).join('');
      return `<section class="sec" data-sec="${si}" data-name="${sec.name.toLowerCase()}">
        <header class="sec-head"><span class="sec-num">${String(si + 1).padStart(2, '0')}</span><h3 class="sec-name">${sec.name}</h3><span class="sec-time">${fmt(span.start)}</span>
        <span class="sec-tools"><button class="sec-jump" data-jump="${si}" title="Jump here">${icon('play')}<span>Jump here</span></button><button class="sec-edit" title="Edit section">${icon('pencil')}<span>Edit</span></button></span></header>
        ${rows}</section>`;
    }).join('');
  }

  // Mark the first bar on each visual line so pass labels (1 / 2) repeat after wrapping.
  function markLineStarts() {
    $$('.row').forEach((row) => { let top = null; $$('.bar', row).forEach((b) => { const t = b.offsetTop; b.classList.toggle('line-start', t !== top); top = t; }); });
  }

  // ---------- Transport visuals ----------
  function renderSectionBlocks(el) {
    el.innerHTML = sectionSpans.map((s, i) => `<button class="blk" data-name="${s.name.toLowerCase()}" data-sec="${i}" style="left:${(s.start / TOTAL) * 100}%;width:${((s.end - s.start) / TOTAL) * 100}%" title="${s.name} · ${fmt(s.start)}"><span>${s.name}</span></button>`).join('');
  }
  function renderWave(el, opts = {}) {
    const n = opts.bars || 160, w = 1000, h = 100;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const loud = { intro: 0.45, verse: 0.62, chorus: 0.95, interlude: 0.55, outro: 0.4 };
    const bw = w / n; let rects = '';
    for (let i = 0; i < n; i++) {
      const t = (i / n) * TOTAL; const s = sectionSpans.find((x) => t >= x.start && t < x.end) || sectionSpans[0];
      const a = loud[s.name.toLowerCase()] || 0.6;
      const v = Math.max(0.08, Math.min(1, a * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.9))) * (0.75 + rnd() * 0.45)));
      const bh = v * h * (opts.mirror === false ? 1 : 0.92);
      const y = opts.mirror === false ? h - bh : (h - bh) / 2;
      rects += `<rect x="${(i * bw + bw * 0.18).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw * 0.64).toFixed(2)}" height="${bh.toFixed(2)}" rx="${opts.round ? (bw * 0.32).toFixed(2) : 0}"/>`;
    }
    const svg = (cls) => `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
    el.innerHTML = svg('wave-base') + svg('wave-played');
  }
  function renderStems(el, opts = {}) {
    el.innerHTML = STEMS.map(([name, ic, g], i) => `<div class="stem" data-stem="${i}">
      <span class="stem-icon">${icon(ic)}</span><span class="stem-name">${name}</span>
      <span class="meter" aria-hidden="true"><i></i></span>
      <input class="fader" type="range" min="0" max="100" value="${Math.round(g * 100)}" aria-label="${name} volume">
      <button class="mute" aria-pressed="false" title="Mute ${name}">${opts.text ? 'M' : icon('mute')}</button>
      <button class="solo" aria-pressed="false" title="Solo ${name}">${opts.text ? 'S' : icon('headphones')}</button></div>`).join('');
  }
  function renderLibrary(el, opts = {}) {
    el.innerHTML = LIBRARY.songs.map((s, i) => `<button class="song${i === 0 ? ' active' : ''}" data-status="${s.status}">
      ${opts.grip === false ? '' : `<span class="grip">${icon('grip')}</span>`}<span class="song-body"><strong>${s.title}</strong><small>${s.meta}</small></span><span class="song-len">${s.len}</span></button>`).join('');
  }
  function renderSetlists(el) {
    el.innerHTML = LIBRARY.setlists.map((s, i) => `<button class="setlist${i === 0 ? ' active' : ''}">${icon('list')}<span>${s.name}</span><em>${s.count}</em></button>`).join('');
  }

  // ---------- Chord edit popover ----------
  const VARIANTS = { D: ['Dmaj7', 'D/F♯', 'Dsus4', 'D5'], A: ['A7', 'Asus4', 'A/C♯', 'Am'], G: ['Gmaj7', 'G/B', 'Gadd9', 'Em'], Bm: ['Bm7', 'Bm/A', 'B', 'D/A'], 'F#': ['F♯m', 'F♯7', 'F♯sus4', 'D/F♯'], 'F#7': ['F♯', 'F♯m7', 'F♯7sus4', 'A♯dim'] };
  let pop;
  function openPop(btn) {
    closePop();
    const label = btn.dataset.chord;
    pop = document.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'dialog');
    pop.innerHTML = `<div class="pop-title">${icon('pencil')} Edit chord</div>
      <div class="pop-input">${chordHTML(label)}<span class="caret"></span></div>
      <div class="pop-sugs">${(VARIANTS[label] || ['Maj7', 'sus4', '7']).map((v) => `<button>${v}</button>`).join('')}</div>
      <div class="pop-scope"><button class="on">${icon('check')} This pass</button><button>All matching passes</button></div>
      <div class="pop-foot"><button class="pop-jump">${icon('play')} Jump here</button><button class="pop-done">Done</button></div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + 'px';
    pop.style.top = (r.bottom + window.scrollY + 10) + 'px';
    btn.classList.add('selected');
    $$('.pop-scope button', pop).forEach((b) => b.onclick = () => { $$('.pop-scope button', pop).forEach((x) => x.classList.remove('on')); b.classList.add('on'); });
    $('.pop-done', pop).onclick = closePop;
    $('.pop-jump', pop).onclick = () => { const k = btn.closest('.chunk').dataset.k; const e = events.find((x) => `${x.si}-${x.ri}-${x.bi}-${x.ci}` === k); if (e) seek(e.start); closePop(); };
  }
  function closePop() { if (pop) { pop.remove(); pop = null; } $$('.chord.selected').forEach((c) => c.classList.remove('selected')); }

  // ---------- Playback simulation ----------
  const state = { playing: false, time: 9.2, rate: 1, loop: false, lastIdx: -1, lastSec: -1 };
  const levels = STEMS.map(() => 0);
  function seek(t) { state.time = Math.max(0, Math.min(TOTAL - 0.01, t)); update(true); }
  function update(force) {
    const t = state.time, root = document.documentElement;
    root.style.setProperty('--p', `${((t / TOTAL) * 100).toFixed(3)}%`);
    root.style.setProperty('--pf', (t / TOTAL).toFixed(4));
    const idx = events.findIndex((e) => t >= e.start && t < e.end);
    const e = events[idx] || events[0];
    if (idx !== state.lastIdx || force) {
      $$('.chunk.now').forEach((c) => c.classList.remove('now'));
      $$('.row[data-cur]').forEach((r) => r.removeAttribute('data-cur'));
      const chunk = $(`.chunk[data-k="${e.si}-${e.ri}-${e.bi}-${e.ci}"]`);
      if (chunk) chunk.classList.add('now');
      const row = $(`.row[data-row="${e.si}-${e.ri}"]`); if (row) row.setAttribute('data-cur', e.pass);
      $$('.sec').forEach((s) => s.classList.toggle('now', +s.dataset.sec === e.si));
      $$('.blk').forEach((b) => b.classList.toggle('now', +b.dataset.sec === e.si));
      const next = events[idx + 1] || events[0];
      $$('[data-bind="chord"]').forEach((n) => n.innerHTML = chordHTML(e.label));
      $$('[data-bind="next"]').forEach((n) => n.innerHTML = chordHTML(next.label));
      $$('[data-bind="section"]').forEach((n) => n.textContent = SONG.sections[e.si].name);
      $$('[data-bind="pass"]').forEach((n) => { const reps = SONG.sections[e.si].rows[e.ri].reps || 1; n.textContent = reps > 1 ? `Pass ${e.pass + 1} of ${reps}` : ''; });
      if (state.playing && e.si !== state.lastSec && chunk) {
        const sc = chunk.closest('[data-autoscroll]');
        if (sc) { const sec = chunk.closest('.sec'); sc.scrollTo({ top: sc.scrollTop + sec.getBoundingClientRect().top - sc.getBoundingClientRect().top - (+sc.dataset.autoscroll || 24), behavior: 'smooth' }); }
      }
      state.lastIdx = idx; state.lastSec = e.si;
      // light metronome pulse
      root.classList.remove('beat'); void root.offsetWidth; root.classList.add('beat');
    }
    const beat = (t / (SONG.barSeconds / 4));
    $$('[data-bind="time"]').forEach((n) => n.textContent = fmt(t));
    $$('[data-bind="total"]').forEach((n) => n.textContent = fmt(TOTAL));
    $$('[data-bind="bar"]').forEach((n) => n.textContent = `Bar ${e.barNo} · Beat ${Math.floor(beat % 4) + 1}`);
    $$('[data-bind="barno"]').forEach((n) => n.textContent = e.barNo);
    $$('[data-bind="beat"]').forEach((n) => n.textContent = Math.floor(beat % 4) + 1);
    $$('.beat-dots').forEach((d) => d.style.setProperty('--b', Math.floor(beat % 4)));
    listeners.forEach((fn) => fn(t, e, idx));
  }
  const listeners = [];
  function tickMeters(dt) {
    const stems = $$('.stem'); if (!stems.length) return;
    const anySolo = stems.some((s) => s.classList.contains('soloed'));
    stems.forEach((s, i) => {
      const audible = state.playing && !s.classList.contains('muted') && (!anySolo || s.classList.contains('soloed'));
      const g = +$('.fader', s).value / 100;
      const target = audible ? g * (0.55 + 0.45 * Math.random()) : 0;
      levels[i] += (target - levels[i]) * Math.min(1, dt * (target > levels[i] ? 18 : 5));
      s.style.setProperty('--lvl', levels[i].toFixed(3));
    });
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (state.playing) {
      state.time += dt * state.rate;
      if (state.loop) {
        const r = state.loopRange || sectionSpans.find((x) => x.si === state.lastSec);
        if (r && (state.time >= r.end || state.time < r.start - 0.05)) state.time = r.start;
      }
      if (state.time >= TOTAL) state.time = 0;
      update(false);
    }
    tickMeters(dt);
    requestAnimationFrame(frame);
  }

  function setPlaying(p) {
    state.playing = p;
    document.documentElement.classList.toggle('is-playing', p);
    $$('[data-action="play"]').forEach((b) => { b.innerHTML = icon(p ? 'pause' : 'play'); b.setAttribute('aria-label', p ? 'Pause' : 'Play'); });
  }

  // ---------- Wiring ----------
  function wire() {
    $$('[data-icon]').forEach((n) => n.insertAdjacentHTML('afterbegin', icon(n.dataset.icon)));
    $$('[data-render="chart"]').forEach((n) => renderChart(n, { passLabel: n.dataset.passLabel === 'line' ? (p) => `Line ${p + 1}` : undefined }));
    $$('[data-render="blocks"]').forEach(renderSectionBlocks);
    $$('[data-render="wave"]').forEach((n) => renderWave(n, { bars: +(n.dataset.bars || 160), mirror: n.dataset.mirror !== 'false', round: n.dataset.round === 'true' }));
    $$('[data-render="stems"]').forEach((n) => renderStems(n, { text: n.dataset.text === 'true' }));
    $$('[data-render="songs"]').forEach((n) => renderLibrary(n, { grip: n.dataset.grip !== 'false' }));
    $$('[data-render="setlists"]').forEach(renderSetlists);
    $$('[data-bind="title"]').forEach((n) => n.textContent = SONG.title);

    markLineStarts(); window.addEventListener('resize', markLineStarts);
    if (document.fonts) document.fonts.ready.then(markLineStarts);
    setPlaying(false);
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('button, [data-seek], a'); if (!t) { if (pop && !ev.target.closest('.pop')) closePop(); return; }
      if (t.closest('.pop')) return;
      if (t.matches('[data-action="play"]')) return setPlaying(!state.playing);
      if (t.matches('[data-action="rew"]')) { const cur = sectionSpans.find((s) => s.si === state.lastSec) || sectionSpans[0]; const prev = state.time - cur.start > 1.5 ? cur : sectionSpans[Math.max(0, cur.si - 1)]; return seek(prev.start); }
      if (t.matches('[data-action="ffwd"]')) { const nx = sectionSpans[Math.min(sectionSpans.length - 1, state.lastSec + 1)]; return seek(nx.start); }
      if (t.matches('[data-action="loop"]')) { state.loop = !state.loop; t.classList.toggle('on', state.loop); t.setAttribute('aria-pressed', state.loop); return; }
      if (t.matches('[data-action="slow"]')) { state.rate = state.rate === 1 ? 0.75 : state.rate === 0.75 ? 0.5 : 1; t.classList.toggle('on', state.rate !== 1); $$('[data-bind="rate"]').forEach((n) => n.textContent = `${Math.round(state.rate * 100)}%`); return; }
      if (t.matches('[data-jump]')) return seek(sectionSpans[+t.dataset.jump].start + 0.001);
      if (t.matches('.blk')) return seek(sectionSpans[+t.dataset.sec].start + 0.001);
      if (t.matches('.chord')) { if (document.documentElement.hasAttribute('data-no-pop')) return; ev.stopPropagation(); return openPop(t); }
      if (t.matches('[data-tab]')) {
        const group = t.closest('[data-tabs]') || document;
        $$('[data-tab]', group).forEach((b) => { b.classList.toggle('active', b === t); b.setAttribute('aria-selected', b === t); });
        $$('[data-view]').forEach((v) => v.hidden = v.dataset.view !== t.dataset.tab);
        return;
      }
      if (t.matches('[data-source]')) { $$('[data-source]').forEach((b) => b.classList.toggle('active', b === t)); return; }
      if (t.matches('.mute')) { const s = t.closest('.stem'); s.classList.toggle('muted'); t.setAttribute('aria-pressed', s.classList.contains('muted')); return; }
      if (t.matches('.solo')) { const s = t.closest('.stem'); s.classList.toggle('soloed'); t.setAttribute('aria-pressed', s.classList.contains('soloed')); return; }
      if (t.matches('.song')) { $$('.song').forEach((x) => x.classList.toggle('active', x === t)); return; }
      if (t.matches('.setlist')) { $$('.setlist').forEach((x) => x.classList.toggle('active', x === t)); return; }
      if (t.matches('[data-toggle]')) { t.classList.toggle('on'); document.documentElement.classList.toggle(t.dataset.toggle); return; }
      if (t.matches('[data-seek]')) { const r = t.getBoundingClientRect(); return seek(((ev.clientX - r.left) / r.width) * TOTAL); }
    });
    $$('[data-seek]').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.closest('.blk')) return;
      const r = el.getBoundingClientRect(); seek(((ev.clientX - r.left) / r.width) * TOTAL);
    }));
    document.addEventListener('scroll', (ev) => { if (pop && !(ev.target.closest && ev.target.closest('.pop'))) closePop(); }, true);
    document.addEventListener('keydown', (ev) => { if (ev.code === 'Space' && !ev.target.closest('input,textarea,[contenteditable]')) { ev.preventDefault(); setPlaying(!state.playing); } if (ev.key === 'Escape') closePop(); });
    update(true);
    requestAnimationFrame(frame);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', wire) : wire();
  window.ChordBuddyMock = { SONG, STEMS, LIBRARY, icon, seek, setPlaying, state, events, sectionSpans, TOTAL, fmt, chordHTML, update,
    onUpdate: (fn) => listeners.push(fn), markLineStarts: () => markLineStarts() };
})();
