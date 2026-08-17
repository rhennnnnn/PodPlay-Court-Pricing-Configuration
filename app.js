/* Court Pricing Configurator — Court+ (Per Court)
   Standalone, no backend. State is the single source of truth; inputs mutate
   state, then recalc() re-renders only the computed outputs (tables, summary,
   JSON) so focus is never lost while typing.

   Verified pricing math (from PodPlay staging):
     nonMember(perCourt) = base + surcharge * extraPlayers
     member(perCourt)    = base * (1 - discount/100) + surcharge * extraPlayers
   The membership discount applies to the BASE price only, never the surcharge.

   Discounts are per TIME BAND: the default member discount and every custom
   membership's discount are set independently inside each band (OFF PEAK, PEAK,
   REDUCED), mirroring the PodPlay pricing screen — a membership can have a
   different percentage in each band.
*/

(() => {
  'use strict';

  const STORAGE_KEY = 'courtPlusPricingConfig.v1';
  const THEME_KEY = 'courtPlusTheme';
  const USER_KEY = 'courtPlusUserId';

  // A per-visitor id, generated once and kept in this browser's localStorage.
  // On static hosting (Vercel / GitHub Pages) there is no server, so each
  // visitor's browser holds its own isolated config under this id.
  function getUserId() {
    let id = localStorage.getItem(USER_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'usr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(USER_KEY, id);
    }
    return id;
  }

  // ---- Admin gate + configuration codes ----
  // A configuration code is a copy-paste token (like a game crosshair code) that
  // encodes a whole configuration. The model is baked into the tag, so a Court+
  // code will NOT apply on top of a Spot+ or Hybrid setup, and vice-versa.
  //
  // The admin console lives at ?view=admin and asks for this passcode before it
  // will generate (export) codes. Change ADMIN_PASSCODE to your own secret.
  // NOTE: static hosting has no real login — the passcode only lightly gates the
  // export controls and is visible in this file's source. It is obscurity, not security.
  const ADMIN_PASSCODE = 'podplay-admin';
  const ADMIN_FLAG = 'courtPlusAdminOk';
  const MODEL_TAG = { 'court-plus': 'COURT', 'spot-plus': 'SPOT', 'hybrid': 'HYB' };
  const TAG_MODEL = { COURT: 'court-plus', SPOT: 'spot-plus', HYB: 'hybrid' };
  const MODEL_LABEL = { 'court-plus': 'Court+', 'spot-plus': 'Spot+', 'hybrid': 'Hybrid' };
  let isAdmin = false;

  const b64urlEncode = (str) =>
    btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64urlDecode = (str) =>
    decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));

  // Build a code for the current model + settings.
  function encodeConfigCode() {
    return `PPCC1-${MODEL_TAG[state.model]}-${b64urlEncode(JSON.stringify(exportConfig()))}`;
  }
  // Parse a code. Returns { ok, model, cfg } or { ok:false, error }.
  function decodeConfigCode(raw) {
    const code = (raw || '').trim();
    const m = code.match(/^PPCC1-(COURT|SPOT|HYB)-([A-Za-z0-9\-_]+)$/);
    if (!m) return { ok: false, error: 'That does not look like a valid configuration code.' };
    const model = TAG_MODEL[m[1]];
    let cfg;
    try { cfg = JSON.parse(b64urlDecode(m[2])); }
    catch (_) { return { ok: false, error: 'This configuration code is corrupted and could not be read.' }; }
    if (!cfg || cfg.model !== model || !MODELS[model]) {
      return { ok: false, error: 'This configuration code is not recognised.' };
    }
    return { ok: true, model, cfg };
  }

  // Copy helper with a manual-selection fallback for locked-down clipboards.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) { return false; }
    }
  }

  // ---- Band presets (mirror the PodPlay pricing example) ----
  const BAND_PRESETS = {
    'OFF PEAK': { swatch: '#3B82F6', memberDiscount: 100, base: 20, surcharge: 5, lockNon: 10, lockMem: 10, lessonNon: 0, lessonMem: 0 },
    'PEAK':     { swatch: '#F59E0B', memberDiscount: 50,  base: 30, surcharge: 5, lockNon: 10, lockMem: 5,  lessonNon: 0, lessonMem: 0 },
    'REDUCED':  { swatch: '#14B8A6', memberDiscount: 50,  base: 20, surcharge: 5, lockNon: 10, lockMem: 10, lessonNon: 0, lessonMem: 0 },
  };
  const MEM_COLORS = ['#8B5CF6', '#EC4899', '#0EA5E9', '#F97316', '#10B981', '#EF4444'];

  let uid = 0;
  const nextId = () => `id${++uid}`;

  // ---- State shape ----
  //   memberships: [{ id, name }]              — name only; discount lives per band
  //   band.memDiscounts: { [memId]: pct }      — this band's discount for each membership
  function newBand(name) {
    return { id: nextId(), name, removable: name !== 'OFF PEAK', ...BAND_PRESETS[name], memDiscounts: {} };
  }

  // Per-model column behaviour (verified against PodPlay):
  //   baseCol       -> show the undiscounted "Base price" column (Spot+ only).
  //   nonPerPerson  -> the non-member column is charged per person (÷ group size).
  //   memPerPerson  -> the member/membership columns are charged per person.
  // Court+  : everyone per court (member discount on base only).
  // Spot+   : everyone per person (discount on whole court price, ÷ group size).
  // Hybrid  : non-members per court; members per person (discount on whole price, ÷ group size).
  const MODELS = {
    'court-plus': {
      badge: 'Court+ &middot; Per Court',
      desc: 'Court+ — one court price is shared across the whole group.',
      baseCol: false, nonPerPerson: false, memPerPerson: false,
      hint: 'Your pricing model is <strong>court pricing</strong>, meaning customers pay the full court price regardless of group size. The final court price is divided among the participants invited to pay; any free invites\' portion is covered by the reservation holder.',
    },
    'spot-plus': {
      badge: 'Spot+ &middot; Per Spot',
      desc: 'Spot+ — the court price is split per person; each player pays their own spot.',
      baseCol: true, nonPerPerson: true, memPerPerson: true,
      hint: 'Your pricing model is <strong>spot pricing</strong>, meaning each calculated court price is divided by the group size and charged per person. Non-members pay per person; members pay per person with their membership discount applied. Free-invited players do not pay — the reservation holder covers their spot.',
    },
    'hybrid': {
      badge: 'Hybrid &middot; Mixed',
      desc: 'Hybrid — non-members pay the full court price; members pay per person.',
      baseCol: false, nonPerPerson: false, memPerPerson: true,
      hint: 'Your pricing model is <strong>hybrid pricing</strong>, meaning members pay per person while non-members pay the full court price. The member price applies the discount to the full court price, then divides it by the group size. Free-invited players do not pay — the booker can choose to cover their spot.',
    },
  };

  function defaultState() {
    return {
      model: 'court-plus',
      court: { name: '' },
      structure: { baseGroup: 2, maxPlayers: 4, minGroup: 2 },
      memberships: [],
      dayPass: { enabled: false, fee: 0 },
      bands: ['OFF PEAK', 'PEAK', 'REDUCED'].map(newBand),
    };
  }

  let state = defaultState();

  // ---- Helpers ----
  const $ = (sel, root = document) => root.querySelector(sel);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const clampPct = (v) => Math.min(100, Math.max(0, num(v)));
  const isPct = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 100; };
  const money = (n) => `$${n.toFixed(2)}`; // negatives render as "$-5.00" (matches PodPlay)

  // Per-court price for a band at a given player count and discount %.
  function perCourt(band, players, discountPct) {
    const bg = Math.max(1, Math.round(num(state.structure.baseGroup)));
    const extra = Math.max(0, players - bg);
    const discounted = num(band.base) * (1 - clampPct(discountPct) / 100);
    return discounted + num(band.surcharge) * extra;
  }

  // Undiscounted full court price at N players (the "Base price" column in Spot+).
  function courtPriceFull(band, players) {
    const bg = Math.max(1, Math.round(num(state.structure.baseGroup)));
    const extra = Math.max(0, players - bg);
    return num(band.base) + num(band.surcharge) * extra;
  }

  // Price for one column. perPerson=true -> discount the WHOLE court price then divide
  // by the group size (Spot+/Hybrid member). perPerson=false -> per court, discount on
  // base only (Court+/Hybrid non-member). Verified against PodPlay.
  function priceFor(band, players, discountPct, perPerson) {
    if (perPerson) {
      return courtPriceFull(band, players) * (1 - clampPct(discountPct) / 100) / players;
    }
    return perCourt(band, players, discountPct);
  }

  // Player-count rows: minimum group (as "1-N") then each count up to max.
  // The first row buckets 1..minGroup; per-person prices divide by the row's
  // player count. The extra-player surcharge threshold is the base group size.
  function playerRows() {
    const mn = Math.max(1, Math.round(num(state.structure.minGroup)));
    const max = Math.max(mn, Math.round(num(state.structure.maxPlayers)));
    const rows = [{ players: mn, label: mn > 1 ? `1-${mn} players` : `1 player` }];
    for (let n = mn + 1; n <= max; n++) rows.push({ players: n, label: `${n} players` });
    return rows;
  }

  // Icons (inline SVG)
  const ICON = {
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  };

  // A number field with $ or %-off affix. kind: 'money' allows negatives, 'pct' bounds 0-100.
  function affixField(label, sub, kind, value, onInput, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const affix = kind === 'pct'
      ? '<span class="affix suffix">% off</span>'
      : '<span class="affix">$</span>';
    const order = kind === 'pct'
      ? `<input type="number" step="1" /> ${affix}`
      : `${affix}<input type="number" step="0.5" />`;
    wrap.innerHTML =
      `<label>${escapeHtml(label)}${sub ? ` <span class="sub">${escapeHtml(sub)}</span>` : ''}</label>` +
      `<div class="input-affix${opts.wide ? ' wide' : ''}">${order}</div>` +
      `<div class="err">Must be a number between 0 and 100.</div>`;
    const input = $('input', wrap);
    input.value = value;
    if (opts.aria) input.setAttribute('aria-label', opts.aria);
    input.addEventListener('input', () => {
      if (kind === 'pct') {
        const ok = input.value === '' || isPct(input.value);
        wrap.classList.toggle('invalid', !ok);
      }
      onInput(input.value);
      recalc();
    });
    return wrap;
  }

  // The value a band applies for a membership (its own override, else the band default).
  function memPct(band, mem) {
    const v = band.memDiscounts[mem.id];
    return v === undefined || v === '' ? band.memberDiscount : v;
  }

  // ---------- Render: memberships (names + remove; discounts live per band) ----------
  function renderMemberships() {
    const list = $('#memList');
    list.innerHTML = '';
    if (!state.memberships.length) {
      const empty = document.createElement('p');
      empty.className = 'section-note';
      empty.style.margin = '0 0 4px';
      empty.textContent = 'No custom memberships yet. Each band already includes the default member discount. Add a membership to give it its own discount in each band.';
      list.appendChild(empty);
    }
    state.memberships.forEach((mem, i) => {
      const row = document.createElement('div');
      row.className = 'mem-item';
      const color = MEM_COLORS[i % MEM_COLORS.length];
      row.innerHTML =
        `<span class="swatch" style="background:${color}"></span>` +
        `<input class="mem-name" type="text" placeholder="Membership name" />` +
        `<span class="mem-default-tag" style="margin-left:auto">discount set per band below</span>` +
        `<button class="mem-remove" title="Remove membership" aria-label="Remove membership">${ICON.trash}</button>`;
      const nameEl = $('.mem-name', row);
      nameEl.value = mem.name;
      nameEl.addEventListener('input', () => { mem.name = nameEl.value; recalc(); });
      $('.mem-remove', row).addEventListener('click', () => {
        state.memberships.splice(i, 1);
        state.bands.forEach((b) => { delete b.memDiscounts[mem.id]; });
        renderMemberships();
        renderBands();
        recalc();
      });
      list.appendChild(row);
    });
  }

  function memColor(mem) {
    const i = state.memberships.indexOf(mem);
    return MEM_COLORS[i % MEM_COLORS.length];
  }

  // ---------- Render: bands ----------
  function renderBands() {
    const host = $('#bands');
    host.innerHTML = '';
    state.bands.forEach((band) => {
      const preset = BAND_PRESETS[band.name] || { swatch: '#64748B' };
      const card = document.createElement('section');
      card.className = 'card band';

      const head = document.createElement('div');
      head.className = 'band-head';
      head.innerHTML =
        `<span class="band-title"><span class="band-swatch" style="background:${preset.swatch}"></span>${escapeHtml(band.name)}</span>`;
      // A band is removable only while more than one band exists; the last
      // remaining band cannot be deleted.
      if (state.bands.length > 1) {
        const rm = document.createElement('button');
        rm.className = 'btn btn-sm btn-ghost band-remove';
        rm.innerHTML = `${ICON.trash} Remove`;
        rm.addEventListener('click', () => {
          state.bands = state.bands.filter((b) => b.id !== band.id);
          renderBands();
          renderAddBand();
          recalc();
        });
        head.appendChild(rm);
      }
      card.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'band-grid';

      // Row: base price + surcharge + member default discount
      const priceRow = document.createElement('div');
      priceRow.className = 'inline-group';
      priceRow.appendChild(affixField('Base court price', `up to ${state.structure.baseGroup} players`, 'money', band.base,
        (v) => { band.base = v; }, { aria: `Base court price for ${band.name}` }));
      priceRow.appendChild(affixField('Extra player surcharge', 'per extra player', 'money', band.surcharge,
        (v) => { band.surcharge = v; }, { aria: `Extra player surcharge for ${band.name}` }));
      priceRow.appendChild(affixField('Members (default) discount', '', 'pct', band.memberDiscount,
        (v) => { band.memberDiscount = v; }, { aria: `Default member discount for ${band.name}` }));
      grid.appendChild(priceRow);

      // Row: per-membership discounts (only if any custom memberships exist)
      if (state.memberships.length) {
        const memLbl = document.createElement('span');
        memLbl.className = 'band-sub'; memLbl.style.width = '100%'; memLbl.textContent = 'Membership discounts';
        grid.appendChild(memLbl);
        const memRow = document.createElement('div');
        memRow.className = 'inline-group';
        state.memberships.forEach((mem) => {
          const f = affixField(mem.name || 'Membership', '', 'pct', memPct(band, mem),
            (v) => { band.memDiscounts[mem.id] = v; }, { aria: `${mem.name || 'membership'} discount for ${band.name}` });
          // color dot before the label
          const lab = $('label', f);
          lab.insertAdjacentHTML('afterbegin', `<span class="band-swatch" style="background:${memColor(mem)}"></span>`);
          memRow.appendChild(f);
        });
        grid.appendChild(memRow);
      }

      // Row: court lock fee
      const lockLbl = document.createElement('span');
      lockLbl.className = 'band-sub'; lockLbl.style.width = '100%'; lockLbl.textContent = 'Court lock fee';
      grid.appendChild(lockLbl);
      const lockRow = document.createElement('div');
      lockRow.className = 'inline-group';
      lockRow.appendChild(affixField('Non-members', '', 'money', band.lockNon, (v) => { band.lockNon = v; }, { aria: `Court lock fee non-members ${band.name}` }));
      lockRow.appendChild(affixField('Members', '', 'money', band.lockMem, (v) => { band.lockMem = v; }, { aria: `Court lock fee members ${band.name}` }));
      grid.appendChild(lockRow);

      // Row: lesson court discount
      const lessonLbl = document.createElement('span');
      lessonLbl.className = 'band-sub'; lessonLbl.style.width = '100%'; lessonLbl.textContent = 'Lesson court discount';
      grid.appendChild(lessonLbl);
      const lessonRow = document.createElement('div');
      lessonRow.className = 'inline-group';
      lessonRow.appendChild(affixField('Non-members', '', 'pct', band.lessonNon, (v) => { band.lessonNon = v; }, { aria: `Lesson discount non-members ${band.name}` }));
      lessonRow.appendChild(affixField('Members', '', 'pct', band.lessonMem, (v) => { band.lessonMem = v; }, { aria: `Lesson discount members ${band.name}` }));
      grid.appendChild(lessonRow);

      // Computed table
      const tableWrap = document.createElement('div');
      tableWrap.className = 'calc-table-wrap';
      tableWrap.id = `calc-${band.id}`;
      grid.appendChild(tableWrap);

      card.appendChild(grid);
      host.appendChild(card);
    });
  }

  // ---------- Render: add-band buttons ----------
  function renderAddBand() {
    const row = $('#addBandRow');
    row.innerHTML = '';
    const present = new Set(state.bands.map((b) => b.name));
    Object.keys(BAND_PRESETS).forEach((name) => {
      if (present.has(name)) return;
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.innerHTML = `${ICON.plus} Add ${name} band`;
      btn.addEventListener('click', () => {
        state.bands.push(newBand(name));
        const order = Object.keys(BAND_PRESETS);
        state.bands.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
        renderBands();
        renderAddBand();
        recalc();
      });
      row.appendChild(btn);
    });
  }

  // ---------- Recalc: computed tables, summary, JSON ----------
  function recalc() {
    const rows = playerRows();
    const mems = state.memberships;

    const cfg = MODELS[state.model];
    const cell = (v, per) => `<td class="${v < 0 ? 'val-neg' : ''}">${money(v)}${per ? ' each' : ''}</td>`;
    const nonQual = cfg.nonPerPerson ? ' (per person)' : ' (per court)';
    const memQual = cfg.memPerPerson ? ' (per person)' : ' (per court)';
    state.bands.forEach((band) => {
      const wrap = $(`#calc-${band.id}`);
      if (!wrap) return;
      let head = '<tr><th>Quantity</th>';
      if (cfg.baseCol) head += '<th>Base price</th>';
      head += `<th>Non-member${nonQual}</th><th>Members (default)${memQual}</th>`;
      mems.forEach((m) => { head += `<th>${escapeHtml(m.name || 'Membership')}</th>`; });
      head += '</tr>';
      let body = '';
      rows.forEach((r) => {
        const n = r.players;
        body += `<tr><td class="qty">${r.label}</td>`;
        if (cfg.baseCol) { const cf = courtPriceFull(band, n); body += `<td class="${cf < 0 ? 'val-neg' : ''}">${money(cf)}</td>`; }
        body += cell(priceFor(band, n, 0, cfg.nonPerPerson), cfg.nonPerPerson);
        body += cell(priceFor(band, n, band.memberDiscount, cfg.memPerPerson), cfg.memPerPerson);
        mems.forEach((m) => { body += cell(priceFor(band, n, memPct(band, m), cfg.memPerPerson), cfg.memPerPerson); });
        body += '</tr>';
      });
      wrap.innerHTML = `<table class="calc"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    });

    renderSummary();
    renderPreview();
    autosave();
  }

  // ---------- Autosave (per-user, this browser) ----------
  let saveTimer;
  function autosave() {
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(exportConfig()));
        setSaveStatus('saved');
      } catch (_) {
        setSaveStatus('error');
      }
    }, 300);
  }

  function setSaveStatus(mode) {
    const el = document.getElementById('saveStatus');
    if (!el) return;
    const txt = el.querySelector('.save-status-text');
    el.dataset.state = mode;
    if (txt) txt.textContent = mode === 'saving' ? 'Saving…' : mode === 'error' ? 'Not saved' : 'Saved';
  }

  function renderSummary() {
    const body = $('#summaryBody');
    const s = state.structure;
    const metrics = [
      ['Court group', state.court.name.trim() || 'Not specified'],
      ['Pricing model', state.model === 'hybrid' ? 'Hybrid (Mixed)' : state.model === 'spot-plus' ? 'Spot+ (Per Spot)' : 'Court+ (Per Court)'],
      ['Base group size', `${s.baseGroup} players`],
      ['Max players', `${s.maxPlayers}`],
      ['Time bands', String(state.bands.length)],
      ['Custom memberships', String(state.memberships.length)],
      ['Day pass', state.dayPass.enabled ? money(num(state.dayPass.fee)) : 'Disabled'],
    ];
    body.innerHTML = metrics.map(([k, v]) =>
      `<div class="summary-metric"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`
    ).join('');
  }

  function exportConfig() {
    const cfg = MODELS[state.model];
    const pricingText = state.model === 'hybrid'
      ? 'hybrid (non-members per court, members per person)'
      : state.model === 'spot-plus' ? 'per-person (spot)' : 'per-court';
    return {
      model: state.model,
      court: state.court.name || '',
      pricing: pricingText,
      structure: {
        baseGroupSize: Math.round(num(state.structure.baseGroup)),
        maximumPlayers: Math.round(num(state.structure.maxPlayers)),
        minimumGroupSize: Math.round(num(state.structure.minGroup)),
      },
      memberships: state.memberships.map((m) => ({ name: m.name || '' })),
      dayPass: { enabled: state.dayPass.enabled, fee: num(state.dayPass.fee) },
      bands: state.bands.map((b) => ({
        name: b.name,
        baseCourtPrice: num(b.base),
        extraPlayerSurcharge: num(b.surcharge),
        memberDefaultDiscountPercent: clampPct(b.memberDiscount),
        membershipDiscounts: state.memberships.map((m) => ({
          name: m.name || '', discountPercent: clampPct(memPct(b, m)),
        })),
        courtLockFee: { nonMembers: num(b.lockNon), members: num(b.lockMem) },
        lessonCourtDiscountPercent: { nonMembers: clampPct(b.lessonNon), members: clampPct(b.lessonMem) },
        computed: playerRows().map((r) => {
          const n = r.players;
          const row = { players: r.label };
          if (cfg.baseCol) row.basePrice = +courtPriceFull(b, n).toFixed(2);
          row.nonMember = +priceFor(b, n, 0, cfg.nonPerPerson).toFixed(2);
          row.nonMemberBasis = cfg.nonPerPerson ? 'per-person' : 'per-court';
          row.member = +priceFor(b, n, b.memberDiscount, cfg.memPerPerson).toFixed(2);
          row.memberBasis = cfg.memPerPerson ? 'per-person' : 'per-court';
          row.memberships = state.memberships.map((m) => ({
            name: m.name || '', price: +priceFor(b, n, memPct(b, m), cfg.memPerPerson).toFixed(2),
          }));
          return row;
        }),
      })),
    };
  }

  // Labelled parameter rows for a band (used by both the side preview and the PDF).
  function bandParamRows(b) {
    const rows = [
      ['Base court price', money(num(b.base))],
      ['Extra player surcharge', `+${money(num(b.surcharge))} per extra player`],
      ['Members (default) discount', `${clampPct(b.memberDiscount)}% off`],
    ];
    state.memberships.forEach((m) => rows.push([`${m.name || 'Membership'} discount`, `${clampPct(memPct(b, m))}% off`]));
    rows.push(['Court lock fee — non-members', money(num(b.lockNon))]);
    rows.push(['Court lock fee — members', money(num(b.lockMem))]);
    rows.push(['Lesson court discount — non-members', `${clampPct(b.lessonNon)}% off`]);
    rows.push(['Lesson court discount — members', `${clampPct(b.lessonMem)}% off`]);
    return rows;
  }

  // Side-panel readable summary.
  function renderPreview() {
    const el = $('#previewBody');
    const parts = [];
    parts.push(`<p class="section-note" style="margin:0 0 10px">Generated live from your inputs. Values shown here are exactly what appears in the printable PDF.</p>`);
    state.bands.forEach((b) => {
      const preset = BAND_PRESETS[b.name] || { swatch: '#64748B' };
      parts.push(`<div class="preview-band"><div class="preview-band-title"><span class="band-swatch" style="background:${preset.swatch}"></span>${escapeHtml(b.name)}</div>`);
      bandParamRows(b).forEach(([k, v]) => {
        parts.push(`<div class="summary-metric"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`);
      });
      parts.push(`</div>`);
    });
    el.innerHTML = parts.join('');
  }

  // ---------- PDF export (print-to-PDF of a readable document) ----------
  function buildPrintable() {
    const s = state.structure;
    const rows = playerRows();
    const esc = escapeHtml;
    const now = new Date().toLocaleString();
    const courtName = state.court.name.trim();
    const cfg = MODELS[state.model];
    const modelBadge = state.model === 'hybrid' ? 'Hybrid · Mixed'
      : state.model === 'spot-plus' ? 'Spot+ · Per Spot' : 'Court+ · Per Court';
    const modelBlurb = state.model === 'hybrid'
      ? 'Hybrid pricing model: non-members pay the full court price (per court); members pay per person, with the discount applied to the full court price then divided by the group size. Free-invited players do not pay — the booker can choose to cover their spot.'
      : state.model === 'spot-plus'
      ? 'Spot pricing model: each calculated court price is divided by the group size and charged per person. Non-members pay per person; members pay per person with their membership discount applied to the full court price before dividing. Free-invited players do not pay — the reservation holder covers their spot.'
      : 'Court pricing model: customers pay the full court price regardless of group size. The final court price is divided among the participants invited to pay; any free invites\' portion is covered by the reservation holder. Membership discounts apply to the base court price only, never the extra-player surcharge.';
    const nonQual = cfg.nonPerPerson ? ' (per person)' : ' (per court)';
    const memQual = cfg.memPerPerson ? ' (per person)' : ' (per court)';

    const structTable =
      `<table class="p"><tbody>` +
      `<tr><th>Base group size</th><td>${Math.round(num(s.baseGroup))} players</td></tr>` +
      `<tr><th>Maximum players</th><td>${Math.round(num(s.maxPlayers))}</td></tr>` +
      `<tr><th>Minimum group size</th><td>${Math.round(num(s.minGroup))}</td></tr>` +
      `<tr><th>Day pass</th><td>${state.dayPass.enabled ? money(num(state.dayPass.fee)) + ' per person / day' : 'Disabled'}</td></tr>` +
      `</tbody></table>`;

    const memList = state.memberships.length
      ? `<ul class="p-list">${state.memberships.map((m) => `<li>${esc(m.name || 'Unnamed membership')}</li>`).join('')}</ul>`
      : `<p class="p-muted">No custom memberships (default member discount only).</p>`;

    const bandBlocks = state.bands.map((b) => {
      const params = bandParamRows(b).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
      const cellVal = (v, per) => per ? `${money(v)} each` : money(v);
      let calcHead = '<tr><th>Quantity</th>' + (cfg.baseCol ? '<th>Base price</th>' : '') + `<th>Non-member${nonQual}</th><th>Members (default)${memQual}</th>`;
      state.memberships.forEach((m) => { calcHead += `<th>${esc(m.name || 'Membership')}</th>`; });
      calcHead += '</tr>';
      let calcBody = '';
      rows.forEach((r) => {
        const n = r.players;
        calcBody += `<tr><td>${esc(r.label)}</td>`;
        if (cfg.baseCol) calcBody += `<td>${money(courtPriceFull(b, n))}</td>`;
        calcBody += `<td>${cellVal(priceFor(b, n, 0, cfg.nonPerPerson), cfg.nonPerPerson)}</td><td>${cellVal(priceFor(b, n, b.memberDiscount, cfg.memPerPerson), cfg.memPerPerson)}</td>`;
        state.memberships.forEach((m) => { calcBody += `<td>${cellVal(priceFor(b, n, memPct(b, m), cfg.memPerPerson), cfg.memPerPerson)}</td>`; });
        calcBody += '</tr>';
      });
      return `<section class="p-band">
        <h3>${esc(b.name)}</h3>
        <div class="p-cols">
          <div><h4>Settings entered</h4><table class="p"><tbody>${params}</tbody></table></div>
          <div><h4>Resulting price</h4><table class="p calc"><thead>${calcHead}</thead><tbody>${calcBody}</tbody></table></div>
        </div>
      </section>`;
    }).join('');

    const courtLine = courtName
      ? `<p class="sub court-line"><strong>Court group:</strong> ${esc(courtName)}</p>`
      : `<p class="sub court-line court-missing"><strong>Court group:</strong> not specified — please write in the group of courts this pricing applies to before sending.</p>`;

    const applyNote = `<section class="apply-note">
      <h4 class="apply-title">How to apply this pricing</h4>
      <ol>
        <li>Double-check every value below — the settings you entered and the resulting prices — so it matches what you want to charge.</li>
        <li>Confirm the <strong>court group</strong> named above is the one this pricing should apply to.</li>
        <li>Share this PDF with your PodPlay Customer Success contact. They will apply it to those courts for you.</li>
      </ol>
    </section>`;

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PodPlay Court Pricing Configuration</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Inter', 'Segoe UI', Arial, sans-serif; color: #111111; margin: 32px; font-size: 12px; }
      h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: -.01em; }
      h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 2px solid #111111; padding-bottom: 4px; }
      h3 { font-size: 13px; margin: 0 0 8px; color: #202020; text-transform: uppercase; letter-spacing: .04em; }
      h4 { font-size: 11px; margin: 0 0 5px; color: #828282; text-transform: uppercase; letter-spacing: .04em; }
      .sub { color: #828282; margin: 0 0 4px; }
      .court-line { color: #111111; font-size: 13px; margin: 6px 0; }
      .court-missing { color: #b23a2e; }
      .badge { display:inline-block; background:#e3e3d2; color:#202020; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
      .apply-note { margin: 14px 0 4px; padding: 12px 16px; border: 1px solid #c4c4b0; background: #f8f8f1; border-radius: 6px; page-break-inside: avoid; }
      .apply-note .apply-title { color: #111111; margin: 0 0 6px; }
      .apply-note ol { margin: 0; padding-left: 18px; }
      .apply-note li { margin: 3px 0; color: #202020; }
      table.p { border-collapse: collapse; width: 100%; margin-bottom: 6px; }
      table.p th, table.p td { border: 1px solid #d6d6c4; padding: 5px 8px; text-align: left; vertical-align: top; }
      table.p th { background: #ededdd; font-weight: 600; white-space: nowrap; }
      table.p.calc td, table.p.calc th { text-align: right; }
      table.p.calc td:first-child, table.p.calc th:first-child { text-align: left; }
      .p-list { margin: 4px 0; padding-left: 18px; }
      .p-muted { color: #828282; }
      .p-band { margin-bottom: 18px; page-break-inside: avoid; }
      .p-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      footer { margin-top: 24px; color: #9a9a90; font-size: 10px; border-top: 1px solid #d6d6c4; padding-top: 8px; }
      @media print { body { margin: 14mm; } }
    </style></head><body>
      <h1>PodPlay Court Pricing Configuration</h1>
      <p class="sub"><span class="badge">${esc(modelBadge)}</span> &nbsp; Generated ${esc(now)}</p>
      ${courtLine}
      ${applyNote}
      <p class="sub">${esc(modelBlurb)}</p>
      <h2>Pricing structure</h2>${structTable}
      <h2>Memberships</h2>${memList}
      <h2>Time bands</h2>${bandBlocks}
      <footer>Share this PDF with your PodPlay Customer Success contact to have this pricing applied to your courts. This document is a configuration summary, not a system export.<br>Config ID: ${esc(getUserId())}</footer>
    </body></html>`;
  }

  function exportPdf() {
    const win = window.open('', '_blank');
    if (!win) { toast('Allow pop-ups to export the PDF.', false); return; }
    win.document.open();
    win.document.write(buildPrintable());
    win.document.close();
    // give the new document a tick to lay out, then open the print/PDF dialog
    win.focus();
    setTimeout(() => { win.print(); }, 350);
  }

  // ---------- Validation gate for Save ----------
  function firstInvalid() {
    for (const b of state.bands) {
      if (!isPct(b.memberDiscount)) return `${b.name}: default member discount must be 0–100.`;
      if (!isPct(b.lessonNon)) return `${b.name}: non-member lesson discount must be 0–100.`;
      if (!isPct(b.lessonMem)) return `${b.name}: member lesson discount must be 0–100.`;
      for (const m of state.memberships) {
        const v = b.memDiscounts[m.id];
        if (v !== undefined && v !== '' && !isPct(v)) return `${b.name}: "${m.name || 'unnamed'}" discount must be 0–100.`;
      }
    }
    return null;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, ok = true) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (ok ? ICON.check : '') + `<span>${escapeHtml(msg)}</span>`;
    wrap.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { wrap.innerHTML = ''; }, 2600);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Structure inputs ----------
  function bindStructure() {
    const bind = (id, key) => {
      const el = $('#' + id);
      el.value = state.structure[key];
      el.addEventListener('input', () => {
        state.structure[key] = el.value;
        renderBands();  // labels ("up to N players") depend on base group
        recalc();
      });
    };
    bind('baseGroup', 'baseGroup');
    bind('maxPlayers', 'maxPlayers');
    bind('minGroup', 'minGroup');

    const court = $('#courtName');
    if (court) {
      court.value = state.court.name;
      court.addEventListener('input', () => { state.court.name = court.value; recalc(); });
    }
  }

  // ---------- Day pass ----------
  function bindDayPass() {
    const toggle = $('#dayPassToggle');
    const field = $('#dayPassField');
    const fee = $('#dayPassFee');
    const sync = () => {
      toggle.setAttribute('aria-checked', String(state.dayPass.enabled));
      field.hidden = !state.dayPass.enabled;
    };
    toggle.addEventListener('click', () => {
      state.dayPass.enabled = !state.dayPass.enabled;
      sync(); recalc();
    });
    fee.value = state.dayPass.fee;
    fee.addEventListener('input', () => { state.dayPass.fee = fee.value; recalc(); });
    sync();
  }

  // ---------- Pricing model switch ----------
  function applyModelCopy() {
    const m = MODELS[state.model];
    const badge = document.getElementById('modelBadge');
    if (badge) badge.innerHTML = `<span class="dot"></span> ${m.badge}`;
    const desc = document.getElementById('modelDesc');
    if (desc) desc.textContent = m.desc;
    const hint = document.getElementById('structureHint');
    if (hint) hint.innerHTML = m.hint;
    const fixed = document.getElementById('fixedPriceNote');
    if (fixed) fixed.hidden = state.model !== 'spot-plus';
    const memNote = document.getElementById('memberDiscountNote');
    if (memNote) {
      memNote.textContent =
        state.model === 'court-plus'
          ? "Each membership's discount is applied to the base court price only — the extra-player surcharge is never discounted."
          : state.model === 'spot-plus'
          ? "In Spot+, each membership's discount is applied to the full court price, which is then divided by the group size and charged per person."
          : "In Hybrid, non-members pay the full court price; members pay per person — the discount is applied to the full court price, then divided by the group size.";
    }
    [['modelCourt', 'court-plus'], ['modelSpot', 'spot-plus'], ['modelHybrid', 'hybrid']].forEach(([id, key]) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const active = state.model === key;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
  }

  function setModel(model) {
    if (state.model === model) return;
    state.model = model;
    applyModelCopy();
    recalc();
  }

  function bindModel() {
    const c = document.getElementById('modelCourt');
    const s = document.getElementById('modelSpot');
    const h = document.getElementById('modelHybrid');
    if (c) c.addEventListener('click', () => setModel('court-plus'));
    if (s) s.addEventListener('click', () => setModel('spot-plus'));
    if (h) h.addEventListener('click', () => setModel('hybrid'));
  }

  // ---------- Theme ----------
  function bindTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) root.setAttribute('data-theme', saved);
    $('#themeToggle').addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
    });
  }

  // ---------- Toolbar actions ----------
  function bindToolbar() {
    $('#addMemBtn').addEventListener('click', () => {
      const mem = { id: nextId(), name: '' };
      state.memberships.push(mem);
      // seed each band's discount for this membership with the band default
      state.bands.forEach((b) => { b.memDiscounts[mem.id] = b.memberDiscount; });
      renderMemberships();
      renderBands();
      recalc();
      const inputs = document.querySelectorAll('#memList .mem-name');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    });

    // Single action: Save = open the printable PDF (work is already autosaved).
    $('#saveBtn').addEventListener('click', () => {
      const bad = firstInvalid();
      if (bad) { toast(bad, false); return; }
      if (!state.court.name.trim() &&
          !confirm('No court group is named yet. Your PodPlay contact needs to know which courts this pricing is for. Save the PDF anyway?')) {
        const court = $('#courtName');
        if (court) court.focus();
        return;
      }
      exportPdf();
      toast('PDF ready. Double-check your pricing, then share it with your PodPlay CS to apply it to your courts.');
    });

    $('#resetBtn').addEventListener('click', () => {
      state = defaultState();
      bootRender();
      toast('Reset to default pricing.');
    });
  }

  // ---------- Configuration code panel ----------
  function bindCodePanel() {
    const copyBtn = $('#copyCodeBtn');
    const applyBtn = $('#applyCodeBtn');
    const clientLinkBtn = $('#copyClientLinkBtn');
    const input = $('#codeInput');

    if (clientLinkBtn) clientLinkBtn.addEventListener('click', async () => {
      const link = `${location.origin}${location.pathname}?view=client`;
      const ok = await copyText(link);
      toast(ok ? 'Client link copied.' : `Copy failed — the link is: ${link}`, ok);
    });

    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const bad = firstInvalid();
      if (bad) { toast(bad, false); return; }
      const code = encodeConfigCode();
      const ok = await copyText(code);
      if (ok) {
        toast(`${MODEL_LABEL[state.model]} configuration code copied — send it to your client.`);
      } else {
        if (input) { input.value = code; input.focus(); input.select(); }
        toast('Could not copy automatically — the code is selected below, copy it manually.', false);
      }
    });

    if (applyBtn) applyBtn.addEventListener('click', () => {
      const res = decodeConfigCode(input ? input.value : '');
      if (!res.ok) { toast(res.error, false); return; }
      // A code only applies within its own model (same structure) — no cross-model loads.
      if (res.model !== state.model) {
        toast(`This is a ${MODEL_LABEL[res.model]} code. Switch to ${MODEL_LABEL[res.model]} first, then apply it.`, false);
        return;
      }
      hydrate(res.cfg);
      bootRender();
      if (input) input.value = '';
      toast(`${MODEL_LABEL[res.model]} configuration applied.`);
    });
  }

  // ---------- Admin gate (soft; static hosting has no real login) ----------
  // The admin console is the DEFAULT page (the owner's landing page). A shared
  // client link is the same site with ?view=client — that skips the passcode and
  // opens in client mode (apply a code, but cannot generate one).
  function resolveAdmin() {
    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'client') return false;   // shared client link
    if (sessionStorage.getItem(ADMIN_FLAG) === '1') return true;
    const entry = window.prompt('Admin passcode:');
    if (entry === ADMIN_PASSCODE) { sessionStorage.setItem(ADMIN_FLAG, '1'); return true; }
    if (entry !== null) window.alert('Incorrect passcode — opening in client mode (you can apply a code, but not generate one).');
    return false;
  }

  function applyAdminChrome() {
    document.body.classList.toggle('is-admin', isAdmin);
    const exportBox = document.getElementById('codeExport');
    if (exportBox) exportBox.hidden = !isAdmin;
    const pill = document.getElementById('adminPill');
    if (pill) pill.hidden = !isAdmin;
    const codeCard = document.getElementById('codeCard');
    if (codeCard) codeCard.hidden = false; // both admins and clients see the card
  }

  // ---------- Boot ----------
  function bootRender() {
    const court = $('#courtName');
    if (court) court.value = state.court.name;
    $('#baseGroup').value = state.structure.baseGroup;
    $('#maxPlayers').value = state.structure.maxPlayers;
    $('#minGroup').value = state.structure.minGroup;
    $('#dayPassFee').value = state.dayPass.fee;
    $('#dayPassToggle').setAttribute('aria-checked', String(state.dayPass.enabled));
    $('#dayPassField').hidden = !state.dayPass.enabled;
    applyModelCopy();
    renderMemberships();
    renderBands();
    renderAddBand();
    recalc();
  }

  function init() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) hydrate(JSON.parse(raw));
    } catch (_) { /* ignore corrupt storage */ }

    isAdmin = resolveAdmin();

    bindTheme();
    bindModel();
    bindStructure();
    bindDayPass();
    bindToolbar();
    bindCodePanel();
    bootRender();
    applyAdminChrome();
  }

  // Rebuild internal state from an exported config shape.
  function hydrate(cfg) {
    if (!cfg || !MODELS[cfg.model]) return;
    const memberships = (cfg.memberships || []).map((m) => ({ id: nextId(), name: m.name || '' }));
    // Map export name -> membership id (names are the join key in the export).
    const byName = new Map(memberships.map((m) => [m.name, m.id]));
    state = {
      model: cfg.model,
      court: { name: cfg.court || '' },
      structure: {
        baseGroup: cfg.structure?.baseGroupSize ?? 2,
        maxPlayers: cfg.structure?.maximumPlayers ?? 4,
        minGroup: cfg.structure?.minimumGroupSize ?? 2,
      },
      memberships,
      dayPass: { enabled: !!cfg.dayPass?.enabled, fee: cfg.dayPass?.fee ?? 0 },
      bands: (cfg.bands || []).map((b) => {
        const memDiscounts = {};
        (b.membershipDiscounts || []).forEach((md) => {
          const id = byName.get(md.name || '');
          if (id) memDiscounts[id] = md.discountPercent ?? 0;
        });
        return {
          id: nextId(), name: b.name, removable: b.name !== 'OFF PEAK',
          base: b.baseCourtPrice ?? 0,
          surcharge: b.extraPlayerSurcharge ?? 0,
          memberDiscount: b.memberDefaultDiscountPercent ?? 0,
          memDiscounts,
          lockNon: b.courtLockFee?.nonMembers ?? 0,
          lockMem: b.courtLockFee?.members ?? 0,
          lessonNon: b.lessonCourtDiscountPercent?.nonMembers ?? 0,
          lessonMem: b.lessonCourtDiscountPercent?.members ?? 0,
        };
      }),
    };
    if (!state.bands.length) state = defaultState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
