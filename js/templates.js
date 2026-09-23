let currentUser, currentUserName;
let templates = [];
let currentTemplateId = null;
let currentFields = [];
let currentPdfBytes = null;
let selectedFieldId = null;
let pageInfos = []; // { pageWidthPt, pageHeightPt, cssWidth, cssHeight }
let pageCanvases = [];
let activeFieldType = null;
const FIELD_DEFAULT_SIZE_PX = { text: [140, 22], number: [90, 22], date: [110, 22], idNumber: [110, 22], phone: [120, 22], checkbox: [24, 24], signature: [180, 60] };
const MAX_TEMPLATES = 20;

init();

async function init() {
  const info = await requireRole(['superadmin']);
  currentUser = info.user;
  currentUserName = info.name;
  document.getElementById('whoAmI').textContent = currentUserName || currentUser.email;
  document.getElementById('logoutBtn').addEventListener('click', () => auth.signOut().then(() => location.href = 'login.html'));

  document.getElementById('newTemplateBtn').addEventListener('click', resetToNewTemplate);
  document.getElementById('templateSelect').addEventListener('change', onSelectTemplate);
  document.getElementById('tplFile').addEventListener('change', onFileChosen);
  document.getElementById('saveTemplateBtn').addEventListener('click', saveTemplate);
  document.getElementById('deleteTemplateBtn').addEventListener('click', deleteTemplate);
  document.getElementById('applyFieldBtn').addEventListener('click', applyFieldForm);
  document.getElementById('deleteFieldBtn').addEventListener('click', deleteSelectedField);

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.type === activeFieldType ? null : btn.dataset.type));
  });
  document.getElementById('tplMultiSign').addEventListener('change', (e) => {
    document.getElementById('multiSignHint').style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById('aiDetectBtn').addEventListener('click', runAiDetect);

  await loadPdfLib();
  await loadTemplatesList();
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

async function loadTemplatesList() {
  const snap = await db.collection('templates').where('active', '==', true).orderBy('name').get();
  templates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const sel = document.getElementById('templateSelect');
  sel.innerHTML = '<option value="">-- תבנית חדשה --</option>' +
    templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}

function resetToNewTemplate() {
  currentTemplateId = null;
  currentFields = [];
  currentPdfBytes = null;
  selectedFieldId = null;
  setActiveTool(null);
  document.getElementById('templateSelect').value = '';
  document.getElementById('tplName').value = '';
  document.getElementById('tplFile').value = '';
  document.getElementById('deleteTemplateBtn').style.display = 'none';
  document.getElementById('aiDetectBtn').style.display = 'none';
  document.getElementById('tplHint').textContent = '';
  document.getElementById('tplLayout').style.display = 'none';
  document.getElementById('tplPages').innerHTML = '';
  document.getElementById('tplMultiSign').checked = false;
  document.getElementById('tplMultiSign').disabled = false;
  document.getElementById('multiSignHint').style.display = 'none';
  closeFieldForm();
}

async function onSelectTemplate() {
  const id = document.getElementById('templateSelect').value;
  if (!id) { resetToNewTemplate(); return; }
  const tpl = templates.find(t => t.id === id);
  currentTemplateId = id;
  currentFields = JSON.parse(JSON.stringify(tpl.fields || []));
  selectedFieldId = null;
  document.getElementById('tplName').value = tpl.name;
  document.getElementById('tplFile').value = '';
  document.getElementById('deleteTemplateBtn').style.display = 'inline-block';
  document.getElementById('aiDetectBtn').style.display = aiDetectConfigured() ? 'inline-block' : 'none';
  document.getElementById('tplHint').textContent = 'טוען PDF...';
  document.getElementById('tplMultiSign').checked = tpl.mode === 'multiSign';
  document.getElementById('multiSignHint').style.display = tpl.mode === 'multiSign' ? 'block' : 'none';
  await refreshMultiSignLockState(id);

  const url = await storage.ref(tpl.storagePath).getDownloadURL();
  const res = await fetch(url);
  currentPdfBytes = new Uint8Array(await res.arrayBuffer());
  document.getElementById('tplHint').textContent = '';
  await renderAllPages();
}

function aiDetectConfigured() {
  return typeof AI_DETECT_FUNCTION_URL !== 'undefined' && !AI_DETECT_FUNCTION_URL.startsWith('PASTE_');
}

const KNOWN_FIELD_TYPES = ['text', 'number', 'idNumber', 'phone', 'date', 'checkbox', 'signature'];

async function runAiDetect() {
  const hint = document.getElementById('tplHint');
  const btn = document.getElementById('aiDetectBtn');
  btn.disabled = true;
  hint.style.color = '';
  hint.textContent = 'מזהה שדות אוטומטי באמצעות AI... (עשוי לקחת כמה שניות)';
  try {
    const pages = pageCanvases.map((canvas, i) => ({
      page: i, imageBase64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
    }));
    const idToken = await currentUser.getIdToken();
    const res = await fetch(AI_DETECT_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ pages })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    const detected = Array.isArray(data.fields) ? data.fields : [];
    detected.forEach((f, i) => {
      const type = KNOWN_FIELD_TYPES.includes(f.type) ? f.type : 'text';
      const page = Math.max(0, Math.min(pageCanvases.length - 1, Math.round(f.page) || 0));
      const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
      currentFields.push({
        id: newId(), type, page,
        xPct: clamp01(f.xPct), yPct: clamp01(f.yPct), wPct: clamp01(f.wPct), hPct: clamp01(f.hPct),
        label: (f.label && String(f.label).trim()) || (FIELD_TYPE_LABELS[type] + ' ' + (i + 1)),
        autoFillFrom: '', locked: false, required: type === 'signature'
      });
    });
    renderFieldBoxes();
    hint.textContent = detected.length
      ? `זוהו ${detected.length} שדות. בדקו/התאימו ואז לחצו "שמירת תבנית".`
      : 'לא זוהו שדות. אפשר להוסיף שדות ידנית.';
  } catch (e) {
    hint.style.color = 'var(--danger)';
    hint.textContent = 'שגיאה בזיהוי אוטומטי: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Disables the multi-sign toggle while a signing round is actively in
// progress for this template, so the mode can't be flipped mid-flight.
async function refreshMultiSignLockState(templateId) {
  const snap = await db.collection('signingRequests')
    .where('templateId', '==', templateId)
    .where('mode', '==', 'multiSign')
    .where('status', 'in', ['in_progress', 'completing'])
    .limit(1).get();
  document.getElementById('tplMultiSign').disabled = !snap.empty;
}

async function onFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  currentPdfBytes = new Uint8Array(await file.arrayBuffer());
  currentFields = [];
  selectedFieldId = null;
  await renderAllPages();
}

async function renderAllPages() {
  await loadPdfJs();
  const doc = await loadPdfDocument(currentPdfBytes.slice());
  const pagesEl = document.getElementById('tplPages');
  pagesEl.innerHTML = '';
  pageInfos = [];
  pageCanvases = [];
  const cssWidth = Math.min(700, pagesEl.clientWidth || 700);

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const wrap = document.createElement('div');
    wrap.className = 'tpl-page-wrap';
    const canvas = document.createElement('canvas');
    pageCanvases[i] = canvas;
    wrap.appendChild(canvas);
    const overlay = document.createElement('div');
    overlay.className = 'tpl-overlay';
    overlay.dataset.page = i;
    wrap.appendChild(overlay);
    pagesEl.appendChild(wrap);

    const info = await renderPdfPageToCanvas(page, canvas, cssWidth);
    pageInfos[i] = info;
    overlay.style.width = info.cssWidth + 'px';
    overlay.style.height = info.cssHeight + 'px';
    wireOverlayDrawing(overlay, i);
  }

  document.getElementById('tplLayout').style.display = 'flex';
  renderFieldBoxes();
}

function setActiveTool(type) {
  activeFieldType = type;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.querySelectorAll('.tpl-overlay').forEach(o => o.classList.toggle('placing', !!type));
}

function wireOverlayDrawing(overlay, pageIndex) {
  let drawing = null;
  overlay.addEventListener('pointerdown', (e) => {
    if (!activeFieldType) return; // pick a field type from the sidebar first
    if (e.target !== overlay) return; // clicks on existing field boxes handled separately
    const rect = overlay.getBoundingClientRect();
    const draftEl = document.createElement('div');
    draftEl.className = 'tpl-draft-rect';
    overlay.appendChild(draftEl);
    drawing = { startX: e.clientX - rect.left, startY: e.clientY - rect.top, page: pageIndex, draftEl };
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const rect = overlay.getBoundingClientRect();
    const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
    const leftPx = Math.min(drawing.startX, curX), topPx = Math.min(drawing.startY, curY);
    const widthPx = Math.abs(curX - drawing.startX), heightPx = Math.abs(curY - drawing.startY);
    applyRectPx(drawing.draftEl, { leftPx, topPx, widthPx, heightPx });
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!drawing) return;
    const type = activeFieldType;
    const rect = overlay.getBoundingClientRect();
    const endX = e.clientX - rect.left, endY = e.clientY - rect.top;
    let leftPx = Math.min(drawing.startX, endX), topPx = Math.min(drawing.startY, endY);
    let widthPx = Math.abs(endX - drawing.startX), heightPx = Math.abs(endY - drawing.startY);
    drawing.draftEl.remove();
    drawing = null;

    // A plain click (no real drag) places a default-sized box for the chosen type.
    if (widthPx < 10 || heightPx < 10) {
      [widthPx, heightPx] = FIELD_DEFAULT_SIZE_PX[type];
    }
    const boxWidthPx = overlay.clientWidth, boxHeightPx = overlay.clientHeight;
    leftPx = Math.min(Math.max(leftPx, 0), boxWidthPx - widthPx);
    topPx = Math.min(Math.max(topPx, 0), boxHeightPx - heightPx);

    const pct = pxRectToPct({ leftPx, topPx, widthPx, heightPx }, boxWidthPx, boxHeightPx);
    const field = {
      id: newId(), type, page: pageIndex,
      xPct: pct.xPct, yPct: pct.yPct, wPct: pct.wPct, hPct: pct.hPct,
      label: '', autoFillFrom: '', locked: false, required: type === 'signature'
    };
    currentFields.push(field);
    selectedFieldId = field.id;
    setActiveTool(null);
    renderFieldBoxes();
    openFieldForm(field);
  });
  overlay.addEventListener('pointercancel', () => {
    if (!drawing) return;
    drawing.draftEl.remove();
    drawing = null;
  });
}

