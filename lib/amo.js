async function amoRequest(domain, token, endpoint, params = {}) {
  const url = new URL(`https://${domain}/api/v4/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[amo] ${endpoint} → ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }
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
  console.log("[amo] domain:", domain, "token set:", !!token);
  if (!domain || !token) return null;

  // Extract lead ID from https://....amocrm.ru/leads/detail/12345
  const match = crmLink.match(/\/leads\/detail\/(\d+)/);
  console.log("[amo] leadId match:", match?.[1], "from:", crmLink);
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

async function amoPost(domain, token, endpoint, body) {
  const res = await fetch(`https://${domain}/api/v4/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[amo] POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return res.json();
}

async function addNoteToLead(crmLink, text) {
  const domain = process.env.AMO_DOMAIN;
  const token = process.env.AMO_TOKEN;
  if (!domain || !token) return;

  const match = crmLink.match(/\/leads\/detail\/(\d+)/);
  if (!match) return;
  const leadId = match[1];

  await amoPost(domain, token, `leads/${leadId}/notes`, [
    { note_type: "common", params: { text } }
  ]);
}

async function getLeadContactInfo(crmLink) {
  const domain = process.env.AMO_DOMAIN;
  const token = process.env.AMO_TOKEN;
  if (!domain || !token) return null;

  const match = crmLink.match(/\/leads\/detail\/(\d+)/);
  if (!match) return null;
  const leadId = match[1];

  const leadData = await amoRequest(domain, token, `leads/${leadId}`, { with: "contacts" });
  const contactIds = (leadData?._embedded?.contacts || []).map(c => c.id);
  if (!contactIds.length) return null;

  const contactId = contactIds[0];
  const contactData = await amoRequest(domain, token, `contacts/${contactId}`);
  if (!contactData) return null;

  const name = contactData.name || null;
  const phoneField = (contactData.custom_fields_values || []).find(
    f => f.field_code === "PHONE"
  );
  const phone = phoneField?.values?.[0]?.value || null;

  return { name, phone };
}

module.exports = { getRecordingUrl, getRecordingUrlFromLink, addNoteToLead, getLeadContactInfo };
