// Passerelle Nextcloud Tables -> Flux ICS + Vue Gantt (Type Excel)
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

async function fetchJSON(path) {
  const fullUrl = `${baseUrl}${path}`;
  try {
    const cmd = `curl -s -H "OCS-APIRequest: true" -H "Accept: application/json" -H "Authorization: ${AUTH_HEADER}" "${fullUrl}"`;
    const stdout = execSync(cmd, { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Erreur CURL API: ${err.message}`);
  }
}

const COL = { NOM: 5, DATE_DEBUT: 8, DATE_FIN: 9, STATUS: 17, ECHEANCE_CSE: 16, DEBUT_COM: 36, FIN_COM: 37, DEBUT_INSCRIPTIONS: 33, FIN_INSCRIPTIONS: 34, SAISON: 21 };

// Smileys et couleurs par statut
const STATUS_MAP = {
  "0": { label: "À préparer", icon: "🟡", color: "#f1c40f" },
  "1": { label: "Infos envoyées", icon: "🔵", color: "#3498db" },
  "2": { label: "Publié", icon: "🟣", color: "#9b59b6" },
  "3": { label: "Réalisé", icon: "🟢", color: "#2ecc71" }
};
const DEFAULT_STATUS = { label: "Non défini", icon: "⚪", color: "#ccc" };

let cache = { data: null, fetchedAt: 0 };
const TTL_MS = parseInt(CACHE_TTL_SECONDS, 10) * 1000;

function cellValue(row, colId) {
  const cell = row.data?.find(c => c.columnId === colId);
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") return v.map(u => u.displayName || u.id).join(", ");
  return String(v);
}

async function fetchEvents() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < TTL_MS) return cache.data;
  const rows = await fetchJSON(`/index.php/apps/tables/api/1/tables/${TABLE_ID}/rows`);
  const events = rows
    .map(row => ({
      id: row.id,
      nom: cellValue(row, COL.NOM) || `Événement #${row.id}`,
      dateDebut: cellValue(row, COL.DATE_DEBUT),
      dateFin: cellValue(row, COL.DATE_FIN),
      statut: cellValue(row, COL.STATUS),
      echeanceCSE: cellValue(row, COL.ECHEANCE_CSE),
      debutCom: cellValue(row, COL.DEBUT_COM),
      finCom: cellValue(row, COL.FIN_COM),
      debutInscriptions: cellValue(row, COL.DEBUT_INSCRIPTIONS),
      finInscriptions: cellValue(row, COL.FIN_INSCRIPTIONS)
    }))
    .filter(e => e.dateDebut);
  cache = { data: events, fetchedAt: now };
  return events;
}

// ICS Generator (inchangé)
function generateICS(events) {
  let ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SLAT//Calendrier//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Événements SLAT"];
  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  events.forEach(e => {
    if (!e.dateDebut) return;
    const statut = STATUS_MAP[e.statut] || DEFAULT_STATUS;
    ics.push("BEGIN:VEVENT", `UID:slat-ev-${e.id}@slat.info`, `DTSTAMP:${nowStamp}`);
    const start = e.dateDebut.substring(0, 10).replace(/-/g, "");
    ics.push(`DTSTART;VALUE=DATE:${start}`);
    if (e.dateFin) {
      const dEnd = new Date(e.dateFin.substring(0, 10)); dEnd.setDate(dEnd.getDate() + 1);
      ics.push(`DTEND;VALUE=DATE:${dEnd.toISOString().substring(0, 10).replace(/-/g, "")}`);
    } else {
      ics.push(`DTEND;VALUE=DATE:${start}`);
    }
    ics.push(`SUMMARY:${e.nom}`);
    let desc = `Statut : ${statut.label}\\n`;
    if (e.debutInscriptions) desc += `Inscriptions : Du ${e.debutInscriptions.substring(0, 10)} au ${e.finInscriptions?.substring(0, 10)}\\n`;
    if (e.debutCom) desc += `Com : Du ${e.debutCom.substring(0, 10)} au ${e.finCom?.substring(0, 10)}\\n`;
    ics.push(`DESCRIPTION:${desc}`, "END:VEVENT");

    if (e.echeanceCSE) {
      ics.push("BEGIN:VEVENT", `UID:slat-cse-${e.id}@slat.info`, `DTSTAMP:${nowStamp}`);
      const due = e.echeanceCSE.substring(0, 10).replace(/-/g, "");
      ics.push(`DTSTART;VALUE=DATE:${due}`);
      const dDueEnd = new Date(e.echeanceCSE.substring(0, 10)); dDueEnd.setDate(dDueEnd.getDate() + 1);
      ics.push(`DTEND;VALUE=DATE:${dDueEnd.toISOString().substring(0, 10).replace(/-/g, "")}`);
      const isDone = (e.statut === "1" || e.statut === "2" || e.statut === "3");
      ics.push(`SUMMARY:${isDone ? "✅" : "🔴"} Échéance Com : ${e.nom}`, `DESCRIPTION:Com CSE`, "END:VEVENT");
    }
  });
  ics.push("END:VCALENDAR");
  return ics.map(l => {
    if (l.length <= 75) return l; let f = "";
    for (let i = 0; i < l.length; i += 74) { f += l.substring(i, i + 74); if (i + 74 < l.length) f += "\r\n "; }
    return f;
  }).join("\r\n");
}

