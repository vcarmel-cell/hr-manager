let requestId, requestData, templateData, originalPdfBytes;
let roundData = null; // set only when requestData.mode === 'multiSign'
let pageInfos = [];
let fieldControls = {}; // fieldId -> { getValue(), kind }

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

function isMultiSign() { return requestData.mode === 'multiSign'; }

async function renderFillScreen() {
  if (isMultiSign()) {
    const roundDoc = await db.collection('signingRounds').doc(requestData.roundId).get();
    if (!roundDoc.exists || roundDoc.data().status !== 'in_progress'
        || (roundDoc.data().signerNames || {})[requestData.roleFieldId]) {
      showDone('הקישור אינו בתוקף', 'החתימה הזו כבר בוצעה, או שסבב החתימות הסתיים.');
      return;
    }
    roundData = roundDoc.data();
  }

  const tplDoc = await db.collection('templates').doc(requestData.templateId).get();
  templateData = tplDoc.data();
  document.getElementById('tplTitle').textContent =
    requestData.templateName + (isMultiSign() ? ` — חתימת ${requestData.roleLabel}` : '');

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

  const fields = isMultiSign() ? (roundData.fields || []) : (requestData.fields || []);
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
  document.getElementById('submitSignBtn').addEventListener('click', isMultiSign() ? submitMultiSign : submitSigning);
}

function buildFieldControl(field, overlay) {
  const rectPx = pctRectToPx(field, overlay.clientWidth, overlay.clientHeight);
  const box = document.createElement('div');
  box.className = 'sign-field';
  applyRectPx(box, rectPx);

  const autoValue = isMultiSign() ? undefined : (requestData.autoFilledValues || {})[field.id];

  // Multi-sign: a field already filled by another role (shared value), or a
  // signature field belonging to a role that isn't mine, renders read-only.
  if (isMultiSign()) {
    const isMyRole = field.id === requestData.roleFieldId;
    const alreadySharedValue = (roundData.values || {})[field.id];
    if (field.type === 'signature' && !isMyRole) {
      const otherSig = (roundData.rawSignatures || {})[field.id];
      box.classList.add('sign-field-readonly');
      if (otherSig) {
        const img = document.createElement('img');
        img.src = otherSig; img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'contain';
        box.appendChild(img);
      } else {
        box.style.border = '1px dashed var(--muted)';
        box.textContent = 'ממתין לחתימת ' + (field.label || '');
        box.style.fontSize = '10px'; box.style.color = 'var(--muted)';
      }
      overlay.appendChild(box);
      fieldControls[field.id] = { getValue: () => null, kind: 'readonly' };
      return;
    }
    if (field.type !== 'signature' && alreadySharedValue != null && alreadySharedValue !== '') {
      box.classList.add('sign-field-readonly');
      box.style.background = '#f0f0f0'; box.style.color = 'var(--muted)'; box.style.fontSize = '12px';
      box.style.display = 'flex'; box.style.alignItems = 'center'; box.style.padding = '0 4px';
      box.textContent = field.type === 'checkbox' ? (alreadySharedValue ? '✓' : '—') : String(alreadySharedValue);
      overlay.appendChild(box);
      fieldControls[field.id] = { getValue: () => alreadySharedValue, kind: 'readonly' };
      return;
    }
  }

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
  if (field.type === 'idNumber') {
    input.inputMode = 'numeric';
    input.maxLength = 9;
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 9); });
  }
  if (field.type === 'phone') {
    input.inputMode = 'numeric';
    input.maxLength = 11;
    input.placeholder = '050-1234567';
    attachPhoneMask(input);
  }
  if (autoValue != null) input.value = autoValue;
  if (field.locked) input.readOnly = true;
  box.appendChild(input);
  overlay.appendChild(box);
  fieldControls[field.id] = { getValue: () => input.value.trim(), kind: 'text' };
}

function validateFields(fields, errorEl) {
  const values = {};
  for (const field of fields) {
    const ctrl = fieldControls[field.id];
    if (ctrl.kind === 'readonly') { values[field.id] = ctrl.getValue(); continue; }
    const val = ctrl.getValue();
    if (field.type === 'date' && val && !isValidDateStr(val)) {
      errorEl.textContent = `תאריך לא תקין בשדה "${field.label || ''}" (פורמט: DD.MM.YYYY).`;
      return null;
    }
    if (!field.locked && field.type === 'idNumber' && val && !isValidIsraeliId(val)) {
      errorEl.textContent = `מספר ת.ז. לא תקין בשדה "${field.label || 'ת.ז.'}".`;
      return null;
    }
    if (!field.locked && field.type === 'phone' && val && !isValidIsraeliMobile(val)) {
      errorEl.textContent = `מספר טלפון לא תקין בשדה "${field.label || 'טלפון'}".`;
      return null;
    }
    if (!field.locked && field.required && field.type === 'signature' && !val) {
      errorEl.textContent = `נא לחתום בשדה "${field.label || 'חתימה'}".`;
      return null;
    }
    if (!field.locked && field.required && field.type !== 'checkbox' && field.type !== 'signature' && !val) {
      errorEl.textContent = `נא למלא את השדה "${field.label || ''}".`;
      return null;
    }
    values[field.id] = val;
  }
  return values;
}