function renderFieldBoxes() {
  document.querySelectorAll('.tpl-overlay').forEach(overlay => {
    overlay.querySelectorAll('.tpl-field-box').forEach(el => el.remove());
  });
  const overlays = document.querySelectorAll('.tpl-overlay');
  currentFields.forEach(field => {
    const overlay = overlays[field.page];
    if (!overlay) return;
    const rectPx = pctRectToPx(field, overlay.clientWidth, overlay.clientHeight);
    const box = document.createElement('div');
    box.className = 'tpl-field-box' + (field.locked ? ' locked' : '');
    applyRectPx(box, rectPx);
    box.textContent = (field.label || FIELD_TYPE_LABELS[field.type]) + (field.autoFillFrom ? ' 🔗' : '');
    box.dataset.fieldId = field.id;

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    box.appendChild(handle);

    wireFieldBoxInteraction(box, field, overlay, handle);
    overlay.appendChild(box);
  });
}

function wireFieldBoxInteraction(box, field, overlay, handle) {
  let mode = null; // 'move' | 'resize'
  let startClientX, startClientY, startField;

  function onDown(e, m) {
    e.stopPropagation();
    mode = m;
    startClientX = e.clientX; startClientY = e.clientY;
    startField = { ...field };
    box.setPointerCapture(e.pointerId);
  }
  box.addEventListener('pointerdown', (e) => { if (e.target === handle) return; onDown(e, 'move'); });
  handle.addEventListener('pointerdown', (e) => onDown(e, 'resize'));

  box.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const dxPct = (e.clientX - startClientX) / overlay.clientWidth;
    const dyPct = (e.clientY - startClientY) / overlay.clientHeight;
    if (mode === 'move') {
      field.xPct = Math.max(0, Math.min(1 - field.wPct, startField.xPct + dxPct));
      field.yPct = Math.max(0, Math.min(1 - field.hPct, startField.yPct + dyPct));
    } else {
      field.wPct = Math.max(0.02, startField.wPct + dxPct);
      field.hPct = Math.max(0.015, startField.hPct + dyPct);
    }
    const rectPx = pctRectToPx(field, overlay.clientWidth, overlay.clientHeight);
    applyRectPx(box, rectPx);
  });

  function onUp(e) {
    if (!mode) return;
    const moved = Math.abs(e.clientX - startClientX) > 3 || Math.abs(e.clientY - startClientY) > 3;
    mode = null;
    if (!moved) {
      selectedFieldId = field.id;
      openFieldForm(field);
    }
  }
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
}