// NOUVEAU Générateur HTML (Gantt Grille type Excel)
function generateGanttHTML(events) {
  if (events.length === 0) return "<h1>Aucun événement à afficher</h1>";

  // 1. Calculer la période totale
  let minTime = Infinity, maxTime = -Infinity;
  events.forEach(e => {
    ['dateDebut', 'dateFin', 'debutCom', 'finCom', 'debutInscriptions', 'finInscriptions', 'echeanceCSE'].forEach(c => {
      if (e[c]) { const t = new Date(e[c].substring(0, 10)).getTime(); minTime = Math.min(minTime, t); maxTime = Math.max(maxTime, t); }
    });
  });
  
  // Arrondir au 1er du mois de début, et au dernier jour du mois de fin
  const minDate = new Date(minTime); minDate.setDate(1);
  const maxDate = new Date(maxTime); maxDate.setMonth(maxDate.getMonth() + 1, 0);

  // 2. Construire le calendrier (Jours & Mois)
  const days = [];
  const monthsMap = new Map(); // Regrouper par mois
  const MOIS_NOMS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const JOURS_NOMS = ["D", "L", "M", "M", "J", "V", "S"];

  let cur = new Date(minDate);
  while (cur <= maxDate) {
    const dStr = cur.toISOString().substring(0, 10);
    const mStr = dStr.substring(0, 7); // ex: 2026-11
    const isWeekend = cur.getDay() === 0 || cur.getDay() === 6;
    const isFirstOfMonth = cur.getDate() === 1;

    days.push({ str: dStr, num: cur.getDate(), weekDay: JOURS_NOMS[cur.getDay()], isWeekend, mStr, isFirstOfMonth });
    if (!monthsMap.has(mStr)) monthsMap.set(mStr, { name: `${MOIS_NOMS[cur.getMonth()]} ${cur.getFullYear()}`, count: 0 });
    monthsMap.get(mStr).count++;
    cur.setDate(cur.getDate() + 1);
  }

  // 3. Trier les événements par date de début
  events.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));

  // 4. Générer les En-têtes (Mois puis Jours)
  let htmlMois = `<th class="corner sticky-left sticky-top">Événements</th>`;
  let htmlJours = `<th class="corner-sub sticky-left sticky-top2">Filtres et Noms</th>`;
  
  monthsMap.forEach((data, mKey) => {
    htmlMois += `<th colspan="${data.count}" class="th-mois sticky-top" id="th-${mKey}" data-m="${mKey}">
      <button class="btn-col" onclick="toggleMois('${mKey}')">[-]</button> ${data.name}
    </th>`;
    htmlJours += `<th class="th-collapsed-indicator sticky-top2" data-m="${mKey}" style="display:none;" title="${data.name}">+</th>`;
  });

  days.forEach(d => {
    let classes = `th-jour sticky-top2`;
    if (d.isWeekend) classes += ` wknd`;
    if (d.isFirstOfMonth) classes += ` first-day`;
    htmlJours += `<th class="${classes}" data-m="${d.mStr}">
      <div class="dow">${d.weekDay}</div>
      <div class="dom">${d.num}</div>
    </th>`;
  });

  // 5. Générer les Lignes et les Filtres
  let htmlLignes = "";
  let htmlFiltres = "";

  events.forEach(e => {
    const s = STATUS_MAP[e.statut] || DEFAULT_STATUS;
    
    // Panneau de filtre
    htmlFiltres += `<label><input type="checkbox" checked onchange="toggleEv(${e.id}, this)"> ${s.icon} ${e.nom}</label>`;

    // Ligne du tableau
    htmlLignes += `<tr id="tr-${e.id}">`;
    htmlLignes += `<td class="td-nom sticky-left" title="Statut: ${s.label}">
      <span class="icon">${s.icon}</span> <span class="ev-nom">${e.nom}</span>
    </td>`;

    // Cellules jours pour chaque événement
    const datesEv = {
      evD: e.dateDebut ? e.dateDebut.substring(0, 10) : null,
      evF: e.dateFin ? e.dateFin.substring(0, 10) : (e.dateDebut ? e.dateDebut.substring(0, 10) : null),
      coD: e.debutCom ? e.debutCom.substring(0, 10) : null,
      coF: e.finCom ? e.finCom.substring(0, 10) : (e.debutCom ? e.debutCom.substring(0, 10) : null),
      inD: e.debutInscriptions ? e.debutInscriptions.substring(0, 10) : null,
      inF: e.finInscriptions ? e.finInscriptions.substring(0, 10) : (e.debutInscriptions ? e.debutInscriptions.substring(0, 10) : null),
      cse: e.echeanceCSE ? e.echeanceCSE.substring(0, 10) : null
    };

    monthsMap.forEach((_, mKey) => {
      htmlLignes += `<td class="td-collapsed-indicator" data-m="${mKey}" style="display:none;"></td>`;
    });

    days.forEach(d => {
      let content = '';
      if (datesEv.coD && d.str >= datesEv.coD && d.str <= datesEv.coF) content += `<div class="b-com" title="Com"></div>`;
      if (datesEv.inD && d.str >= datesEv.inD && d.str <= datesEv.inF) content += `<div class="b-ins" title="Inscriptions"></div>`;
      if (datesEv.evD && d.str >= datesEv.evD && d.str <= datesEv.evF) content += `<div class="b-ev" title="Événement"></div>`;
      if (datesEv.cse === d.str) content += `<div class="m-cse" title="Échéance CSE">🔴</div>`;

      let classes = `td-jour`;
      if (d.isWeekend) classes += ` wknd`;
      if (d.isFirstOfMonth) classes += ` first-day`;

      htmlLignes += `<td class="${classes}" data-m="${d.mStr}">${content}</td>`;
    });
    htmlLignes += `</tr>`;
  });

  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Planning SLAT</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #f5f7fa; margin: 0; padding: 20px; color: #333; height: 100vh; display: flex; flex-direction: column; box-sizing: border-box; }
        h1 { margin: 0 0 10px 0; font-size: 1.5rem; }
        
        /* Panneau de filtres */
        .controls { background: white; padding: 10px; border-radius: 8px; margin-bottom: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.85rem; align-items: center; }
        .controls label { cursor: pointer; padding: 4px 8px; background: #eef2f5; border-radius: 4px; border: 1px solid #dcdcdc; }
        .controls label:hover { background: #e2e8ed; }
        .legend { margin-left: auto; display: flex; gap: 15px; }
        .leg-item { display: flex; align-items: center; gap: 4px; font-weight: bold; }
        .b-leg { width: 12px; height: 12px; border-radius: 2px; }

        /* Conteneur scrollable */
        .table-wrap { flex: 1; overflow: auto; background: white; border: 1px solid #ccc; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        
        table { border-collapse: collapse; width: max-content; }
        th, td { border: 1px solid #e1e8ed; text-align: center; padding: 0; }
        
        /* Fixation des entêtes (Sticky) */
        .sticky-top { position: sticky; top: 0; z-index: 10; background: #9bb7d4; color: white; border-bottom: 2px solid #5a7b9c; height: 35px; } /* Bleu type Excel */
        .sticky-top2 { position: sticky; top: 35px; z-index: 10; background: #dae5f1; font-size: 0.75rem; height: 35px; }
        .sticky-left { position: sticky; left: 0; z-index: 15; background: white; border-right: 2px solid #5a7b9c; text-align: left; }
        
        .corner { z-index: 20; background: #7a9cb9; border-bottom: none; }
        .corner-sub { z-index: 20; background: #dae5f1; }

        /* Mois et boutons */
        .th-mois { font-weight: bold; padding: 0 10px; border-left: 2px solid #2c3e50; }
        .btn-col { background: none; border: none; color: white; cursor: pointer; font-weight: bold; font-size: 0.9rem; padding: 0 5px; }
        .btn-col:hover { color: #ffeaa7; }

        /* Jours */
        .th-jour { width: 22px; min-width: 22px; }
        .th-jour .dow { font-size: 0.65rem; color: #555; }
        .th-jour .dom { font-weight: bold; }
        .first-day { border-left: 2px solid #2c3e50; }
        .wknd { background-color: #f1f1f1 !important; }

        /* Cellules d'événements */
        .td-nom { padding: 5px 10px; width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.85rem; font-weight: bold; }
        .icon { font-size: 1rem; margin-right: 5px; }
        .td-jour { vertical-align: top; padding-top: 2px; height: 30px; position: relative; }
        
        /* Barres de couleur */
        .b-com { height: 6px; background-color: #f39c12; margin-bottom: 1px; width: 100%; } /* Orange */
        .b-ins { height: 6px; background-color: #3498db; margin-bottom: 1px; width: 100%; } /* Bleu */
        .b-ev { height: 10px; background-color: #27ae60; margin-bottom: 1px; width: 100%; } /* Vert */
        .m-cse { font-size: 0.7rem; position: absolute; left: 50%; transform: translateX(-50%); top: 4px; z-index: 5; }

        /* Mode replié */
        .th-collapsed-indicator, .td-collapsed-indicator { width: 20px; background: #ecf0f1; border-left: 2px solid #2c3e50; cursor: pointer; font-weight: bold; color: #888; }
        .td-collapsed-indicator { background: #fdfdfd; }
      </style>
      <script>
        function toggleEv(id, cb) {
          document.getElementById('tr-' + id).style.display = cb.checked ? '' : 'none';
        }
        
        function toggleMois(mKey) {
          const isCollapsed = document.getElementById('th-' + mKey).dataset.collapsed === 'true';
          const els = document.querySelectorAll('[data-m="' + mKey + '"]');
          
          els.forEach(el => {
            if (el.classList.contains('th-mois')) {
              if (isCollapsed) {
                el.colSpan = el.dataset.fullspan;
                el.dataset.collapsed = 'false';
                el.querySelector('.btn-col').textContent = '[-]';
              } else {
                if (!el.dataset.fullspan) el.dataset.fullspan = el.colSpan;
                el.colSpan = 1;
                el.dataset.collapsed = 'true';
                el.querySelector('.btn-col').textContent = '[+]';
              }
            } else if (el.classList.contains('th-collapsed-indicator') || el.classList.contains('td-collapsed-indicator')) {
              el.style.display = isCollapsed ? 'none' : '';
            } else {
              el.style.display = isCollapsed ? '' : 'none';
            }
          });
        }
      </script>
    </head>
    <body>
      <h1>Planning des Événements SLAT</h1>
      <div class="controls">
        <strong>Filtres :</strong>
        ${htmlFiltres}
        <div class="legend">
          <div class="leg-item"><div class="b-leg" style="background:#f39c12;"></div> Com</div>
          <div class="leg-item"><div class="b-leg" style="background:#3498db;"></div> Inscriptions</div>
          <div class="leg-item"><div class="b-leg" style="background:#27ae60;"></div> Événement</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>${htmlMois}</tr>
            <tr>${htmlJours}</tr>
          </thead>
          <tbody>
            ${htmlLignes}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `;
}

const app = express();

app.get("/", async (req, res) => {
  try {
    const events = await fetchEvents();
    res.send(generateGanttHTML(events));
  } catch (err) {
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

app.get("/ics", async (req, res) => {
  try {
    const events = await fetchEvents();
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="slat.ics"' });
    res.send(generateICS(events));
  } catch (err) {
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

app.get("/healthz", (_, res) => res.send("ok"));

app.listen(parseInt(PORT, 10), () => console.log(`Serveur démarré (Port ${PORT})`) );
