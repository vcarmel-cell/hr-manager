let requestId, requestData, templateData, originalPdfBytes;
let pageInfos = [];
let fieldControls = {}; // fieldId -> { getValue(), el }

init();

async function init() {
  const params = new URLSearchParams(location.search);
  requestId = params.get('req');
  if (!requestId) { showDone('קישור לא תקין', 'לא נמצא מזהה בקישור.'); return; }

  try {
    await auth.signInAnonymously();
  } catch (e) {
    showDone('שגיאה', 'לא ניתן היה להתחבר למערכת. נסה שוב מאוחר יותר.');
    return;
  }

  await loadRequest();
}

async function loadRequest() {
  const doc = await db.collection('signingRequests').doc(requestId).get();
  if (!doc.exists) { showDone('קישור לא תקין', 'המסמך המבוקש לא נמצא.'); return; }
  requestData = doc.data();

  if (requestData.status === 'signed') { showDone('המסמך כבר נחתם', 'תודה, החתימה כבר התקבלה בעבר.'); return; }
  if (requestData.status === 'expired') { showDone('הקישור אינו בתוקף', 'יש לפנות למנהל לקבלת קישור חדש.'); return; }
  if (!requestData.otpVerified && requestData.otpAttempts >= 5) {
    showDone('יותר מדי ניסיונות שגויים', 'יש לפנות למנהל לקבלת קישור חדש.');
    return;
  }

  document.getElementById('loadingScreen').style.display = 'none';
  if (!requestData.otpVerified) {
    document.getElementById('otpScreen').style.display = 'block';
    document.getElementById('otpSubmitBtn').addEventListener('click', submitOtp);
    document.getElementById('otpInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitOtp(); });
  } else {
    await renderFillScreen();
  }
}

async function submitOtp() {
  const code = document.getElementById('otpInput').value.trim();
  const errorEl = document.getElementById('otpError');
  if (!/^\d{6}$/.test(code)) { errorEl.textContent = 'יש להזין קוד בן 6 ספרות.'; return; }

  const attemptHash = await sha256Hex(code);
  try {
    await db.collection('signingRequests').doc(requestId).update({
      otpAttempts: firebase.firestore.FieldValue.increment(1),
      otpVerified: true, // the rules only actually allow this to stick if attemptHash truly matches; otherwise the whole write is rejected
      attemptHash
    });
  } catch (e) {
    // The optimistic "otpVerified: true" write above gets rejected by rules
    // whenever the hash doesn't match (rules require otpVerified to equal
    // the comparison result) — that shows up here as permission-denied, but
    // we still need the attempt to count. Record just the attempt instead.
    try {
      await db.collection('signingRequests').doc(requestId).update({
        otpAttempts: firebase.firestore.FieldValue.increment(1),
        otpVerified: false,
        attemptHash
      });
    } catch (e2) { /* attempts exhausted or other terminal state */ }
  }

  const fresh = await db.collection('signingRequests').doc(requestId).get();
  requestData = fresh.data();
  if (requestData.otpVerified) {
    document.getElementById('otpScreen').style.display = 'none';
    await renderFillScreen();
  } else if (requestData.otpAttempts >= 5) {
    showDone('יותר מדי ניסיונות שגויים', 'יש לפנות למנהל לקבלת קישור חדש.');
  } else {
    errorEl.textContent = `קוד שגוי. נותרו ${5 - requestData.otpAttempts} ניסיונות.`;
    document.getElementById('otpInput').value = '';
  }
}

function showDone(title, msg) {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('otpScreen').style.display = 'none';
  document.getElementById('fillScreen').style.display = 'none';
  document.getElementById('doneScreen').style.display = 'block';
  document.getElementById('doneTitle').textContent = title;
  document.getElementById('doneMsg').textContent = msg;
}

async function renderFillScreen() {
  const tplDoc = await db.collection('templates').doc(requestData.templateId).get();
  templateData = tplDoc.data();
  document.getElementById('tplTitle').textContent = requestData.templateName || templateData.name;

  const url = await storage.ref(templateData.storagePath).getDownloadURL();
  const res = await fetch(url);
  originalPdfBytes = new Uint8Array(await res.arrayBuffer());

  await loadPdfJs();
  const doc = await loadPdfDocument(originalPdfBytes.slice());
  const pagesEl = document.getElementById('signPages');
  pagesEl.innerHTML = '';
  pageInfos = [];
  fieldControls = {};
  const cssWidth = Math.min(700, pagesEl.clientWidth || 700);

  const fields = requestData.fields || [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const wrap = document.createElement('div');
    wrap.className = 'sign-page-wrap';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    const overlay = document.createElement('div');
    overlay.className = 'sign-overlay';
    wrap.appendChild(overlay);
    pagesEl.appendChild(wrap);

    const info = await renderPdfPageToCanvas(page, canvas, cssWidth);
    pageInfos[i] = info;
    overlay.style.width = info.cssWidth + 'px';
    overlay.style.height = info.cssHeight + 'px';

    fields.filter(f => f.page === i).forEach(field => buildFieldControl(field, overlay));
  }

  document.getElementById('fillScreen').style.display = 'block';
  document.getElementById('submitSignBtn').addEventListener('click', submitSigning);
}

function buildFieldControl(field, overlay) {
  const rectPx = pctRectToPx(field, overlay.clientWidth, overlay.clientHeight);
  const box = document.createElement('div');
  box.className = 'sign-field';
  applyRectPx(box, rectPx);

  const autoValue = (requestData.autoFilledValues || {})[field.id];

  if (field.type === 'signature') {
    const canvas = document.createElement('canvas');
    canvas.className = 'sig-pad';
    box.appendChild(canvas);
    overlay.appendChild(box);
    const pad = initSignaturePad(canvas);
    fieldControls[field.id] = { getValue: () => pad.hasDrawn() ? pad.getDataURL() : null, kind: 'signature' };
    return;
  }

  if (field.type === 'checkbox') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    if (autoValue) input.checked = true;
    if (field.locked) input.disabled = true;
    box.appendChild(input);
    overlay.appendChild(box);
    fieldControls[field.id] = { getValue: () => input.checked, kind: 'checkbox' };
    return;
  }

  const input = document.createElement('input');
  input.type = field.type === 'number' ? 'number' : 'text';
  if (field.type === 'date') attachDateMask(input);
  if (autoValue != null) input.value = autoValue;
  if (field.locked) input.readOnly = true;
  box.appendChild(input);
  overlay.appendChild(box);
  fieldControls[field.id] = { getValue: () => input.value.trim(), kind: 'text' };
}

