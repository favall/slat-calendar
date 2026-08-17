// Passerelle Nextcloud Tables -> Flux ICS + Vue Gantt
import express from "express";
import { execSync } from "child_process";

// 1. Nettoyage des variables
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

// 2. Fetcher via CURL
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

// 3. IDs de colonnes
const COL = {
  NOM: 5,
  DATE_DEBUT: 8,
  DATE_FIN: 9,
  STATUS: 17,
  ECHEANCE_CSE: 16,
  DEBUT_COM: 36,
  FIN_COM: 37,
  DEBUT_INSCRIPTIONS: 33,
  FIN_INSCRIPTIONS: 34,
  SAISON: 21,
};

const STATUS_MAP = {
  "0": "A préparer",
  "1": "Infos envoyées",
  "2": "Publié",
  "3": "Réalisé"
};

let cache = { data: null, fetchedAt: 0 };
const TTL_MS = parseInt(CACHE_TTL_SECONDS, 10) * 1000;

function cellValue(row, colId) {
  const cell = row.data?.find(c => c.columnId === colId);
  if (!cell) return null;
  const v = cell.value;
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
    return v.map(u => u.displayName || u.id).join(", ");
  }
  return String(v);
}

// Récupération des données brutes
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
      finInscriptions: cellValue(row, COL.FIN_INSCRIPTIONS),
      saison: cellValue(row, COL.SAISON),
    }))
    .filter(e => e.dateDebut);

  cache = { data: events, fetchedAt: now };
  return events;
}

// 4. Générateur ICS (Agenda)
function generateICS(events) {
  let ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SLAT//Calendrier des Evenements//FR",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Événements SLAT"
  ];
  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  events.forEach(e => {
    if (!e.dateDebut) return;
    const statutLabel = STATUS_MAP[e.statut] || 'Non défini';
    
    // Événement
    ics.push("BEGIN:VEVENT");
    ics.push(`UID:slat-event-${e.id}@slat.info`);
    ics.push(`DTSTAMP:${nowStamp}`);
    const start = e.dateDebut.substring(0, 10).replace(/-/g, "");
    ics.push(`DTSTART;VALUE=DATE:${start}`);
    if (e.dateFin) {
      const dEnd = new Date(e.dateFin.substring(0, 10));
      dEnd.setDate(dEnd.getDate() + 1);
      ics.push(`DTEND;VALUE=DATE:${dEnd.toISOString().substring(0, 10).replace(/-/g, "")}`);
    } else {
      ics.push(`DTEND;VALUE=DATE:${start}`); 
    }
    ics.push(`SUMMARY:${e.nom}`);
    
    let desc = `Statut : ${statutLabel}\\n`;
    if (e.saison) desc += `Saison : ${e.saison}\\n`;
    if (e.debutInscriptions) desc += `Inscriptions : Du ${e.debutInscriptions.substring(0, 10)} au ${e.finInscriptions.substring(0, 10)}\\n`;
    if (e.debutCom) desc += `Communication : Du ${e.debutCom.substring(0, 10)} au ${e.finCom.substring(0, 10)}\\n`;
    ics.push(`DESCRIPTION:${desc}`);
    ics.push("END:VEVENT");

    // Échéance CSE
    if (e.echeanceCSE) {
      ics.push("BEGIN:VEVENT");
      ics.push(`UID:slat-task-cse-${e.id}@slat.info`);
      ics.push(`DTSTAMP:${nowStamp}`);
      const due = e.echeanceCSE.substring(0, 10).replace(/-/g, "");
      ics.push(`DTSTART;VALUE=DATE:${due}`);
      const dDueEnd = new Date(e.echeanceCSE.substring(0, 10));
      dDueEnd.setDate(dDueEnd.getDate() + 1);
      ics.push(`DTEND;VALUE=DATE:${dDueEnd.toISOString().substring(0, 10).replace(/-/g, "")}`);
      const isDone = (e.statut === "1" || e.statut === "2" || e.statut === "3");
      ics.push(`SUMMARY:${isDone ? "✅" : "🔴"} Échéance Com : ${e.nom}`);
      ics.push(`DESCRIPTION:Date limite pour envoyer les infos de communication au CSE.`);
      ics.push("END:VEVENT");
    }
  });
  ics.push("END:VCALENDAR");
  
  return ics.map(line => {
    if (line.length <= 75) return line;
    let folded = "";
    for (let i = 0; i < line.length; i += 74) {
      folded += line.substring(i, i + 74);
      if (i + 74 < line.length) folded += "\r\n ";
    }
    return folded;
  }).join("\r\n");
}