async function submitSigning() {
  const errorEl = document.getElementById('submitError');
  const fields = requestData.fields || [];
  const values = validateFields(fields, errorEl);
  if (!values) return;

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

async function submitMultiSign() {
  const errorEl = document.getElementById('submitError');
  const nameInput = prompt('שם מלא לחתימה:', requestData.recipientName || '');
  if (!nameInput || !nameInput.trim()) { errorEl.textContent = 'נא להזין שם.'; return; }

  const fields = roundData.fields || [];
  const values = validateFields(fields, errorEl);
  if (!values) return;
  const myValue = values[requestData.roleFieldId]; // the signature data URL for my own role
  if (!myValue) { errorEl.textContent = 'נא לחתום.'; return; }

  errorEl.textContent = '';
  document.getElementById('submitSignBtn').disabled = true;
  document.getElementById('submitSignBtn').textContent = 'שולח...';

  const roundRef = db.collection('signingRounds').doc(requestData.roundId);
  try {
    // Only NEW keys I'm contributing (fields I actually filled, not the ones
    // that were already read-only/pre-filled by another role) - keeps this
    // update provably additive-only for the Firestore rule.
    const myNewValues = {};
    fields.forEach(f => {
      if (f.id === requestData.roleFieldId) return; // that's the signature itself, tracked separately
      const ctrl = fieldControls[f.id];
      if (ctrl.kind !== 'readonly' && values[f.id] != null && values[f.id] !== '') myNewValues[f.id] = values[f.id];
    });

    let completionResult = null;
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(roundRef);
      const data = fresh.data();
      if (data.status !== 'in_progress') throw new Error('ALREADY_HANDLED');

      const newValues = { ...data.values, ...myNewValues };
      const newSignerNames = { ...data.signerNames, [requestData.roleFieldId]: nameInput.trim() };
      const newRawSignatures = { ...data.rawSignatures, [requestData.roleFieldId]: myValue };

      const allRoleIds = fields.filter(f => f.type === 'signature').map(f => f.id);
      const allSigned = allRoleIds.every(id => newRawSignatures[id]);
      const newStatus = allSigned ? 'completing' : 'in_progress';

      tx.update(roundRef, { values: newValues, signerNames: newSignerNames, rawSignatures: newRawSignatures, status: newStatus });
      tx.update(db.collection('signingRequests').doc(requestId), { status: 'signed', signedAt: firebase.firestore.FieldValue.serverTimestamp() });

      if (allSigned) completionResult = { fields, values: newValues, rawSignatures: newRawSignatures };
    });

    if (completionResult) {
      await loadPdfLib();
      const resolveStamp = (field) => {
        if (field.type === 'signature') {
          const sig = completionResult.rawSignatures[field.id];
          return sig ? { kind: 'signature', dataUrl: sig } : null;
        }
        if (field.type === 'checkbox') return { kind: 'checkbox', checked: !!completionResult.values[field.id] };
        const val = completionResult.values[field.id];
        return val ? { kind: 'text', value: String(val) } : null;
      };
      const flattenedBytes = await flattenPdf(originalPdfBytes, completionResult.fields, resolveStamp);
      await storage.ref(`signingRounds/${requestData.roundId}/signed.pdf`).put(new Blob([flattenedBytes], { type: 'application/pdf' }));
      // rawSignatures must be explicitly deleted (not just left alone) - the
      // completing->completed security rule requires it entirely absent from
      // the resulting doc, matching PDFSign's exact behavior of discarding
      // raw signature images once they're burned into the flattened PDF.
      await roundRef.update({
        status: 'completed',
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        rawSignatures: firebase.firestore.FieldValue.delete()
      });
      showDone('המסמך הושלם', 'כל החתימות נאספו ועותק חתום נשמר במערכת.');
    } else {
      showDone('החתימה שלך נשמרה', 'ממתינים לחתימות נוספות לפני שהמסמך יושלם.');
    }
  } catch (e) {
    if (e.message === 'ALREADY_HANDLED') {
      showDone('הקישור אינו בתוקף', 'החתימה הזו כבר בוצעה, או שסבב החתימות הסתיים.');
      return;
    }
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
