// Passerelle Nextcloud Tables -> Flux ICS (iCalendar)
// Variables d'environnement requises :
//   NEXTCLOUD_URL      ex: http://nextcloud-app-fk8gwk4sskw044kg4wkcckc0:80
//   NC_USER            ex: admin
//   NC_APP_PASSWORD    mot de passe d'application Nextcloud
//   TABLE_ID           2
//   CACHE_TTL_SECONDS  durée du cache en secondes (défaut: 120)
//   PORT               port d'écoute (défaut: 3000)

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

// 2. Fetcher via CURL (Infaillible)
async function fetchJSON(path) {
  const fullUrl = `${baseUrl}${path}`;
  console.log(`📡 Génération du calendrier sollicitée. Connexion à Tables...`); 
  
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

// 4. Générateur ICS (iCalendar)
function generateICS(events) {
  let ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SLAT//Calendrier des Evenements//FR",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Événements SLAT" // Nom de l'agenda
  ];

  // Horodatage actuel (exigé par la norme ICS)
  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  events.forEach(e => {
    if (!e.dateDebut) return;
    
    // ==========================================
    // BLOC 1 : L'ÉVÉNEMENT (VEVENT)
    // ==========================================
    ics.push("BEGIN:VEVENT");
    ics.push(`UID:slat-event-${e.id}@slat.info`);
    ics.push(`DTSTAMP:${nowStamp}`);
    
    // Formatage des dates pour événements sur la journée entière (YYYYMMDD)
    const start = e.dateDebut.substring(0, 10).replace(/-/g, "");
    ics.push(`DTSTART;VALUE=DATE:${start}`);
    
    if (e.dateFin) {
      const dEnd = new Date(e.dateFin.substring(0, 10));
      dEnd.setDate(dEnd.getDate() + 1);
      const end = dEnd.toISOString().substring(0, 10).replace(/-/g, "");
      ics.push(`DTEND;VALUE=DATE:${end}`);
    } else {
      ics.push(`DTEND;VALUE=DATE:${start}`); 
    }

    ics.push(`SUMMARY:${e.nom}`);
    
    let desc = `Statut : ${e.statut || 'Non défini'}\\n`;
    if (e.saison) desc += `Saison : ${e.saison}\\n`;
    if (e.debutInscriptions) desc += `Inscriptions : Du ${e.debutInscriptions.substring(0, 10)}`;
    if (e.finInscriptions) desc += ` au ${e.finInscriptions.substring(0, 10)}`;
    desc += `\\n`;
    if (e.debutCom) desc += `Communication : Du ${e.debutCom.substring(0, 10)}`;
    if (e.finCom) desc += ` au ${e.finCom.substring(0, 10)}`;
    desc += `\\n`;
    
    ics.push(`DESCRIPTION:${desc}`);
    ics.push("END:VEVENT");

    // ==========================================
    // BLOC 2 : LA TÂCHE (VTODO) - Échéance CSE
    // ==========================================
    if (e.echeanceCSE) {
      ics.push("BEGIN:VTODO");
      ics.push(`UID:slat-task-cse-${e.id}@slat.info`);
      ics.push(`DTSTAMP:${nowStamp}`);
      
      // Date d'échéance (DUE)
      const due = e.echeanceCSE.substring(0, 10).replace(/-/g, "");
      ics.push(`DUE;VALUE=DATE:${due}`);
      
      ics.push(`SUMMARY:🔴 Com CSE : ${e.nom}`);
      ics.push(`DESCRIPTION:Date limite pour envoyer les infos com.`);
      
      // La tâche est terminée si l'info est envoyée, publiée ou réalisée
      const statutsTermines = ["infos envoyées", "publié", "réalisé"];
      const isDone = e.statut && statutsTermines.includes(e.statut.trim().toLowerCase());
      
      ics.push(`STATUS:${isDone ? 'COMPLETED' : 'NEEDS-ACTION'}`);
      if (isDone) {
        ics.push(`PERCENT-COMPLETE:100`);
      }
      
      ics.push("END:VTODO");
    }
  });

  ics.push("END:VCALENDAR");
  
  // RFC 5545 : Les lignes de plus de 75 caractères doivent être pliées.
  // Nextcloud rejette le fichier entier si on ne le fait pas.
  return ics.map(line => {
    if (line.length <= 75) return line;
    let folded = "";
    for (let i = 0; i < line.length; i += 74) {
      folded += line.substring(i, i + 74);
      if (i + 74 < line.length) folded += "\r\n "; // Un espace au début de la ligne suivante
    }
    return folded;
  }).join("\r\n");
}

// 5. Serveur Web
const app = express();

app.get("/", async (req, res) => {
  try {
    const events = await fetchEvents();
    const icsData = generateICS(events);
    
    // Indique au navigateur / agenda qu'il s'agit d'un fichier calendrier
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="slat-calendrier.ics"'
    });
    
    res.send(icsData);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

app.get("/healthz", (_, res) => res.send("ok"));

app.listen(parseInt(PORT, 10), () =>
  console.log(`📡 Passerelle ICS SLAT démarrée sur le port ${PORT}`)
);