// 5. Générateur HTML (Vue Gantt)
function generateGanttHTML(events) {
  // 5.1 Trouver la période globale (min Date et max Date) pour dimensionner l'axe X
  let allDates = [];
  events.forEach(e => {
    ['dateDebut', 'dateFin', 'debutCom', 'finCom', 'debutInscriptions', 'finInscriptions', 'echeanceCSE'].forEach(champ => {
      if (e[champ]) allDates.push(new Date(e[champ].substring(0, 10)).getTime());
    });
  });

  if (allDates.length === 0) return "<h1>Aucun événement à afficher</h1>";

  // On rajoute 5 jours de marge avant et après pour que ça respire
  const minTime = Math.min(...allDates) - (5 * 24 * 60 * 60 * 1000);
  const maxTime = Math.max(...allDates) + (5 * 24 * 60 * 60 * 1000);
  const totalSpan = maxTime - minTime;

  // 5.2 Fonction pour calculer la position "left" en pourcentage
  const getPos = (dateStr) => {
    if (!dateStr) return null;
    const t = new Date(dateStr.substring(0, 10)).getTime();
    return ((t - minTime) / totalSpan) * 100;
  };

  // 5.3 Générer les lignes pour chaque événement
  const rowsHTML = events.sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut)).map(e => {
    let barres = '';

    // Période de Communication
    const pComDebut = getPos(e.debutCom);
    const pComFin = getPos(e.finCom);
    if (pComDebut !== null && pComFin !== null) {
      const w = Math.max(pComFin - pComDebut, 0.5); // Largeur min
      barres += `<div class="bar bar-com" style="left:${pComDebut}%; width:${w}%;" title="Com: ${e.debutCom.substring(0,10)} au ${e.finCom.substring(0,10)}">Com</div>`;
    }

    // Période d'Inscriptions
    const pInsDebut = getPos(e.debutInscriptions);
    const pInsFin = getPos(e.finInscriptions);
    if (pInsDebut !== null && pInsFin !== null) {
      const w = Math.max(pInsFin - pInsDebut, 0.5);
      barres += `<div class="bar bar-ins" style="left:${pInsDebut}%; width:${w}%;" title="Inscriptions: ${e.debutInscriptions.substring(0,10)} au ${e.finInscriptions.substring(0,10)}">Insc.</div>`;
    }

    // Période de l'Événement
    const pEvDebut = getPos(e.dateDebut);
    const pEvFin = getPos(e.dateFin || e.dateDebut); // Si pas de date de fin, on met la même
    if (pEvDebut !== null) {
      const w = Math.max(pEvFin - pEvDebut, 1);
      barres += `<div class="bar bar-ev" style="left:${pEvDebut}%; width:${w}%;" title="Événement: ${e.dateDebut.substring(0,10)}">${e.nom}</div>`;
    }

    // Échéance CSE (Point)
    const pCse = getPos(e.echeanceCSE);
    if (pCse !== null) {
      const isDone = (e.statut === "1" || e.statut === "2" || e.statut === "3");
      const marker = isDone ? "✅" : "🔴";
      barres += `<div class="marker-cse" style="left:${pCse}%;" title="Échéance CSE: ${e.echeanceCSE.substring(0,10)}">${marker}</div>`;
    }

    const statutLabel = STATUS_MAP[e.statut] || 'Non défini';

    return `
      <div class="gantt-row">
        <div class="row-label">
          <strong>${e.nom}</strong>
          <span class="badge">${statutLabel}</span>
        </div>
        <div class="row-track">${barres}</div>
      </div>
    `;
  }).join("");

  // 5.4 La page Web complète avec le CSS
  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Gantt SLAT</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #f4f7f6; color: #333; margin: 2rem; }
        h1 { margin-bottom: 5px; color: #1a2744; }
        p.subtitle { color: #666; margin-bottom: 2rem; font-size: 0.9rem; }
        
        .gantt-container {
          background: #fff;
          border-radius: 8px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.05);
          border: 1px solid #e1e8ed;
          overflow: hidden;
        }

        .gantt-row {
          display: flex;
          border-bottom: 1px solid #f0f0f0;
          min-height: 50px;
        }
        .gantt-row:last-child { border-bottom: none; }
        .gantt-row:nth-child(even) { background-color: #fafbfc; }

        .row-label {
          width: 250px;
          min-width: 250px;
          padding: 15px;
          background: #fff;
          border-right: 1px solid #e1e8ed;
          display: flex;
          flex-direction: column;
          justify-content: center;
          font-size: 0.9rem;
          z-index: 2;
        }
        .badge {
          font-size: 0.7rem;
          color: #888;
          margin-top: 4px;
        }

        .row-track {
          flex-grow: 1;
          position: relative;
          padding: 10px 0;
          overflow: hidden;
        }

        /* Les blocs du Gantt */
        .bar {
          position: absolute;
          height: 24px;
          top: 13px;
          border-radius: 4px;
          color: white;
          font-size: 0.75rem;
          font-weight: 600;
          display: flex;
          align-items: center;
          padding: 0 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: help;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          opacity: 0.9;
        }
        .bar:hover { opacity: 1; z-index: 10; }

        /* Couleurs pour bien distinguer */
        .bar-com { background-color: #9b59b6; top: 2px; height: 16px; font-size: 0.65rem; } /* Violet */
        .bar-ins { background-color: #3498db; top: 22px; height: 16px; font-size: 0.65rem;} /* Bleu */
        .bar-ev { background-color: #2ecc71; top: 42px; height: 20px;} /* Vert */
        
        .marker-cse {
          position: absolute;
          top: -2px;
          font-size: 1rem;
          transform: translateX(-50%);
          cursor: help;
          z-index: 5;
        }

        /* Légende */
        .legend {
          display: flex;
          gap: 15px;
          margin-top: 1.5rem;
          font-size: 0.85rem;
        }
        .leg-item { display: flex; align-items: center; gap: 5px; }
        .box { width: 15px; height: 15px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>Planning des Événements SLAT</h1>
      <p class="subtitle">Vue d'ensemble dynamique (Com, Inscriptions, Événements) générée depuis Nextcloud Tables.</p>
      
      <div class="gantt-container">
        ${rowsHTML}
      </div>

      <div class="legend">
        <div class="leg-item"><div class="box" style="background:#9b59b6"></div> Période de Communication</div>
        <div class="leg-item"><div class="box" style="background:#3498db"></div> Période d'Inscriptions</div>
        <div class="leg-item"><div class="box" style="background:#2ecc71"></div> Date de l'Événement</div>
        <div class="leg-item">🔴 / ✅ Échéance Com CSE</div>
      </div>
    </body>
    </html>
  `;
}

// 6. Serveur Web avec deux routes distinctes
const app = express();

// Route par défaut (Page web Gantt)
app.get("/", async (req, res) => {
  try {
    const events = await fetchEvents();
    res.send(generateGanttHTML(events));
  } catch (err) {
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

// Route spécifique pour l'Agenda Nextcloud (.ics)
app.get("/ics", async (req, res) => {
  try {
    const events = await fetchEvents();
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="slat-calendrier.ics"'
    });
    res.send(generateICS(events));
  } catch (err) {
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

app.get("/healthz", (_, res) => res.send("ok"));

app.listen(parseInt(PORT, 10), () =>
  console.log(`📡 Passerelle SLAT (Gantt & ICS) démarrée sur le port ${PORT}`)
);
