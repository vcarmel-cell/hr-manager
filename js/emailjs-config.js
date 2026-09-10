// Optional — same pattern as PDFSign. Until these are filled in with a real
// EmailJS account's values, sendSigningEmail() silently no-ops and the admin
// panel falls back to showing the link/code on-screen to copy and send
// manually (WhatsApp, SMS, in person, etc). Nothing else depends on this.
const EMAILJS_CONFIG = {
  publicKey: 'PASTE_EMAILJS_PUBLIC_KEY',
  serviceId: 'PASTE_EMAILJS_SERVICE_ID',
  templateId: 'PASTE_EMAILJS_TEMPLATE_ID'
};

function emailJsConfigured() {
  return !Object.values(EMAILJS_CONFIG).some(v => v.startsWith('PASTE_'));
}

let _emailJsLoaded = false;
function loadEmailJs() {
  return new Promise((resolve, reject) => {
    if (_emailJsLoaded) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
    s.onload = () => { emailjs.init({ publicKey: EMAILJS_CONFIG.publicKey }); _emailJsLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// templateParams should match whatever fields the EmailJS template expects,
// e.g. { to_email, to_name, subject, message }. Returns true if actually sent.
async function sendSigningEmail(templateParams) {
  if (!emailJsConfigured()) return false;
  try {
    await loadEmailJs();
    await emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templateId, templateParams);
    return true;
  } catch (e) {
    console.error('EmailJS send failed', e);
    return false;
  }
}
