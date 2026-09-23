// Same EmailJS account used by Calendar/Calendar-Demo (shared public key),
// but a dedicated service + template created for this app - reusing
// template_g12apr8 (Calendar's appointment-notification template) would have
// sent emails with empty/missing placeholders, since it expects client_name/
// date/start_time/etc, not otp_code/link.
const EMAILJS_CONFIG = {
  publicKey: '6d_bWSpIY9nijK9fU',
  serviceId: 'HRMFA_3jlz92j',
  templateId: 'template_k1qjlxq'
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