async function submitSigning() {
  const errorEl = document.getElementById('submitError');
  const fields = requestData.fields || [];
  const values = {};

  for (const field of fields) {
    const ctrl = fieldControls[field.id];
    const val = ctrl.getValue();
    if (field.type === 'date' && val && !isValidDateStr(val)) {
      errorEl.textContent = `תאריך לא תקין בשדה "${field.label || ''}" (פורמט: DD.MM.YYYY).`;
      return;
    }
    if (!field.locked && field.type === 'signature' && !val) {
      errorEl.textContent = `נא לחתום בשדה "${field.label || 'חתימה'}".`;
      return;
    }
    if (!field.locked && field.type !== 'checkbox' && field.type !== 'signature' && !val) {
      errorEl.textContent = `נא למלא את השדה "${field.label || ''}".`;
      return;
    }
    values[field.id] = val;
  }

  errorEl.textContent = '';
  document.getElementById('submitSignBtn').disabled = true;
  document.getElementById('submitSignBtn').textContent = 'שולח...';

  try {
    await loadPdfLib();
    const resolveStamp = (field) => {
      const val = values[field.id];
      if (field.type === 'signature') return val ? { kind: 'signature', dataUrl: val } : null;
      if (field.type === 'checkbox') return { kind: 'checkbox', checked: !!val };
      return val ? { kind: 'text', value: String(val) } : null;
    };
    const flattenedBytes = await flattenPdf(originalPdfBytes, fields, resolveStamp);

    const storagePath = `signingRequests/${requestId}/signed.pdf`;
    await storage.ref(storagePath).put(new Blob([flattenedBytes], { type: 'application/pdf' }));

    await db.collection('signingRequests').doc(requestId).update({
      status: 'signed', values, signedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    showDone('תודה!', 'המסמך נחתם ונשלח בהצלחה.');
  } catch (e) {
    errorEl.textContent = 'שגיאה בשליחה: ' + e.message;
    document.getElementById('submitSignBtn').disabled = false;
    document.getElementById('submitSignBtn').textContent = 'שליחה';
  }
}

function loadPdfLib() {
  return new Promise((resolve, reject) => {
    if (window.PDFLib) { resolve(); return; }
    const s = document.createElement('script');
    s.src = PDF_LIB_SCRIPT_URL;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