function openFieldForm(field) {
  document.getElementById('noFieldSelected').style.display = 'none';
  document.getElementById('fieldForm').style.display = 'block';
  document.getElementById('fld_type').value = field.type;
  document.getElementById('fld_label').value = field.label || '';
  document.getElementById('fld_autofill').value = field.autoFillFrom || '';
  document.getElementById('fld_locked').checked = !!field.locked;
  document.getElementById('fld_required').checked = !!field.required;
}

function closeFieldForm() {
  selectedFieldId = null;
  document.getElementById('noFieldSelected').style.display = 'block';
  document.getElementById('fieldForm').style.display = 'none';
}

function applyFieldForm() {
  const field = currentFields.find(f => f.id === selectedFieldId);
  if (!field) return;
  field.type = document.getElementById('fld_type').value;
  field.label = document.getElementById('fld_label').value.trim();
  field.autoFillFrom = document.getElementById('fld_autofill').value;
  field.locked = document.getElementById('fld_locked').checked || !!field.autoFillFrom;
  field.required = document.getElementById('fld_required').checked;
  renderFieldBoxes();
}

function deleteSelectedField() {
  currentFields = currentFields.filter(f => f.id !== selectedFieldId);
  closeFieldForm();
  renderFieldBoxes();
}

async function saveTemplate() {
  const name = document.getElementById('tplName').value.trim();
  const hint = document.getElementById('tplHint');
  if (!name) { hint.textContent = 'יש להזין שם לתבנית.'; return; }
  if (!currentPdfBytes) { hint.textContent = 'יש לבחור קובץ PDF.'; return; }
  if (!currentTemplateId && templates.length >= MAX_TEMPLATES) {
    hint.textContent = `הגעת למכסה של ${MAX_TEMPLATES} תבניות. יש למחוק תבנית קיימת לפני הוספת תבנית חדשה.`;
    return;
  }

  hint.textContent = 'שומר...';
  try {
    const templateId = currentTemplateId || newId();
    const storagePath = `templates/${templateId}/master.pdf`;
    const fileInput = document.getElementById('tplFile');
    if (fileInput.files[0]) {
      await storage.ref(storagePath).put(fileInput.files[0]);
    }
    const payload = {
      name, storagePath, fields: currentFields, active: true,
      mode: document.getElementById('tplMultiSign').checked ? 'multiSign' : 'single',
      pageCount: pageInfos.length,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!currentTemplateId) {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      payload.createdBy = currentUserName || currentUser.email;
    }
    await db.collection('templates').doc(templateId).set(payload, { merge: true });

    currentTemplateId = templateId;
    hint.textContent = 'נשמר בהצלחה.';
    await loadTemplatesList();
    document.getElementById('templateSelect').value = templateId;
    document.getElementById('deleteTemplateBtn').style.display = 'inline-block';
  } catch (e) {
    hint.textContent = 'שגיאה בשמירה: ' + e.message;
  }
}

async function deleteTemplate() {
  if (!currentTemplateId) return;
  if (!confirm('למחוק את התבנית? בקשות חתימה שכבר נשלחו לא ייפגעו.')) return;
  await db.collection('templates').doc(currentTemplateId).update({ active: false });
  resetToNewTemplate();
  await loadTemplatesList();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
