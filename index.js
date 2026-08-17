// Passerelle Nextcloud Tables -> Gantt, Grille (Excel) et Flux ICS
import express from "express";
import { execSync } from "child_process";

const baseUrl = (process.env.NEXTCLOUD_URL || "").replace(/['"]/g, '').trim().replace(/\/$/, '');
const user = (process.env.NC_USER || "").replace(/['"]/g, '').trim();
const pass = (process.env.NC_APP_PASSWORD || "").replace(/['"]/g, '').trim();
const TABLE_ID = (process.env.TABLE_ID || "2").replace(/['"]/g, '').trim();
const CACHE_TTL_SECONDS = (process.env.CACHE_TTL_SECONDS || "120").replace(/['"]/g, '').trim();
const PORT = (process.env.PORT || "3000").replace(/['"]/g, '').trim();

if (!baseUrl || !user || !pass) {
  console.error("Variables d'environnement manquantes.");
  process.exit(1);
}

const AUTH_HEADER = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

const COL = { NOM: 5, DATE_DEBUT: 8, DATE_FIN: 9, STATUS: 17, ECHEANCE_CSE: 16, DEBUT_COM: 36, FIN_COM: 37, DEBUT_INSCRIPTIONS: 33, FIN_INSCRIPTIONS: 34, SAISON: 21 };
const STATUS_MAP = {
  "0": { label: "À préparer", icon: "🟡", color: "#f1c40f" },
  "1": { label: "Infos envoyées", icon: "🔵", color: "#3498db" },
  "2": { label: "Publié", icon: "🟣", color: "#9b59b6" },
  "3": { label: "Réalisé", icon: "🟢", color: "#2ecc71" }
};
const DEFAULT_STATUS = { label: "Non défini", icon: "⚪", color: "#ccc" };

let ncCache = { data: null, fetchedAt: 0 };
let holidayCache = { data: [], fetchedAt: 0 };
const TTL_MS = parseInt(CACHE_TTL_SECONDS, 10) * 1000;

// Outils de formatage des dates
function formatDateFR(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.substring(0, 10));
  const f = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' }).format(d);
  return f.charAt(0).toUpperCase() + f.slice(1);
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Fetch Nextcloud
async function fetchEvents() {
  const now = Date.now();
  if (ncCache.data && now - ncCache.fetchedAt < TTL_MS) return ncCache.data;
  const fullUrl = `${baseUrl}/index.php/apps/tables/api/1/tables/${TABLE_ID}/rows`;
  try {
    const stdout = execSync(`curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" -H "Authorization: ${AUTH_HEADER}" "${fullUrl}"`, { encoding: 'utf8' });
    const rows = JSON.parse(stdout);
    const events = rows.map(row => {
      const cellValue = (colId) => {
        const c = row.data?.find(x => x.columnId === colId);
        if (!c || c.value === null || c.value === "") return null;
        if (Array.isArray(c.value) && c.value.length > 0 && typeof c.value[0] === "object") return c.value.map(u => u.displayName || u.id).join(", ");
        return String(c.value);
      };
      return {
        id: row.id,
        nom: cellValue(COL.NOM) || `Événement #${row.id}`,
        dateDebut: cellValue(COL.DATE_DEBUT),
        dateFin: cellValue(COL.DATE_FIN),
        statut: cellValue(COL.STATUS),
        echeanceCSE: cellValue(COL.ECHEANCE_CSE),
        debutCom: cellValue(COL.DEBUT_COM),
        finCom: cellValue(COL.FIN_COM),
        debutInscriptions: cellValue(COL.DEBUT_INSCRIPTIONS),
        finInscriptions: cellValue(COL.FIN_INSCRIPTIONS)
      };
    }).filter(e => e.dateDebut);
    events.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));
    ncCache = { data: events, fetchedAt: now };
    return events;
  } catch (err) { throw new Error(`Erreur Nextcloud: ${err.message}`); }
}

// Fetch Vacances Scolaires (Zone C)
function getHolidays() {
  const now = Date.now();
  if (holidayCache.data.length > 0 && now - holidayCache.fetchedAt < 24 * 3600 * 1000) return holidayCache.data;
  try {
    const url = `https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records?where=location%3D%22Toulouse%22&limit=100`;
    const stdout = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
    const json = JSON.parse(stdout);
    if (json && json.results) {
      holidayCache.data = json.results.map(r => ({ start: new Date(r.start_date).getTime(), end: new Date(r.end_date).getTime() }));
    }
    holidayCache.fetchedAt = now;
  } catch (err) { console.error("Impossible de récupérer les vacances scolaires.", err.message); }
  return holidayCache.data;
}

function isHoliday(timestamp, holidays) {
  return holidays.some(h => timestamp >= h.start && timestamp <= h.end);
}

// --- VUE 1 : GANTT ---
function generateFloatingGantt(events, holidays) {
  if (events.length === 0) return "<h1>Aucun événement à afficher</h1>";
  const todayMs = Date.now();

  let allDates = [];
  events.forEach(e => {
    ['dateDebut', 'dateFin', 'debutCom', 'finCom', 'debutInscriptions', 'finInscriptions', 'echeanceCSE'].forEach(c => {
      if (e[c]) allDates.push(new Date(e[c].substring(0, 10)).getTime());
    });
  });

  const minTime = Math.min(...allDates) - (10 * 24 * 3600 * 1000);
  const maxTime = Math.max(...allDates) + (15 * 24 * 3600 * 1000);
  const totalSpan = maxTime - minTime;
  const getPos = (dStr) => dStr ? ((new Date(dStr.substring(0, 10)).getTime() - minTime) / totalSpan) * 100 : null;

  // Calcul du calendrier pour l'arrière-plan et l'en-tête (Mois et Semaines)
  let bgHTML = '';
  let timelineHTML = '';
  let cur = new Date(minTime);
  cur.setHours(0,0,0,0);
  
  const MOIS_NOMS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  let months = {};
  let weeks = {};

  while (cur.getTime() <= maxTime) {
    let t = cur.getTime();
    let pos = ((t - minTime) / totalSpan) * 100;
    let width = (86400000 / totalSpan) * 100;
    
    if (cur.getDay() === 0 || cur.getDay() === 6) bgHTML += `<div class="bg-weekend" style="left:${pos}%; width:${width}%;"></div>`;
    else if (isHoliday(t, holidays)) bgHTML += `<div class="bg-holiday" style="left:${pos}%; width:${width}%;"></div>`;
    
    // Groupement par mois
    let mKey = cur.getFullYear() + "-" + cur.getMonth();
    if (!months[mKey]) months[mKey] = { start: pos, end: pos, name: MOIS_NOMS[cur.getMonth()] + " " + cur.getFullYear() };
    months[mKey].end = pos + width;

    // Groupement par semaine
    let wn = getWeekNumber(cur);
    let yKey = cur.getFullYear();
    if (cur.getMonth() === 11 && wn === 1) yKey++;
    if (cur.getMonth() === 0 && wn > 51) yKey--;
    let wKey = yKey + "-W" + wn;
    if (!weeks[wKey]) weeks[wKey] = { start: pos, end: pos, num: wn, firstDate: t, lastDate: t };
    weeks[wKey].end = pos + width;
    weeks[wKey].lastDate = t;

    cur.setDate(cur.getDate() + 1);
  }

  const todayPos = ((todayMs - minTime) / totalSpan) * 100;
  if (todayPos >= 0 && todayPos <= 100) bgHTML += `<div class="bg-today" style="left:${todayPos}%;" title="Aujourd'hui"></div>`;

  // Construction des En-têtes Temporels
  Object.values(months).forEach(m => {
    timelineHTML += `<div class="bg-month-block" style="left:${m.start}%; width:${m.end - m.start}%;">${m.name}</div>`;
    bgHTML += `<div class="bg-month-line" style="left:${m.start}%;"></div>`;
  });
  Object.values(weeks).forEach(w => {
    let tooltip = `Du ${formatDateFR(new Date(w.firstDate).toISOString())} au ${formatDateFR(new Date(w.lastDate).toISOString())}`;
    timelineHTML += `<div class="bg-week-block" style="left:${w.start}%; width:${w.end - w.start}%;" title="${tooltip}">S${w.num}</div>`;
    bgHTML += `<div class="bg-week-line" style="left:${w.start}%;"></div>`;
  });

  // Construction des Lignes
  let htmlFiltres = "";
  let rowsHTML = events.map(e => {
    let barres = '';
    const evEndTime = new Date(e.dateFin || e.dateDebut).getTime();
    const isPast = (evEndTime + 86400000) < todayMs;
    const s = STATUS_MAP[e.statut] || DEFAULT_STATUS;
    
    htmlFiltres += `<label><input type="checkbox" ${isPast ? "" : "checked"} onchange="toggleEv('row-${e.id}', this)"> ${s.icon} ${e.nom}</label>`;

    const pComD = getPos(e.debutCom), pComF = getPos(e.finCom);
    if (pComD !== null && pComF !== null) {
      const txt = `Com ${formatDateFR(e.debutCom)} au ${formatDateFR(e.finCom)}`;
      barres += `<div class="bar bar-com" style="left:${pComD}%; width:${Math.max(pComF - pComD, 0.5)}%;" title="${txt}">Com</div>`;
    }

    const pInsD = getPos(e.debutInscriptions), pInsF = getPos(e.finInscriptions);
    if (pInsD !== null && pInsF !== null) {
      const txt = `Inscription ${formatDateFR(e.debutInscriptions)} au ${formatDateFR(e.finInscriptions)}`;
      barres += `<div class="bar bar-ins" style="left:${pInsD}%; width:${Math.max(pInsF - pInsD, 0.5)}%;" title="${txt}">Insc.</div>`;
    }

    const pEvD = getPos(e.dateDebut), pEvF = getPos(e.dateFin || e.dateDebut);
    if (pEvD !== null) {
      const endText = e.dateFin && e.dateFin !== e.dateDebut ? ` au ${formatDateFR(e.dateFin)}` : '';
      const txt = `Event ${formatDateFR(e.dateDebut)}${endText}`;
      barres += `<div class="bar bar-ev" style="left:${pEvD}%; width:${Math.max(pEvF - pEvD, 0.5)}%;" title="${txt}">${e.nom}</div>`;
    }

    const pCse = getPos(e.echeanceCSE);
    if (pCse !== null) {
      const isDone = (e.statut === "1" || e.statut === "2" || e.statut === "3");
      const txt = `Echéance CSE ${formatDateFR(e.echeanceCSE)}`;
      barres += `<div class="marker-cse" style="left:${pCse}%;" title="${txt}">${isDone ? "✅" : "🔴"}</div>`;
    }

    return `
      <div class="gantt-row" id="row-${e.id}" style="${isPast ? 'display:none;' : ''}">
        <div class="row-label"><strong>${e.nom}</strong><span class="badge">${s.label}</span></div>
        <div class="row-track">${barres}</div>
      </div>
    `;
  }).join("");

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Gantt SLAT</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f4f7f6; margin: 2rem; color: #333; }
      .nav-tabs { margin-bottom: 20px; }
      .nav-tabs a { padding: 8px 15px; background: #dae5f1; text-decoration: none; border-radius: 4px; color: #333; margin-right: 10px; font-weight: bold; border: 1px solid #5a7b9c; }
      .nav-tabs a.active { background: #5a7b9c; color: white; }
      .controls { background: white; padding: 10px; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.85rem; border: 1px solid #e1e8ed; }
      .controls label { cursor: pointer; padding: 4px 8px; background: #eef2f5; border-radius: 4px; }
      
      .gantt-container { background: #fff; border-radius: 8px; border: 1px solid #e1e8ed; overflow: hidden; position: relative; }
      
      .timeline-header { position: absolute; top: 0; left: 250px; right: 0; height: 40px; background: #fff; z-index: 20; border-bottom: 1px solid #ccc; }
      .bg-month-block { position: absolute; top: 0; height: 20px; text-align: center; font-size: 12px; font-weight: bold; background: #dae5f1; line-height: 20px; border-right: 1px solid #5a7b9c; border-bottom: 1px solid #5a7b9c; box-sizing: border-box;}
      .bg-week-block { position: absolute; top: 20px; height: 20px; text-align: center; font-size: 10px; color: #555; background: #eef2f5; line-height: 20px; cursor: help; border-right: 1px solid #ddd; box-sizing: border-box; }
      
      .bg-layer { position: absolute; top: 40px; left: 250px; right: 0; bottom: 0; pointer-events: none; z-index: 0; }
      .bg-weekend { position: absolute; height: 100%; background: rgba(0,0,0,0.03); }
      .bg-holiday { position: absolute; height: 100%; background: rgba(46,204,113,0.15); }
      .bg-month-line { position: absolute; height: 100%; width: 1px; background: #999; }
      .bg-week-line { position: absolute; height: 100%; width: 1px; background: #eee; z-index: -1; }
      .bg-today { position: absolute; height: 100%; width: 2px; background: rgba(231, 76, 60, 0.8); z-index: 5; }

      .rows-layer { position: relative; z-index: 1; padding-top: 40px; }
      .gantt-row { display: flex; border-bottom: 1px solid #f0f0f0; min-height: 55px; }
      .row-label { width: 250px; min-width: 250px; padding: 10px; background: rgba(255,255,255,0.9); border-right: 1px solid #e1e8ed; display: flex; flex-direction: column; justify-content: center; font-size: 0.9rem; z-index: 10; box-sizing: border-box; }
      .badge { font-size: 0.7rem; color: #888; margin-top: 4px; }
      .row-track { flex-grow: 1; position: relative; padding: 10px 0; }
      
      .bar { position: absolute; height: 18px; border-radius: 3px; color: white; font-size: 0.7rem; font-weight: 600; display: flex; align-items: center; padding: 0 5px; overflow: hidden; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor: help; }
      .bar-com { background-color: #9b59b6; top: 0px; height: 14px; font-size: 0.6rem; }
      .bar-ins { background-color: #3498db; top: 16px; height: 14px; font-size: 0.6rem; }
      .bar-ev { background-color: #2ecc71; top: 32px; }
      .marker-cse { position: absolute; top: -5px; transform: translateX(-50%); font-size: 0.9rem; cursor: help; }
      
      .legend { display: flex; gap: 15px; margin-top: 15px; font-size: 0.85rem; }
      .leg-item { display: flex; align-items: center; gap: 5px; }
      .box { width: 15px; height: 15px; border-radius: 3px; }
    </style>
    <script>
      function toggleEv(id, cb) { document.getElementById(id).style.display = cb.checked ? '' : 'none'; }
    </script>
    </head><body>
      <h1>Planning SLAT</h1>
      <div class="nav-tabs"><a href="/" class="active">Vue Gantt</a> <a href="/grille">Vue Grille (Excel)</a></div>
      <div class="controls"><strong>Filtres:</strong> ${htmlFiltres}</div>
      <div class="gantt-container">
        <div class="timeline-header">${timelineHTML}</div>
        <div class="bg-layer">${bgHTML}</div>
        <div class="rows-layer">${rowsHTML}</div>
      </div>
      <div class="legend">
        <div class="leg-item"><div class="box" style="background:#9b59b6"></div> Com</div>
        <div class="leg-item"><div class="box" style="background:#3498db"></div> Inscriptions</div>
        <div class="leg-item"><div class="box" style="background:#2ecc71"></div> Événement</div>
        <div class="leg-item"><div class="box" style="background:rgba(46,204,113,0.3)"></div> Vacances Zone C</div>
      </div>
    </body></html>`;
}

// --- VUE 2 : GRILLE TYPE EXCEL ---
function generateGridHTML(events, holidays) {
  if (events.length === 0) return "<h1>Aucun événement à afficher</h1>";
  const todayMs = Date.now();
  const todayStr = new Date().toISOString().substring(0,10);

  let minTime = Infinity, maxTime = -Infinity;
  events.forEach(e => {
    ['dateDebut', 'dateFin', 'debutCom', 'finCom', 'debutInscriptions', 'finInscriptions', 'echeanceCSE'].forEach(c => {
      if (e[c]) { const t = new Date(e[c].substring(0, 10)).getTime(); minTime = Math.min(minTime, t); maxTime = Math.max(maxTime, t); }
    });
  });
  
  const minDate = new Date(minTime); minDate.setDate(1);
  const maxDate = new Date(maxTime); maxDate.setMonth(maxDate.getMonth() + 1, 0);

  const days = [], monthsMap = new Map();
  const MOIS_NOMS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const JOURS_NOMS = ["D", "L", "M", "M", "J", "V", "S"];

  let cur = new Date(minDate);
  while (cur <= maxDate) {
    const t = cur.getTime();
    const dStr = cur.toISOString().substring(0, 10);
    const mStr = dStr.substring(0, 7);
    days.push({ 
      str: dStr, num: cur.getDate(), weekDay: JOURS_NOMS[cur.getDay()], 
      isWeekend: cur.getDay() === 0 || cur.getDay() === 6, 
      isHoliday: isHoliday(t, holidays), mStr, isFirstOfMonth: cur.getDate() === 1,
      isToday: dStr === todayStr
    });
    if (!monthsMap.has(mStr)) monthsMap.set(mStr, { name: `${MOIS_NOMS[cur.getMonth()]} ${cur.getFullYear()}`, count: 0 });
    monthsMap.get(mStr).count++;
    cur.setDate(cur.getDate() + 1);
  }

  let htmlMois = `<th class="corner sticky-left sticky-top">Événements</th>`;
  let htmlJours = `<th class="corner-sub sticky-left sticky-top2">Filtres et Noms</th>`;
  monthsMap.forEach((data, mKey) => {
    htmlMois += `<th colspan="${data.count}" class="th-mois sticky-top" id="th-${mKey}" data-m="${mKey}"><button class="btn-col" onclick="toggleMois('${mKey}')">[-]</button> ${data.name}</th>`;
    htmlJours += `<th class="th-collapsed-indicator sticky-top2" data-m="${mKey}" style="display:none;">+</th>`;
  });

  days.forEach(d => {
    let classes = `th-jour sticky-top2`;
    if (d.isWeekend) classes += ` wknd`;
    if (d.isHoliday) classes += ` hol`;
    if (d.isToday) classes += ` today`;
    if (d.isFirstOfMonth) classes += ` first-day`;
    htmlJours += `<th class="${classes}" data-m="${d.mStr}"><div class="dow">${d.weekDay}</div><div class="dom">${d.num}</div></th>`;
  });

  let htmlLignes = "", htmlFiltres = "";
  events.forEach(e => {
    const evEndTime = new Date(e.dateFin || e.dateDebut).getTime();
    const isPast = (evEndTime + 86400000) < todayMs;
    const s = STATUS_MAP[e.statut] || DEFAULT_STATUS;
    
    htmlFiltres += `<label><input type="checkbox" ${isPast ? "" : "checked"} onchange="toggleEv('tr-${e.id}', this)"> ${s.icon} ${e.nom}</label>`;
    htmlLignes += `<tr id="tr-${e.id}" style="${isPast ? 'display:none;' : ''}">`;
    htmlLignes += `<td class="td-nom sticky-left"><span class="icon">${s.icon}</span> ${e.nom}</td>`;
    
    monthsMap.forEach((_, mKey) => htmlLignes += `<td class="td-collapsed-indicator" data-m="${mKey}" style="display:none;"></td>`);

    const dEv = { evD: e.dateDebut?.substring(0,10), evF: (e.dateFin||e.dateDebut)?.substring(0,10), coD: e.debutCom?.substring(0,10), coF: (e.finCom||e.debutCom)?.substring(0,10), inD: e.debutInscriptions?.substring(0,10), inF: (e.finInscriptions||e.debutInscriptions)?.substring(0,10), cse: e.echeanceCSE?.substring(0,10) };

    days.forEach(d => {
      let content = '';
      if (dEv.coD && d.str >= dEv.coD && d.str <= dEv.coF) content += `<div class="b-com"></div>`;
      if (dEv.inD && d.str >= dEv.inD && d.str <= dEv.inF) content += `<div class="b-ins"></div>`;
      if (dEv.evD && d.str >= dEv.evD && d.str <= dEv.evF) content += `<div class="b-ev"></div>`;
      if (dEv.cse === d.str) content += `<div class="m-cse">${(e.statut === "1" || e.statut === "2" || e.statut === "3") ? "✅" : "🔴"}</div>`;

      let classes = `td-jour`;
      if (d.isWeekend) classes += ` wknd`;
      if (d.isHoliday) classes += ` hol`;
      if (d.isToday) classes += ` today`;
      if (d.isFirstOfMonth) classes += ` first-day`;
      htmlLignes += `<td class="${classes}" data-m="${d.mStr}">${content}</td>`;
    });
    htmlLignes += `</tr>`;
  });

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Planning SLAT - Grille</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f5f7fa; margin: 2rem; color: #333; height: 90vh; display: flex; flex-direction: column; }
      .nav-tabs { margin-bottom: 20px; }
      .nav-tabs a { padding: 8px 15px; background: #dae5f1; text-decoration: none; border-radius: 4px; color: #333; margin-right: 10px; font-weight: bold; border: 1px solid #5a7b9c; }
      .nav-tabs a.active { background: #5a7b9c; color: white; }
      .controls { background: white; padding: 10px; border-radius: 8px; margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.85rem; border: 1px solid #e1e8ed; align-items: center; }
      .controls label { cursor: pointer; padding: 4px 8px; background: #eef2f5; border-radius: 4px; }
      .legend { margin-left: auto; display: flex; gap: 15px; }
      .leg-item { display: flex; align-items: center; gap: 4px; font-weight: bold; }
      .box { width: 12px; height: 12px; border-radius: 2px; }
      
      .table-wrap { flex: 1; overflow: auto; background: white; border: 1px solid #ccc; }
      table { border-collapse: collapse; width: max-content; }
      th, td { border: 1px solid #e1e8ed; text-align: center; padding: 0; }
      
      .sticky-top { position: sticky; top: 0; z-index: 10; background: #9bb7d4; color: white; border-bottom: 2px solid #5a7b9c; height: 35px; }
      .sticky-top2 { position: sticky; top: 35px; z-index: 10; background: #dae5f1; font-size: 0.75rem; height: 35px; }
      .sticky-left { position: sticky; left: 0; z-index: 15; background: white; border-right: 2px solid #5a7b9c; text-align: left; }
      .corner { z-index: 20; background: #7a9cb9; border-bottom: none; } .corner-sub { z-index: 20; background: #dae5f1; }
      
      .th-mois { font-weight: bold; padding: 0 10px; border-left: 2px solid #2c3e50; }
      .btn-col { background: none; border: none; color: white; cursor: pointer; font-weight: bold; padding: 0 5px; }
      .th-jour { width: 22px; min-width: 22px; }
      .th-jour .dow { font-size: 0.65rem; color: #555; }
      .first-day { border-left: 2px solid #2c3e50; }
      
      /* L'ordre est important ici, le td-jour hol colore bien la case complète */
      .wknd { background-color: rgba(0,0,0,0.03) !important; }
      td.td-jour.hol, th.th-jour.hol { background-color: rgba(46,204,113,0.15) !important; }
      .today { border-left: 2px solid red !important; border-right: 2px solid red !important; background-color: rgba(231,76,60,0.1) !important; }
      
      .td-nom { padding: 5px 10px; width: 220px; font-size: 0.85rem; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .td-jour { vertical-align: top; padding-top: 2px; height: 30px; position: relative; }
      .b-com { height: 6px; background-color: #9b59b6; margin-bottom: 1px; width: 100%; }
      .b-ins { height: 6px; background-color: #3498db; margin-bottom: 1px; width: 100%; }
      .b-ev { height: 10px; background-color: #2ecc71; margin-bottom: 1px; width: 100%; }
      .m-cse { font-size: 0.7rem; position: absolute; left: 50%; transform: translateX(-50%); top: 4px; z-index: 5; }
      
      .th-collapsed-indicator, .td-collapsed-indicator { width: 20px; background: #ecf0f1; border-left: 2px solid #2c3e50; cursor: pointer; color: #888; }
    </style>
    <script>
      function toggleEv(id, cb) { document.getElementById(id).style.display = cb.checked ? '' : 'none'; }
      function toggleMois(mKey) {
        const isC = document.getElementById('th-'+mKey).dataset.c === '1';
        document.querySelectorAll('[data-m="'+mKey+'"]').forEach(el => {
          if(el.classList.contains('th-mois')) { el.colSpan = isC ? el.dataset.fs : 1; el.dataset.c = isC ? '0' : '1'; el.querySelector('.btn-col').textContent = isC ? '[-]' : '[+]'; if(!el.dataset.fs) el.dataset.fs = el.colSpan; }
          else { el.style.display = (el.classList.contains('th-collapsed-indicator') || el.classList.contains('td-collapsed-indicator')) ? (isC ? 'none' : '') : (isC ? '' : 'none'); }
        });
      }
    </script>
    </head><body>
      <h1>Planning SLAT</h1>
      <div class="nav-tabs"><a href="/">Vue Gantt</a> <a href="/grille" class="active">Vue Grille (Excel)</a></div>
      <div class="controls">
        <strong>Filtres:</strong> ${htmlFiltres}
        <div class="legend">
          <div class="leg-item"><div class="box" style="background:#9b59b6"></div> Com</div>
          <div class="leg-item"><div class="box" style="background:#3498db"></div> Inscriptions</div>
          <div class="leg-item"><div class="box" style="background:#2ecc71"></div> Événement</div>
          <div class="leg-item"><div class="box" style="background:rgba(46,204,113,0.3)"></div> Vacances Zone C</div>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr>${htmlMois}</tr><tr>${htmlJours}</tr></thead><tbody>${htmlLignes}</tbody></table></div>
    </body></html>`;
}

// ICS standard
function generateICS(events) {
  let ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SLAT//Calendrier//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Événements SLAT"];
  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  events.forEach(e => {
    if (!e.dateDebut) return;
    ics.push("BEGIN:VEVENT", `UID:slat-ev-${e.id}@slat.info`, `DTSTAMP:${nowStamp}`);
    const start = e.dateDebut.substring(0, 10).replace(/-/g, ""); ics.push(`DTSTART;VALUE=DATE:${start}`);
    if (e.dateFin) { const dE = new Date(e.dateFin.substring(0, 10)); dE.setDate(dE.getDate() + 1); ics.push(`DTEND;VALUE=DATE:${dE.toISOString().substring(0, 10).replace(/-/g, "")}`); } else { ics.push(`DTEND;VALUE=DATE:${start}`); }
    ics.push(`SUMMARY:${e.nom}`, `DESCRIPTION:Statut : ${(STATUS_MAP[e.statut] || DEFAULT_STATUS).label}`, "END:VEVENT");
    if (e.echeanceCSE) {
      ics.push("BEGIN:VEVENT", `UID:slat-cse-${e.id}@slat.info`, `DTSTAMP:${nowStamp}`);
      const due = e.echeanceCSE.substring(0, 10).replace(/-/g, ""); ics.push(`DTSTART;VALUE=DATE:${due}`);
      const dDueE = new Date(e.echeanceCSE.substring(0, 10)); dDueE.setDate(dDueE.getDate() + 1); ics.push(`DTEND;VALUE=DATE:${dDueE.toISOString().substring(0, 10).replace(/-/g, "")}`);
      ics.push(`SUMMARY:${(e.statut === "1" || e.statut === "2" || e.statut === "3") ? "✅" : "🔴"} Échéance Com : ${e.nom}`, `DESCRIPTION:Com CSE`, "END:VEVENT");
    }
  });
  ics.push("END:VCALENDAR");
  return ics.map(l => { if (l.length <= 75) return l; let f = ""; for (let i = 0; i < l.length; i += 74) { f += l.substring(i, i + 74); if (i + 74 < l.length) f += "\r\n "; } return f; }).join("\r\n");
}

// --- SERVEUR EXPRESS ---
const app = express();

app.get("/", async (req, res) => {
  try { res.send(generateFloatingGantt(await fetchEvents(), getHolidays())); }
  catch (err) { res.status(500).send(`Erreur : ${err.message}`); }
});

app.get("/grille", async (req, res) => {
  try { res.send(generateGridHTML(await fetchEvents(), getHolidays())); }
  catch (err) { res.status(500).send(`Erreur : ${err.message}`); }
});

app.get("/ics", async (req, res) => {
  try {
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="slat.ics"' });
    res.send(generateICS(await fetchEvents()));
  } catch (err) { res.status(500).send(`Erreur : ${err.message}`); }
});

app.get("/healthz", (_, res) => res.send("ok"));
app.listen(parseInt(PORT, 10), () => console.log(`Serveur démarré (Port ${PORT})`));
