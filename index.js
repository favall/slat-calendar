// Calendrier annuel SLAT — généré depuis Nextcloud Tables
// Colonnes mappées sur la table "Événements SLAT" (id:2) :
//   5  → Nom de l'évenement
//   8  → Date début
//   9  → Date de fin
//   17 → Status (sélection : A préparer / Infos envoyées / Publié / Réalisé)
//   16 → Échéance com CSE
//   21 → Saison
//
// Variables d'environnement requises :
//   NEXTCLOUD_URL      ex: https://cloud.slat.info
//   NC_USER            ex: admin
//   NC_APP_PASSWORD    mot de passe d'application Nextcloud
//   TABLE_ID           2
//   CACHE_TTL_SECONDS  durée du cache en secondes (défaut: 120)
//   PORT               port d'écoute (défaut: 3000)

import express from "express";
import { execSync } from "child_process";

// 1. Nettoyage strict des variables
const baseUrl = (process.env.NEXTCLOUD_URL || "").replace(/['"]/g, '').trim().replace(/\/$/, '');
const user = (process.env.NC_USER || "").replace(/['"]/g, '').trim();
const pass = (process.env.NC_APP_PASSWORD || "").replace(/['"]/g, '').trim();

const TABLE_ID = (process.env.TABLE_ID || "2").replace(/['"]/g, '').trim();
const CACHE_TTL_SECONDS = (process.env.CACHE_TTL_SECONDS || "120").replace(/['"]/g, '').trim();
const PORT = (process.env.PORT || "3000").replace(/['"]/g, '').trim();

if (!baseUrl || !user || !pass) {
  console.error("Variables d'environnement manquantes : NEXTCLOUD_URL, NC_USER, NC_APP_PASSWORD");
  process.exit(1);
}

const AUTH_HEADER = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

// 2. Fonction fetch qui contourne Node.js en utilisant wget (natif sous Alpine Linux)
function fetchJSON(path) {
  const fullUrl = `${baseUrl}${path}`;
  console.log(`📡 Tentative via WGET sur : ${fullUrl}`); 
  
  try {
    // On mime exactement un comportement standard (curl/wget) avec falsification du domaine
    const cmd = `wget -qO- --header="OCS-APIRequest: true" --header="Accept: application/json" --header="Authorization: ${AUTH_HEADER}" --header="Host: cloud.slat.info" "${fullUrl}"`;
    
    // On exécute la commande de manière synchrone
    const stdout = execSync(cmd, { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Nextcloud a rejeté la requête WGET (Probablement 500). Erreur: ${err.message}`);
  }
}

// IDs de colonnes fixes (table Événements SLAT id:2)
const COL = {
  NOM: 5,
  DATE_DEBUT: 8,
  DATE_FIN: 9,
  STATUS: 17,
  ECHEANCE_CSE: 16,
  SAISON: 21,
};

// Couleurs par statut — labels tels que définis dans Tables
const STATUS_COLORS = {
  "a préparer":    { bg: "#f6b26b", text: "#7a4a00" },  // orange
  "infos envoyées": { bg: "#9fc5e8", text: "#1a3a5c" }, // bleu clair
  "publié":        { bg: "#6fa8dc", text: "#0a2744" },  // bleu
  "réalisé":       { bg: "#93c47d", text: "#1a4a00" },  // vert
  "default":       { bg: "#e0e0e0", text: "#444444" },  // gris
};

function colorForStatus(statut) {
  if (!statut) return STATUS_COLORS.default;
  const key = statut.trim().toLowerCase();
  return STATUS_COLORS[key] || STATUS_COLORS.default;
}

// --- Cache simple en mémoire -------------------------------------------
let cache = { data: null, fetchedAt: 0 };
const TTL_MS = parseInt(CACHE_TTL_SECONDS, 10) * 1000;

async function fetchJSON(path) {
  const fullUrl = `${baseUrl}${path}`;
  console.log(`📡 Tentative de connexion (via HTTP natif) à : ${fullUrl}`);

  return new Promise((resolve, reject) => {
    // On force Nextcloud à croire qu'on vient du web (contourne les Trusted Domains)
    const options = {
      headers: {
        "OCS-APIRequest": "true",
        "Accept": "application/json",
        "Authorization": AUTH_HEADER,
        "User-Agent": "curl/7.81.0",
        "Host": "cloud.slat.info",            // Bypass des Trusted Domains
        "X-Forwarded-Proto": "https"          // Évite que Nextcloud nous redirige (302)
      }
    };

    const client = fullUrl.startsWith("https") ? https : http;
    
    const req = client.get(fullUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON invalide: ${data}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} : ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Erreur réseau: ${err.message}`)));
  });
}
function cellValue(row, colId) {
  const cell = row.data?.find(c => c.columnId === colId);
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined || v === "") return null;
  // Colonne usergroup : retourne le displayName du premier item
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
    return v.map(u => u.displayName || u.id).join(", ");
  }
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
      saison: cellValue(row, COL.SAISON),
    }))
    .filter(e => e.dateDebut);

  cache = { data: events, fetchedAt: now };
  return events;
}

// --- Grille annuelle -----------------------------------------------------
const MOIS = [
  "Jan", "Fév", "Mar", "Avr", "Mai", "Juin",
  "Juil", "Août", "Sep", "Oct", "Nov", "Déc",
];
const MOIS_LONG = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

function daysInMonth(year, m) {
  return new Date(year, m + 1, 0).getDate();
}

function parseDate(str) {
  if (!str) return null;
  // Formats attendus : "YYYY-MM-DD" ou "YYYY-MM-DD HH:mm:ss"
  const d = new Date(str.substring(0, 10));
  return isNaN(d.getTime()) ? null : d;
}

// Retourne toutes les dates couvertes par un événement (début → fin inclus)
function eventDates(ev, year) {
  const start = parseDate(ev.dateDebut);
  if (!start) return [];
  const end = parseDate(ev.dateFin) || start;
  const dates = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (cur.getFullYear() === year) {
      dates.push({ month: cur.getMonth(), day: cur.getDate() });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function buildGrid(year, events) {
  // grid[month][day] = [event, ...]
  const grid = Array.from({ length: 12 }, () => ({}));
  for (const ev of events) {
    for (const { month, day } of eventDates(ev, year)) {
      if (!grid[month][day]) grid[month][day] = [];
      grid[month][day].push(ev);
    }
  }
  return grid;
}

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage(year, grid, events) {
  // Légende
  const legend = Object.entries(STATUS_COLORS)
    .filter(([k]) => k !== "default")
    .map(([label, { bg }]) =>
      `<span class="leg"><span class="sw" style="background:${bg}"></span>${esc(label)}</span>`
    ).join("");

  // En-tête : ligne des mois
  const headerCells = MOIS.map((m, i) =>
    `<th title="${MOIS_LONG[i]}">${m}</th>`
  ).join("");

  // Corps : une ligne par jour
  let rows = "";
  for (let day = 1; day <= 31; day++) {
    let cells = `<td class="dn">${day}</td>`;
    for (let m = 0; m < 12; m++) {
      const dim = daysInMonth(year, m);
      if (day > dim) {
        cells += `<td class="na"></td>`;
        continue;
      }
      const evs = grid[m][day];
      if (evs?.length) {
        const { bg, text } = colorForStatus(evs[0].statut);
        const isMulti = evs[0].dateDebut !== evs[0].dateFin && evs[0].dateFin;
        const tip = evs.map(e =>
          `${e.nom} [${e.statut || "?"}]${isMulti ? " (multi-jours)" : ""}`
        ).join(" / ");
        cells += `<td class="ev" style="background:${bg};color:${text}" title="${esc(tip)}">`;
        if (evs.length > 1) cells += `<span class="badge">${evs.length}</span>`;
        cells += `</td>`;
      } else {
        cells += `<td></td>`;
      }
    }
    rows += `<tr>${cells}</tr>`;
  }

  // Section liste des événements de l'année
  const yearEvents = events
    .filter(e => {
      const d = parseDate(e.dateDebut);
      return d && d.getFullYear() === year;
    })
    .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));

  const listRows = yearEvents.map(e => {
    const { bg } = colorForStatus(e.statut);
    const fin = e.dateFin && e.dateFin !== e.dateDebut ? ` → ${e.dateFin.substring(0, 10)}` : "";
    return `<tr>
      <td><span class="sw" style="background:${bg}"></span></td>
      <td>${esc(e.nom)}</td>
      <td>${esc(e.dateDebut?.substring(0, 10))}${esc(fin)}</td>
      <td>${esc(e.statut || "—")}</td>
      <td>${esc(e.echeanceCSE?.substring(0, 10) || "—")}</td>
      <td>${esc(e.saison || "—")}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calendrier SLAT ${year}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:1.5rem;background:#f5f7fa;color:#1a2744}
  h1{font-size:1.4rem;margin-bottom:.3rem}
  .nav{margin-bottom:1rem}
  .nav a{margin-right:1rem;text-decoration:none;color:#4a7fb5;font-weight:600;font-size:.95rem}
  /* Grille */
  .wrap{overflow-x:auto}
  table.grid{border-collapse:collapse;min-width:600px;width:100%;table-layout:fixed}
  table.grid th,table.grid td{border:1px solid #dde3ec;text-align:center;padding:0;height:20px;font-size:.75rem}
  table.grid th{background:#1a2744;color:#fff;padding:5px 2px;font-size:.8rem}
  .dn{width:32px;background:#eef1f7;font-weight:600;font-size:.75rem}
  .na{background:#f0f0f0}
  .ev{cursor:help;position:relative}
  .badge{position:absolute;top:1px;right:2px;font-size:.6rem;font-weight:700;background:rgba(0,0,0,.25);color:#fff;border-radius:3px;padding:0 2px;line-height:1.2}
  /* Légende */
  .legend{margin:1rem 0;display:flex;gap:1rem;flex-wrap:wrap;font-size:.85rem}
  .leg{display:flex;align-items:center;gap:5px}
  .sw{width:13px;height:13px;border-radius:3px;display:inline-block;flex-shrink:0}
  /* Liste */
  h2{font-size:1.1rem;margin-top:2rem}
  table.list{border-collapse:collapse;width:100%;font-size:.85rem}
  table.list th{background:#1a2744;color:#fff;padding:6px 8px;text-align:left}
  table.list td{border-bottom:1px solid #dde3ec;padding:5px 8px;vertical-align:middle}
  table.list tr:hover td{background:#eef3fb}
  footer{margin-top:1.5rem;font-size:.75rem;color:#888}
</style>
</head>
<body>
<h1>📅 Calendrier des événements SLAT — ${year}</h1>
<div class="nav">
  <a href="/?year=${year-1}">← ${year-1}</a>
  <a href="/?year=${year+1}">${year+1} →</a>
</div>
<div class="wrap">
<table class="grid">
  <thead><tr><th>J</th>${headerCells}</tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>
<div class="legend">${legend}</div>

<h2>Liste des événements ${year}</h2>
<div class="wrap">
<table class="list">
  <thead><tr><th></th><th>Événement</th><th>Dates</th><th>Statut</th><th>Échéance CSE</th><th>Saison</th></tr></thead>
  <tbody>${listRows || '<tr><td colspan="6" style="text-align:center;padding:1rem;color:#888">Aucun événement pour cette année</td></tr>'}</tbody>
</table>
</div>
<footer>Données Nextcloud Tables · cache ${CACHE_TTL_SECONDS}s · Survolez une case pour le détail</footer>
</body>
</html>`;
}

// --- Serveur -------------------------------------------------------------
const app = express();

app.get("/", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const events = await fetchEvents();
    const grid = buildGrid(year, events);
    res.send(renderPage(year, grid, events));
  } catch (err) {
    console.error(err);
    res.status(500).send(`<pre style="color:red">Erreur : ${esc(err.message)}</pre>`);
  }
});

app.get("/healthz", (_, res) => res.send("ok"));

app.listen(parseInt(PORT, 10), () =>
  console.log(`Calendrier SLAT démarré sur le port ${PORT}`)
);
