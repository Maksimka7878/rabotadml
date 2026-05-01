async function amoRequest(domain, token, endpoint, params = {}) {
  const url = new URL(`https://${domain}.amocrm.ru/api/v4/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getRecordingUrl(phone) {
  const domain = process.env.AMO_DOMAIN;
  const token = process.env.AMO_TOKEN;
  if (!domain || !token) return null;

  const digits = phone.replace(/\D/g, "");

  // 1. Find contact by phone
  const contactsData = await amoRequest(domain, token, "contacts", { query: digits, limit: 1 });
  const contacts = contactsData?._embedded?.contacts || [];
  if (!contacts.length) return null;
  const contactId = contacts[0].id;

  // 2. Get call notes for contact (call_in / call_out stored as notes)
  const notesData = await amoRequest(domain, token, `contacts/${contactId}/notes`, {
    limit: 50,
    "order[id]": "desc",
  });
  const notes = notesData?._embedded?.notes || [];

  const callNote = notes.find(n => n.note_type === "call_in" || n.note_type === "call_out");
  if (!callNote) return null;

  return callNote.params?.link || callNote.params?.record_url || null;
}

async function getRecordingUrlFromLink(crmLink) {
  const domain = process.env.AMO_DOMAIN;
  const token = process.env.AMO_TOKEN;
  if (!domain || !token) return null;

  // Extract lead ID from https://....amocrm.ru/leads/detail/12345
  const match = crmLink.match(/\/leads\/detail\/(\d+)/);
  if (!match) return null;
  const leadId = match[1];

  // 1. Check lead notes directly
  const leadNotesData = await amoRequest(domain, token, `leads/${leadId}/notes`, {
    limit: 50,
    "order[id]": "desc",
  });
  const leadNotes = leadNotesData?._embedded?.notes || [];
  const callNoteOnLead = leadNotes.find(n => n.note_type === "call_in" || n.note_type === "call_out");
  if (callNoteOnLead?.params?.link) return callNoteOnLead.params.link;
  if (callNoteOnLead?.params?.record_url) return callNoteOnLead.params.record_url;

  // 2. Fallback — check contact notes attached to the lead
  const leadData = await amoRequest(domain, token, `leads/${leadId}`, { with: "contacts" });
  const contactIds = (leadData?._embedded?.contacts || []).map(c => c.id);

  for (const contactId of contactIds) {
    const notesData = await amoRequest(domain, token, `contacts/${contactId}/notes`, {
      limit: 50,
      "order[id]": "desc",
    });
    const notes = notesData?._embedded?.notes || [];
    const callNote = notes.find(n => n.note_type === "call_in" || n.note_type === "call_out");
    if (callNote?.params?.link) return callNote.params.link;
    if (callNote?.params?.record_url) return callNote.params.record_url;
  }

  return null;
}

module.exports = { getRecordingUrl, getRecordingUrlFromLink };
