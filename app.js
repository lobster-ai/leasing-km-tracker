// Make debugging easier
    try {
      const ind0 = document.getElementById('jsIndicator');
      if (ind0) ind0.textContent = 'JS: app.js executed ✅';
    } catch (e) {}

    document.title = 'ליסינג – ניהול ק״מ • v0.3.5 (loading...)';
    window.__leasingKmTrackerLoaded = false;

    // Mobile-friendly error reporting (shows copyable alert)
    (function(){
      function fmt(prefix, err){
        try {
          const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
          return prefix + '\n' + msg;
        } catch (_) {
          return prefix + '\n' + String(err);
        }
      }
      window.addEventListener('error', (e) => {
        const text = fmt('JS ERROR', e?.error || e?.message || e);
        alert(text);
      });
      window.addEventListener('unhandledrejection', (e) => {
        const text = fmt('PROMISE REJECTION', e?.reason || e);
        alert(text);
      });
    })();

    // --- Settings (per your requirements) ---
    const LEASE_START = new Date('2025-06-26T00:00:00');
    const ANNUAL_QUOTA = 20000;
    const TOTAL_QUOTA = 60000; // 3 years
    const BASELINE_ODO = 0;

    // --- Supabase (PUBLIC MODE) ---
    const SUPABASE_URL = 'https://ajyphgxwyuplarrcxdfj.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_0I-7RIxnBEkOx0vKzZdJ5Q_cFxWy9-1';
    let supabase = null;
    const READINGS_TABLE = 'readings';

    const STORAGE_KEY = 'leasingKmTracker.v1'; // fallback/local cache

    const $ = (id) => document.getElementById(id);

    function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

    function showToast(msg, ms=1600){
      const el = $('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(showToast._t);
      showToast._t = setTimeout(()=> el.classList.remove('show'), ms);
    }

    function dateToISO(d){
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd}`;
    }

    function parseISODate(s){
      // treat as local date
      const [y,m,d] = s.split('-').map(Number);
      return new Date(y, m-1, d, 0,0,0,0);
    }

    function startOfWeekSunday(d){
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const day = x.getDay(); // 0=Sun
      x.setDate(x.getDate() - day);
      x.setHours(0,0,0,0);
      return x;
    }

    function endOfWeekSunday(d){
      const s = startOfWeekSunday(d);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      e.setHours(0,0,0,0);
      return e;
    }

    function leaseYearStartFor(date){
      // Anniversary-based lease year boundaries starting at LEASE_START.
      // Find the most recent anniversary <= date.
      let y = date.getFullYear();
      const annThisYear = new Date(y, LEASE_START.getMonth(), LEASE_START.getDate());
      annThisYear.setHours(0,0,0,0);
      if (date < annThisYear) y -= 1;
      const start = new Date(y, LEASE_START.getMonth(), LEASE_START.getDate());
      start.setHours(0,0,0,0);
      return start;
    }

    function leaseYearEndFor(date){
      const start = leaseYearStartFor(date);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);
      return end;
    }

    function daysBetween(a,b){
      const ms = 24*60*60*1000;
      const aa = new Date(a); aa.setHours(0,0,0,0);
      const bb = new Date(b); bb.setHours(0,0,0,0);
      return Math.round((bb - aa)/ms);
    }

    function load(){
      // Local fallback cache (used if Supabase unavailable)
      try{
        const raw = localStorage.getItem(STORAGE_KEY);
        if(!raw) return { readings: [] };
        const parsed = JSON.parse(raw);
        if(!parsed.readings) parsed.readings = [];
        return parsed;
      } catch(e){
        return { readings: [] };
      }
    }

    function save(state){
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function ensureSupabase(){
      if (!supabase) throw new Error('Supabase not initialized');
      return supabase;
    }

    function hasReadingAtOrBefore(readings, date){
      const iso = dateToISO(date);
      return readings.some(r => r.date <= iso);
    }

    function fillMissingWeeks(weeks, startDate, endDate){
      // weeks: array of {weekStartISO, km} sorted asc
      const start = startOfWeekSunday(startDate);
      const end = startOfWeekSunday(endDate);
      const map = new Map(weeks.map(w => [w.weekStartISO, w.km]));
      const out = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate()+7)) {
        const iso = dateToISO(d);
        out.push({ weekStartISO: iso, km: map.get(iso) || 0 });
      }
      return out;
    }

    async function fetchReadingsRemote(){
      const sb = ensureSupabase();
      const { data, error } = await sb
        .from(READINGS_TABLE)
        .select('id,date,odometer_km,created_at')
        .order('date', { ascending: true })
        .order('odometer_km', { ascending: true });
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id,
        date: r.date,
        odometerKm: Number(r.odometer_km),
        created_at: r.created_at
      }));
    }

    async function insertReadingRemote(date, odometerKm){
      const sb = ensureSupabase();
      const { data, error } = await sb
        .from(READINGS_TABLE)
        .insert({ date, odometer_km: odometerKm })
        .select('id,date,odometer_km,created_at')
        .single();
      if (error) throw error;
      return {
        id: data.id,
        date: data.date,
        odometerKm: Number(data.odometer_km),
        created_at: data.created_at
      };
    }

    // delete disabled in this version

    function normalizeReadings(readings){
      // Ensure sorted ascending by date, then by odo.
      const r = readings
        .map(x => ({ id: x.id, date: x.date, odometerKm: Number(x.odometerKm) }))
        .filter(x => x.date && Number.isFinite(x.odometerKm) && x.odometerKm >= 0)
        .sort((a,b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.odometerKm - b.odometerKm));
      // Remove exact duplicates (same date+km)
      const out = [];
      const seen = new Set();
      for(const x of r){
        const k = x.date + '|' + x.odometerKm;
        if(seen.has(k)) continue;
        seen.add(k);
        out.push(x);
      }
      return out;
    }

    function getLastOdo(readings){
      if(!readings.length) return BASELINE_ODO;
      return readings[readings.length-1].odometerKm;
    }

    function computeWeeklyDeltas(readings){
      // Returns array of {weekStartISO, km}
      const deltas = [];
      for(let i=0;i<readings.length;i++){
        const cur = readings[i];
        const prevOdo = i===0 ? BASELINE_ODO : readings[i-1].odometerKm;
        const delta = Math.max(0, cur.odometerKm - prevOdo);
        deltas.push({ date: cur.date, delta });
      }
      const byWeek = new Map();
      for(const d of deltas){
        const ws = startOfWeekSunday(parseISODate(d.date));
        const key = dateToISO(ws);
        byWeek.set(key, (byWeek.get(key) || 0) + d.delta);
      }
      const weeks = Array.from(byWeek.entries())
        .map(([weekStartISO, km]) => ({ weekStartISO, km }))
        .sort((a,b)=> a.weekStartISO.localeCompare(b.weekStartISO));
      return weeks;
    }

    function kpiCard(label, valueText, cls, sub){
      const el = document.createElement('div');
      el.className = 'kpi';
      el.innerHTML = `
        <div class="label">${label}</div>
        <div class="value ${cls||''}">${valueText}</div>
        ${sub ? `<div class="sub">${sub}</div>` : ''}
      `;
      return el;
    }

    let lineChart, barChart;

    async function render(){
      // Try Supabase first; fall back to local cache if needed.
      let readings;
      try {
        const remote = await fetchReadingsRemote();
        readings = normalizeReadings(remote);
        save({ readings });
      } catch (e) {
        const state = load();
        state.readings = normalizeReadings(state.readings);
        save(state);
        readings = state.readings;
      }

      const lastOdo = getLastOdo(readings);
      const drivenTotal = Math.max(0, lastOdo - BASELINE_ODO);

      const now = new Date();
      const weekStart = startOfWeekSunday(now);
      const weekEnd = endOfWeekSunday(now);

      // Lease-year boundaries (anniversary-based)
      const yStart = leaseYearStartFor(now);
      const yEnd = leaseYearEndFor(now);

      // --- Your preferred logic ---
      // Take the remaining km in the lease-year and spread it across the remaining weeks.
      // Then show how many km are left to drive in the *current* week.

      const odoAtYearStart = odoAtOrBefore(readings, yStart);
      const drivenThisYear = Math.max(0, lastOdo - odoAtYearStart);
      const remainingToYearEnd = Math.floor(ANNUAL_QUOTA - drivenThisYear);

      // Weekly calculation needs an odometer value at the start of the week.
      // If there is no reading at/before week start (common when first using the app),
      // we can't know how much was driven since Sunday. In that case, assume 0 for now
      // and show a note until the next reading arrives.
      const odoAtWeekStartRaw = odoAtOrBefore(readings, weekStart);
      const hasWeekStartAnchor = hasReadingAtOrBefore(readings, weekStart);
      const odoAtWeekStart = hasWeekStartAnchor ? odoAtWeekStartRaw : lastOdo;
      const drivenThisWeek = Math.max(0, lastOdo - odoAtWeekStart);

      const MS_DAY = 24*60*60*1000;
      const weeksRemaining = Math.max(1, Math.ceil((yEnd - weekStart) / (7*MS_DAY)));
      const weeklyBudget = (ANNUAL_QUOTA - drivenThisYear) / weeksRemaining;
      const remainingToWeekEnd = Math.floor(weeklyBudget - drivenThisWeek);

      const remainingTotalLease = Math.floor(TOTAL_QUOTA - drivenTotal);

      const kpis = $('kpis');
      kpis.innerHTML = '';

      const clsWeek = remainingToWeekEnd >= 0 ? 'good' : 'bad';
      const anchorNote = hasWeekStartAnchor ? '' : ' • אין קריאה בתחילת השבוע → מניחים 0 ק״מ לשבוע עד שתוזן קריאה נוספת';
      const weekSub = `שבוע: ${dateToISO(weekStart)} → ${dateToISO(weekEnd)} • נשארו ${weeksRemaining} שבועות עד ${dateToISO(yEnd)} • תקציב שבועי ~ ${Math.floor(weeklyBudget).toLocaleString('he-IL')} ק״מ${anchorNote}`;
      kpis.appendChild(kpiCard('כמה ק״מ נשאר לך לנסוע עד סוף השבוע (לפי חלוקה לשבועות שנותרו)', formatKm(remainingToWeekEnd), clsWeek, weekSub));

      const clsYear = remainingToYearEnd >= 0 ? 'good' : 'bad';
      kpis.appendChild(kpiCard('יתרה לשנת הליסינג הנוכחית (20,000)', formatKm(remainingToYearEnd), clsYear, `נסעת השנה: ${formatKm(drivenThisYear)} (מהתאריך ${dateToISO(yStart)})`));

      const clsTotal = remainingTotalLease >= 0 ? 'good' : 'bad';
      kpis.appendChild(kpiCard('יתרה לכל התקופה (60,000)', formatKm(remainingTotalLease), clsTotal, `נסעת עד כה: ${formatKm(drivenTotal)}`));

      // Rows
      const tbody = $('rows');
      tbody.innerHTML = '';
      for(let i=readings.length-1; i>=0; i--){
        const cur = readings[i];
        const prevOdo = i===0 ? BASELINE_ODO : readings[i-1].odometerKm;
        const delta = Math.max(0, cur.odometerKm - prevOdo);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${cur.date}</td>
          <td>${formatKm(cur.odometerKm)}</td>
          <td>${formatKm(delta)}</td>
        `;
        tbody.appendChild(tr);
      }

      // Charts
      renderCharts(readings);
    }

    function formatKm(n){
      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);
      return sign + abs.toLocaleString('he-IL') + ' ק״מ';
    }

    function odoAtOrBefore(readings, date){
      const iso = dateToISO(date);
      let last = BASELINE_ODO;
      for(const r of readings){
        if(r.date <= iso) last = r.odometerKm;
        else break;
      }
      return last;
    }

    function kmAtDate(readings, date){
      // returns last odometer at or before date, relative to BASELINE
      const last = odoAtOrBefore(readings, date);
      return Math.max(0, last - BASELINE_ODO);
    }

    function renderCharts(readings){
      const labels = readings.map(r => r.date);
      const odo = readings.map(r => r.odometerKm);

      let weekly = computeWeeklyDeltas(readings);
      // Fill missing weeks so a reading after months still shows the skipped weeks (0 km).
      const startForWeeks = readings.length ? parseISODate(readings[0].date) : LEASE_START;
      weekly = fillMissingWeeks(weekly, startForWeeks, new Date());
      const wLabels = weekly.map(w => w.weekStartISO);
      const wKm = weekly.map(w => Math.round(w.km));

      // Line
      const lineCtx = $('lineChart').getContext('2d');
      if(lineChart) lineChart.destroy();
      lineChart = new Chart(lineCtx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'קריאת ק״מ (מד אוץ)',
            data: odo,
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56,189,248,.15)',
            pointRadius: 3,
            tension: 0.2,
            fill: true,
          }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { labels: { color: '#e5e7eb' } },
            tooltip: { callbacks: { label: (ctx) => formatKm(ctx.parsed.y) } }
          },
          scales: {
            x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(34,48,79,.35)' } },
            y: { ticks: { color: '#94a3b8', callback: (v)=> v.toLocaleString('he-IL') }, grid: { color: 'rgba(34,48,79,.35)' } }
          }
        }
      });

      // Bar
      const barCtx = $('barChart').getContext('2d');
      if(barChart) barChart.destroy();
      barChart = new Chart(barCtx, {
        type: 'bar',
        data: {
          labels: wLabels,
          datasets: [{
            label: 'ק״מ בשבוע',
            data: wKm,
            borderColor: '#34d399',
            backgroundColor: 'rgba(52,211,153,.25)'
          }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { labels: { color: '#e5e7eb' } },
            tooltip: { callbacks: { label: (ctx) => formatKm(ctx.parsed.y) } }
          },
          scales: {
            x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(34,48,79,.35)' } },
            y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(34,48,79,.35)' } }
          }
        }
      });
    }

    async function addReading(){
      const odo = Number($('odo').value);
      const date = $('date').value;
      if(!Number.isFinite(odo) || odo < 0) { showToast('נא להזין מספר ק״מ תקין'); return; }
      if(!date) { showToast('נא לבחור תאריך'); return; }

      // Validate against last known reading (prefer remote, else local)
      let readings;
      try {
        readings = normalizeReadings(await fetchReadingsRemote());
      } catch (_) {
        const state = load();
        readings = normalizeReadings(state.readings);
      }
      const last = getLastOdo(readings);
      if (readings.length && odo < last) {
        showToast('הקריאה חייבת להיות גדולה/שווה לקריאה האחרונה');
        return;
      }

      try {
        await insertReadingRemote(date, odo);
        $('odo').value = '';
        await render();
        showToast('נשמר בענן');
      } catch (e) {
        // fallback local save
        const state = load();
        state.readings = normalizeReadings(state.readings);
        state.readings.push({ date, odometerKm: odo });
        state.readings = normalizeReadings(state.readings);
        save(state);
        $('odo').value = '';
        await render();
        showToast('נשמר מקומית (הענן לא זמין/אין טבלה)');
      }
    }

    async function resetAll(){
      if(!confirm('למחוק את כל הנתונים מהמכשיר?')) return;
      // In public mode, "reset" will only clear local cache (not remote).
      localStorage.removeItem(STORAGE_KEY);
      await render();
      showToast('נמחק מקומית (הענן נשאר)');
    }

    // export/import removed

    function initApp() {
      try {
        // Init Supabase client (if library loaded)
        if (window.supabase && typeof window.supabase.createClient === 'function') {
          supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        } else {
          supabase = null;
          showToast('Supabase לא נטען (יתכן חסימה/רשת) — עובד זמנית מקומית');
        }

        $('date').value = dateToISO(new Date());
        $('save').addEventListener('click', () => addReading());
        $('resetAll').addEventListener('click', resetAll);
        // export/import removed

        window.__leasingKmTrackerLoaded = true;
        document.title = 'ליסינג – ניהול ק״מ • v0.3.5';
        const ind = document.getElementById('jsIndicator');
        if (ind) ind.textContent = 'JS: loaded ✅ (app.js)';
        render();
      } catch (e) {
        console.error('Init failed', e);
        showToast('שגיאה בטעינה: ' + String(e));
      }
    }

    // init: run as soon as DOM is ready (don't rely on the load event)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initApp, { once: true });
    } else {
      initApp();
    }
