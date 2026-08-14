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
      ics.push(`DESCRIPTION:Date limite pour envoyer les informations au groupe de communication du CSE.`);
      
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
  
  // Le standard ICS exige des fins de ligne spécifiques (CRLF)
  return ics.join("\r\n");
}
