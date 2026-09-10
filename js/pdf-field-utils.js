// Ported from the PDFSign app (vcarmel-cell/pdfsign) — proven PDF field-fill
// and e-signature engine. Kept mostly verbatim; see that repo's history for
// the reasoning behind pdf.js 6.2.108 + disableFontFace, the date-mask input,
// and the canvas-rendered-text-as-PNG stamping approach (avoids Hebrew font
// embedding issues in pdf-lib).
const PDFJS_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.worker.min.mjs';
const PDFJS_CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/cmaps/';
const PDF_LIB_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';

const FIELD_TYPE_LABELS = {
  text: 'טקסט',
  number: 'מספר',
  date: 'תאריך',
  idNumber: 'ת.ז.',
  checkbox: 'תיבת סימון',
  signature: 'חתימה'
};

// בדיקת ספרת ביקורת לתעודת זהות ישראלית: 9 ספרות (משלימים אפסים משמאל),
// כל ספרה מוכפלת לסירוגין ב-1/2 (החל מ-1 בספרה הראשונה), תוצאה מעל 9
// מחסירים ממנה 9, והסכום הכולל חייב להתחלק ב-10 ללא שארית.
function isValidIsraeliId(value) {
  const digits = String(value || '').trim();
  if (!/^\d{1,9}$/.test(digits)) return false;
  const id = digits.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(id[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

async function loadPdfJs() {
  const mod = await import(PDFJS_SCRIPT_URL);
  window.pdfjsLib = mod;
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
}

function loadPdfDocument(bytes) {
  return pdfjsLib.getDocument({ data: bytes, cMapUrl: PDFJS_CMAP_URL, cMapPacked: true, disableFontFace: true }).promise;
}

function newId() {
  return (crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── רינדור עמוד PDF לתוך canvas ───────────────────────────────
async function renderPdfPageToCanvas(page, canvas, cssWidth) {
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = cssWidth / unscaledViewport.width;
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });
  const cssHeight = cssWidth * (unscaledViewport.height / unscaledViewport.width);

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  return { cssWidth, cssHeight, pageWidthPt: unscaledViewport.width, pageHeightPt: unscaledViewport.height };
}

// ─── שדה מאוחסן כאחוזים (0..1) מתוך גודל העמוד, מעוגן top-left (CSS) ───
function pctRectToPx(field, boxWidthPx, boxHeightPx) {
  return {
    leftPx: field.xPct * boxWidthPx,
    topPx: field.yPct * boxHeightPx,
    widthPx: field.wPct * boxWidthPx,
    heightPx: field.hPct * boxHeightPx
  };
}

function pxRectToPct(rectPx, boxWidthPx, boxHeightPx) {
  return {
    xPct: rectPx.leftPx / boxWidthPx,
    yPct: rectPx.topPx / boxHeightPx,
    wPct: rectPx.widthPx / boxWidthPx,
    hPct: rectPx.heightPx / boxHeightPx
  };
}

function applyRectPx(el, rectPx) {
  el.style.left = rectPx.leftPx + 'px';
  el.style.top = rectPx.topPx + 'px';
  el.style.width = rectPx.widthPx + 'px';
  el.style.height = rectPx.heightPx + 'px';
}

// ממיר שדה (אחוזים, מעוגן top-left) לקואורדינטות pdf-lib (נקודות, מקור bottom-left)
function pctFieldToPdfCoords(field, pageWidthPt, pageHeightPt) {
  const wPt = field.wPct * pageWidthPt;
  const hPt = field.hPct * pageHeightPt;
  const xPt = field.xPct * pageWidthPt;
  const yPt = pageHeightPt - (field.yPct * pageHeightPt) - hPt;
  return { xPt, yPt, wPt, hPt };
}

function isValidDateStr(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!m) return false;
  const day = +m[1], month = +m[2], year = +m[3];
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= new Date(year, month, 0).getDate();
}

function attachDateMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += '.' + digits.slice(2, 4);
    if (digits.length > 4) out += '.' + digits.slice(4, 8);
    input.value = out;
  });
}

// ─── רינדור טקסט עברי כתמונה (עוקף בעיות קידוד גופנים ב-PDF) ───
function renderTextToPngDataUrl(text, widthPt, heightPt, fontSizePt) {
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthPt * scale));
  canvas.height = Math.max(1, Math.round(heightPt * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.font = (fontSizePt || 12) + 'px Arial, "Noto Sans Hebrew", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#111';
  ctx.fillText(text, widthPt - 2, heightPt / 2, widthPt - 4);
  return canvas.toDataURL('image/png');
}

// ─── הטבעת שדות ב-PDF — resolveStamp(field) מחזיר {kind, value/checked/dataUrl} או null ───
async function flattenPdf(originalBytes, fields, resolveStamp) {
  const pdfDoc = await PDFLib.PDFDocument.load(originalBytes);
  for (const field of fields) {
    const stamp = resolveStamp(field);
    if (!stamp) continue;
    const page = pdfDoc.getPage(field.page);
    const coords = pctFieldToPdfCoords(field, page.getWidth(), page.getHeight());

    if (stamp.kind === 'text' && stamp.value) {
      const dataUrl = renderTextToPngDataUrl(stamp.value, coords.wPt, coords.hPt, field.fontSize || 12);
      const pngBytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = await pdfDoc.embedPng(pngBytes);
      page.drawImage(img, { x: coords.xPt, y: coords.yPt, width: coords.wPt, height: coords.hPt });
    } else if (stamp.kind === 'checkbox' && stamp.checked) {
      const pad = Math.min(coords.wPt, coords.hPt) * 0.18;
      const thickness = Math.max(1, Math.min(coords.wPt, coords.hPt) * 0.12);
      const color = PDFLib.rgb(0, 0, 0);
      page.drawLine({ start: { x: coords.xPt + pad, y: coords.yPt + pad }, end: { x: coords.xPt + coords.wPt - pad, y: coords.yPt + coords.hPt - pad }, thickness, color });
      page.drawLine({ start: { x: coords.xPt + coords.wPt - pad, y: coords.yPt + pad }, end: { x: coords.xPt + pad, y: coords.yPt + coords.hPt - pad }, thickness, color });
    } else if (stamp.kind === 'signature' && stamp.dataUrl) {
      const pngBytes = await (await fetch(stamp.dataUrl)).arrayBuffer();
      const img = await pdfDoc.embedPng(pngBytes);
      page.drawImage(img, { x: coords.xPt, y: coords.yPt, width: coords.wPt, height: coords.hPt });
    }
  }
  return pdfDoc.save();
}

// ─── לוח חתימה (עכבר + מגע, Pointer Events מאוחדים) ──────────────
function initSignaturePad(canvas) {
  canvas.style.touchAction = 'none';
  const ctx = canvas.getContext('2d');
  let hasDrawnFlag = false;
  let drawing = false;
  let lastX = 0, lastY = 0;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1a3fa1';

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    const p = pos(e);
    lastX = p.x; lastY = p.y;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
    hasDrawnFlag = true;
  });
  function stopDrawing(e) {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);
  canvas.addEventListener('pointerleave', stopDrawing);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      hasDrawnFlag = false;
    },
    hasDrawn() { return hasDrawnFlag; },
    getDataURL() { return canvas.toDataURL('image/png'); }
  };
}

// ─── SHA-256 hex, לאימות קוד OTP מול הגיבוב השמור ב-Firestore (ללא Cloud Function) ───
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
