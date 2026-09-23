let currentUser, currentRole, currentUserName, myDeptIds = [];
let departments = [];
let fieldDefs = [];
let employees = [];
let editingEmployeeId = null;
let photoDataUrl = null;
let currentEmployeeData = {};
let signTemplates = [];
let notifSettings = { birthdayDaysAhead: 14, contractEndDaysAhead: 60, customReminderDaysAhead: 30, overdueDays: 7 };

const MAX_PHOTO_BYTES = 250000; // raw file size cap before base64 encoding
const DEFAULT_AVATAR_32 = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%23e6e9ee'/%3E%3C/svg%3E";

init();

async function init() {
  const info = await requireRole(['superadmin', 'manager']);
  currentUser = info.user;
  currentRole = info.role;
  currentUserName = info.name;
  myDeptIds = info.departmentIds || [];

  renderWhoAmI();
  document.getElementById('logoutBtn').addEventListener('click', () => auth.signOut().then(() => location.href = 'login.html'));

  if (currentRole !== 'superadmin') {
    document.getElementById('usersTabBtn').style.display = 'none';
  } else {
    document.getElementById('templatesLinkBtn').style.display = 'block';
    document.getElementById('notifSettingsTabBtn').style.display = 'block';
    document.getElementById('bulkSendTabBtn').style.display = 'block';
  }
  document.getElementById('templatesLinkBtn').addEventListener('click', () => location.href = 'templates.html');

  wireNav();
  wireEmployeeModal();
  wireDepartmentsView();
  wireFieldsView();
  wireUsersView();
  wireSigningView();
  wireNotifications();
  wireNotifSettingsView();
  wireMfa();
  wireBulkSendView();

  await loadDepartments();
  await loadFieldDefs();
  await loadNotifSettings();
  if (currentRole === 'superadmin') await loadUsers();
  await loadEmployees();
  try { await loadTemplatesForSelect(); } catch (e) { console.error('loadTemplatesForSelect failed', e); }
  if (currentRole === 'superadmin') renderBulkSendView();
}

function currentUserLabel() {
  return currentUserName || currentUser.email;
}

function renderWhoAmI() {
  const roleLabel = currentRole === 'superadmin' ? 'מנהל-על' : 'מנהל מחלקה';
  const displayName = currentUserName || currentUser.email;
  const who = document.getElementById('whoAmI');
  who.innerHTML = `${escapeHtml(displayName)} (${roleLabel})`;
  if (currentRole === 'superadmin') {
    who.innerHTML += ` <a href="#" id="editMyNameLink" style="font-size:12px">${currentUserName ? 'עריכת שם' : 'קביעת שם תצוגה'}</a>`;
    document.getElementById('editMyNameLink').addEventListener('click', async (e) => {
      e.preventDefault();
      const name = prompt('שם מלא לתצוגה:', currentUserName || '');
      if (name === null || !name.trim()) return;
      await db.collection('users').doc(currentUser.uid).set({
        name: name.trim(), email: currentUser.email, role: 'superadmin', active: true, departmentIds: []
      }, { merge: true });
      currentUserName = name.trim();
      renderWhoAmI();
      if (currentRole === 'superadmin') await loadUsers();
    });
  }
}

function wireNav() {
  document.querySelectorAll('.tab-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');
      document.getElementById('view-' + btn.dataset.view).style.display = 'block';
    });
  });
}

/* ---------------- Departments ---------------- */

async function loadDepartments() {
  const snap = await db.collection('departments').orderBy('name').get();
  departments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderDeptFilterOptions();
  renderDeptSelectInModal();
  renderDeptManagementList();
}

function renderDeptFilterOptions() {
  const sel = document.getElementById('empDeptFilter');
  const visible = currentRole === 'superadmin' ? departments : departments.filter(d => myDeptIds.includes(d.id));
  sel.innerHTML = '<option value="">כל המחלקות</option>' +
    visible.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
}

function renderDeptSelectInModal() {
  const sel = document.getElementById('f_departmentId');
  const visible = currentRole === 'superadmin' ? departments : departments.filter(d => myDeptIds.includes(d.id));
  sel.innerHTML = visible.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
}

function renderDeptManagementList() {
  const ul = document.getElementById('deptList');
  if (currentRole !== 'superadmin') {
    ul.innerHTML = departments.map(d => `<li>${escapeHtml(d.name)}</li>`).join('') || '<li class="muted">אין מחלקות</li>';
    document.getElementById('addDeptBtn').style.display = 'none';
    document.getElementById('newDeptName').style.display = 'none';
    return;
  }
  ul.innerHTML = departments.map(d => `
    <li>
      <span>${escapeHtml(d.name)}</span>
      <button class="btn small danger" data-del-dept="${d.id}">מחיקה</button>
    </li>
  `).join('') || '<li class="muted">אין מחלקות עדיין</li>';

  ul.querySelectorAll('[data-del-dept]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('למחוק את המחלקה? עובדים המשויכים אליה לא יימחקו, אך יש לעדכן אותם ידנית.')) return;
      await db.collection('departments').doc(btn.dataset.delDept).delete();
      await loadDepartments();
    });
  });
}

function wireDepartmentsView() {
  document.getElementById('addDeptBtn').addEventListener('click', async () => {
    const input = document.getElementById('newDeptName');
    const name = input.value.trim();
    if (!name) return;
    await db.collection('departments').add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    input.value = '';
    await loadDepartments();
  });
}

/* ---------------- Custom field definitions ---------------- */

async function loadFieldDefs() {
  const snap = await db.collection('fieldDefs').orderBy('label').get();
  fieldDefs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderFieldDefList();
}

const CUSTOM_FIELD_TYPE_LABELS = { text: 'טקסט', number: 'מספר', date: 'תאריך', select: 'רשימה', checkbox: 'תיבת סימון' };

function renderFieldDefList() {
  const ul = document.getElementById('fieldDefList');
  ul.innerHTML = fieldDefs.map(f => `
    <li>
      <span>${escapeHtml(f.label)} <span class="muted">(${CUSTOM_FIELD_TYPE_LABELS[f.type] || f.type})</span></span>
      ${currentRole === 'superadmin' ? `<button class="btn small danger" data-del-field="${f.id}">מחיקה</button>` : ''}
    </li>
  `).join('') || '<li class="muted">אין שדות מותאמים עדיין</li>';

  if (currentRole !== 'superadmin') {
    document.getElementById('newFieldLabel').style.display = 'none';
    document.getElementById('newFieldType').style.display = 'none';
    document.getElementById('newFieldOptions').style.display = 'none';
    document.getElementById('addFieldBtn').style.display = 'none';
  }

  ul.querySelectorAll('[data-del-field]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('למחוק את השדה? ערכים קיימים בתיקי עובדים יישארו אך לא יוצגו יותר.')) return;
      await db.collection('fieldDefs').doc(btn.dataset.delField).delete();
      await loadFieldDefs();
    });
  });
}

function wireFieldsView() {
  document.getElementById('addFieldBtn').addEventListener('click', async () => {
    const label = document.getElementById('newFieldLabel').value.trim();
    const type = document.getElementById('newFieldType').value;
    const optionsRaw = document.getElementById('newFieldOptions').value.trim();
    if (!label) return;
    const doc = { label, type, active: true, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (type === 'select') doc.options = optionsRaw.split(',').map(s => s.trim()).filter(Boolean);
    await db.collection('fieldDefs').add(doc);
    document.getElementById('newFieldLabel').value = '';
    document.getElementById('newFieldOptions').value = '';
    await loadFieldDefs();
  });
}

function renderCustomFieldsInModal(values) {
  values = values || {};
  const container = document.getElementById('customFieldsContainer');
  if (!fieldDefs.length) {
    container.innerHTML = '<p class="muted">לא הוגדרו שדות מותאמים אישית (ניתן להגדיר בלשונית "שדות מותאמים אישית").</p>';
    return;
  }
  container.innerHTML = fieldDefs.filter(f => f.active !== false).map(f => {
    const val = values[f.id];
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${escapeHtml(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
      return `<div class="field"><label>${escapeHtml(f.label)}</label><select data-cf="${f.id}"><option value="">-</option>${opts}</select></div>`;
    }
    if (f.type === 'checkbox') {
      return `<div class="field"><label><input type="checkbox" style="width:auto" data-cf="${f.id}" ${val ? 'checked' : ''}> ${escapeHtml(f.label)}</label></div>`;
    }
    const inputType = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    return `<div class="field"><label>${escapeHtml(f.label)}</label><input type="${inputType}" data-cf="${f.id}" value="${val != null ? escapeHtml(String(val)) : ''}"></div>`;
  }).join('');
}

function collectCustomFieldValues() {
  const result = {};
  document.querySelectorAll('#customFieldsContainer [data-cf]').forEach(el => {
    const id = el.dataset.cf;
    if (el.type === 'checkbox') result[id] = el.checked;
    else if (el.value !== '') result[id] = el.type === 'number' ? Number(el.value) : el.value;
  });
  return result;
}

/* ---------------- Admin/manager users (superadmin only) ---------------- */

async function loadUsers() {
  const snap = await db.collection('users').orderBy('email').get();
  const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const ul = document.getElementById('userList');
  ul.innerHTML = users.map(u => `
    <li>
      <span>
        ${escapeHtml(u.name || u.email)} ${u.id === currentUser.uid ? '<span class="muted">(את/ה)</span>' : ''}
        <span class="badge ${u.active ? 'active' : 'terminated'}">${u.active ? 'פעיל' : 'מושבת'}</span>
        <span class="muted">${u.role === 'superadmin' ? 'מנהל-על' : 'מנהל מחלקה'}</span>
        ${u.role === 'manager' ? `<span class="muted"> · ${(u.departmentIds || []).map(id => escapeHtml(deptName(id))).join(', ') || 'ללא מחלקות'}</span>` : ''}
      </span>
      <span>
        <button class="btn small" data-edit-name="${u.id}">שם</button>
        ${u.role === 'manager' ? `<button class="btn small" data-edit-depts="${u.id}">מחלקות</button>` : ''}
        ${u.id !== currentUser.uid ? `<button class="btn small" data-toggle-user="${u.id}" data-active="${u.active}">${u.active ? 'השבתה' : 'הפעלה'}</button>` : ''}
      </span>
    </li>
  `).join('') || '<li class="muted">אין משתמשי מערכת נוספים</li>';

  ul.querySelectorAll('[data-toggle-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === 'true';
      await db.collection('users').doc(btn.dataset.toggleUser).update({ active: !active });
      await loadUsers();
    });
  });
  ul.querySelectorAll('[data-edit-name]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = users.find(x => x.id === btn.dataset.editName);
      const name = prompt('שם מלא לתצוגה:', u.name || '');
      if (name === null || !name.trim()) return;
      await db.collection('users').doc(btn.dataset.editName).update({ name: name.trim() });
      if (btn.dataset.editName === currentUser.uid) { currentUserName = name.trim(); renderWhoAmI(); }
      await loadUsers();
    });
  });
  ul.querySelectorAll('[data-edit-depts]').forEach(btn => {
    btn.addEventListener('click', () => editManagerDepartments(btn.dataset.editDepts));
  });
}

function deptName(id) {
  const d = departments.find(x => x.id === id);
  return d ? d.name : id;
}

async function editManagerDepartments(uid) {
  const current = (await db.collection('users').doc(uid).get()).data();
  const names = departments.map((d, i) => `${i + 1}. ${d.name}`).join('\n');
  const input = prompt(`בחר מספרי מחלקות (מופרדים בפסיק):\n${names}`, (current.departmentIds || []).map(id => departments.findIndex(d => d.id === id) + 1).filter(n => n > 0).join(','));
  if (input === null) return;
  const idxs = input.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= departments.length);
  const departmentIds = idxs.map(i => departments[i - 1].id);
  await db.collection('users').doc(uid).update({ departmentIds });
  await loadUsers();
}

function wireUsersView() {
  document.getElementById('addUserBtn').addEventListener('click', async () => {
    const name = document.getElementById('newUserName').value.trim();
    const email = document.getElementById('newUserEmail').value.trim();
    const role = document.getElementById('newUserRole').value;
    if (!name || !email) { alert('יש להזין שם מלא ואימייל.'); return; }
    const tempPassword = Math.random().toString(36).slice(2) + 'A1!';
    try {
      const secAuth = withSecondaryAuth();
      const cred = await secAuth.createUserWithEmailAndPassword(email, tempPassword);
      await db.collection('users').doc(cred.user.uid).set({
        name, email, role, active: true, departmentIds: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUserLabel()
      });
      // Sent up front (not just a password-reset email) so this user's email is
      // already verified whenever they later want to enable MFA - Identity
      // Platform refuses second-factor enrollment on an unverified email.
      await cred.user.sendEmailVerification();
      await secAuth.sendPasswordResetEmail(email);
      await secAuth.signOut();
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserEmail').value = '';
      await loadUsers();
      alert('המשתמש נוצר, ונשלח אליו אימייל לקביעת סיסמה ואימייל לאימות הכתובת.');
    } catch (e) {
      alert('שגיאה ביצירת המשתמש: ' + e.message);
    }
  });
}

/* ---------------- Employees ---------------- */

async function loadEmployees() {
  let query = db.collection('employees');
  if (currentRole === 'manager') {
    if (!myDeptIds.length) { employees = []; renderEmployeesTable(); return; }
    query = query.where('departmentId', 'in', myDeptIds.slice(0, 10));
  }
  const snap = await query.get();
  employees = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderEmployeesTable();
  renderNotifications();
}

/* ---- notifications bell: birthdays, contract-end dates, custom reminders ---- */

async function loadNotifSettings() {
  const doc = await db.collection('settings').doc('notifications').get();
  if (doc.exists) notifSettings = { ...notifSettings, ...doc.data() };
  if (document.getElementById('ns_birthday')) {
    document.getElementById('ns_birthday').value = notifSettings.birthdayDaysAhead;
    document.getElementById('ns_contractEnd').value = notifSettings.contractEndDaysAhead;
    document.getElementById('ns_custom').value = notifSettings.customReminderDaysAhead;
    document.getElementById('ns_overdue').value = notifSettings.overdueDays;
  }
}

function wireNotifSettingsView() {
  document.getElementById('saveNotifSettingsBtn').addEventListener('click', async () => {
    const hint = document.getElementById('notifSettingsHint');
    notifSettings = {
      birthdayDaysAhead: Math.max(0, Number(document.getElementById('ns_birthday').value) || 0),
      contractEndDaysAhead: Math.max(0, Number(document.getElementById('ns_contractEnd').value) || 0),
      customReminderDaysAhead: Math.max(0, Number(document.getElementById('ns_custom').value) || 0),
      overdueDays: Math.max(0, Number(document.getElementById('ns_overdue').value) || 0)
    };
    try {
      await db.collection('settings').doc('notifications').set({
        ...notifSettings, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: currentUserLabel()
      });
      hint.textContent = 'נשמר בהצלחה.';
      renderNotifications();
    } catch (e) {
      hint.textContent = 'שגיאה בשמירה: ' + e.message;
    }
  });
}

function todayYmd() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

// Returns days-until (negative = already passed, within notifSettings.overdueDays)
// for the next occurrence of a stored "YYYY-MM-DD" date, or null if outside the
// [ -overdueDays, +daysAhead ] window. recurring=true treats it as an annual
// month/day event (like a birthday); recurring=false treats it as a fixed date.
function daysUntilOccurrence(isoDate, recurring, daysAhead) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return null;
  const overdueDays = notifSettings.overdueDays;
  const today = todayYmd();
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  const month = Number(m[2]), day = Number(m[3]);

  let occYear = recurring ? today.y : Number(m[1]);
  let occMs = Date.UTC(occYear, month - 1, day);
  let daysUntil = Math.round((occMs - todayMs) / 86400000);

  if (recurring && daysUntil < -overdueDays) {
    occMs = Date.UTC(occYear + 1, month - 1, day);
    daysUntil = Math.round((occMs - todayMs) / 86400000);
  }

  if (daysUntil < -overdueDays || daysUntil > daysAhead) return null;
  return daysUntil;
}

function computeNotifications() {
  const items = [];
  employees.forEach(emp => {
    if (emp.status === 'terminated') return;
    const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();

    const bday = daysUntilOccurrence(emp.birthDate, true, notifSettings.birthdayDaysAhead);
    if (bday !== null) items.push({ employeeId: emp.id, title: `יום הולדת - ${name}`, daysUntil: bday });

    const contractEnd = daysUntilOccurrence(emp.contractEndDate, false, notifSettings.contractEndDaysAhead);
    if (contractEnd !== null) items.push({ employeeId: emp.id, title: `סיום הסכם עבודה - ${name}`, daysUntil: contractEnd });

    (emp.customReminders || []).forEach(r => {
      const d = daysUntilOccurrence(r.date, !!r.recurring, notifSettings.customReminderDaysAhead);
      if (d !== null) items.push({ employeeId: emp.id, title: `${r.title} - ${name}`, daysUntil: d });
    });
  });
  items.sort((a, b) => a.daysUntil - b.daysUntil);
  return items;
}

function renderNotifications() {
  const items = computeNotifications();
  const countEl = document.getElementById('notifCount');
  countEl.textContent = String(items.length);
  countEl.style.display = items.length ? 'inline-block' : 'none';

  const listEl = document.getElementById('notifList');
  listEl.innerHTML = items.map(item => {
    const overdue = item.daysUntil < 0;
    const dateLabel = overdue ? `עבר לפני ${-item.daysUntil} ימים` : (item.daysUntil === 0 ? 'היום' : `בעוד ${item.daysUntil} ימים`);
    return `<li class="notif-item${overdue ? ' overdue' : ''}" data-notif-emp="${item.employeeId}">
      <span>${escapeHtml(item.title)}<br><span class="notif-date">${dateLabel}</span></span>
    </li>`;
  }).join('') || '<li class="muted">אין התראות קרובות</li>';

  listEl.querySelectorAll('[data-notif-emp]').forEach(li => {
    li.addEventListener('click', () => {
      document.getElementById('notifPanel').style.display = 'none';
      document.querySelector('.tab-btn[data-view="employees"]').click();
      openEmployeeModal(li.dataset.notifEmp);
    });
  });
}

function wireNotifications() {
  const btn = document.getElementById('notifBellBtn');
  const panel = document.getElementById('notifPanel');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== btn) {
      panel.style.display = 'none';
    }
  });
}

/* ---- MFA (two-factor, email-code based - see mfaEmailSecrets/mfaEmailChallenges
   in firestore.rules for why this is custom rather than Firebase's native
   phone MFA) ---- */

let mfaEmailEnabled = false;

function wireMfa() {
  document.getElementById('mfaOpenBtn').addEventListener('click', openMfaModal);
  document.getElementById('closeMfaModalBtn').addEventListener('click', closeMfaModal);
  document.getElementById('mfaSendTestCodeBtn').addEventListener('click', sendMfaTestCode);
  document.getElementById('mfaVerifyCodeBtn').addEventListener('click', verifyAndEnableMfa);
  document.getElementById('mfaDisableBtn').addEventListener('click', disableMfa);
}

async function openMfaModal() {
  document.getElementById('mfaModalBackdrop').style.display = 'flex';
  document.getElementById('mfaHint').textContent = '';
  document.getElementById('mfa_code').value = '';
  document.getElementById('mfaNotConfiguredBlock').style.display = 'none';
  document.getElementById('mfaEnabledBlock').style.display = 'none';
  document.getElementById('mfaSetupStart').style.display = 'none';
  document.getElementById('mfaSetupVerify').style.display = 'none';

  const userDoc = await db.collection('users').doc(currentUser.uid).get();
  mfaEmailEnabled = userDoc.exists && userDoc.data().mfaEmailEnabled === true;

  if (mfaEmailEnabled) {
    document.getElementById('mfaEnabledBlock').style.display = 'block';
  } else if (!emailJsConfigured()) {
    document.getElementById('mfaNotConfiguredBlock').style.display = 'block';
  } else {
    document.getElementById('mfaSetupStart').style.display = 'block';
  }
}

function closeMfaModal() {
  document.getElementById('mfaModalBackdrop').style.display = 'none';
}

async function sendMfaTestCode() {
  const hint = document.getElementById('mfaHint');
  hint.style.color = '';
  hint.textContent = 'שולח...';
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const otpCodeHash = await sha256Hex(code);
    await db.collection('mfaEmailSecrets').doc(currentUser.uid).set({ otpCodeHash });
    await db.collection('mfaEmailChallenges').doc(currentUser.uid).set({
      otpAttempts: 0, verified: false, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const emailed = await sendSigningEmail({
      to_email: currentUser.email, to_name: currentUserLabel(),
      subject: 'קוד לבדיקת אימות דו-שלבי', link: '', otp_code: code
    });
    if (!emailed) {
      hint.textContent = 'שליחת האימייל נכשלה - יש לוודא ש-EmailJS מוגדר נכון.';
      return;
    }
    document.getElementById('mfaSetupStart').style.display = 'none';
    document.getElementById('mfaSetupVerify').style.display = 'block';
    hint.textContent = 'קוד נשלח לאימייל שלך. נא להזין אותו למטה.';
  } catch (e) {
    hint.textContent = 'שגיאה בשליחת הקוד: ' + e.message;
  }
}

async function verifyAndEnableMfa() {
  const hint = document.getElementById('mfaHint');
  const code = document.getElementById('mfa_code').value.trim();
  if (!/^\d{6}$/.test(code)) { hint.textContent = 'יש להזין קוד בן 6 ספרות.'; return; }

  const attemptHash = await sha256Hex(code);
  const challengeRef = db.collection('mfaEmailChallenges').doc(currentUser.uid);
  try {
    await challengeRef.update({ otpAttempts: firebase.firestore.FieldValue.increment(1), verified: true, attemptHash });
  } catch (e) {
    try {
      await challengeRef.update({ otpAttempts: firebase.firestore.FieldValue.increment(1), verified: false, attemptHash });
    } catch (e2) { /* attempts exhausted */ }
  }

  const fresh = await challengeRef.get();
  if (fresh.exists && fresh.data().verified) {
    await db.collection('users').doc(currentUser.uid).set({ mfaEmailEnabled: true }, { merge: true });
    hint.style.color = 'var(--success)';
    hint.textContent = 'אימות דו-שלבי הופעל בהצלחה.';
    openMfaModal();
  } else {
    hint.style.color = '';
    hint.textContent = 'קוד שגוי.' + (fresh.exists && fresh.data().otpAttempts >= 5 ? ' יותר מדי ניסיונות - יש לפתוח את החלון מחדש כדי לשלוח קוד חדש.' : '');
  }
}

async function disableMfa() {
  if (!confirm('לבטל אימות דו-שלבי? מעתה תוכל/י להתחבר עם סיסמה בלבד.')) return;
  await db.collection('users').doc(currentUser.uid).set({ mfaEmailEnabled: false }, { merge: true });
  openMfaModal();
}

function renderEmployeesTable() {
  const search = document.getElementById('empSearch').value.trim().toLowerCase();
  const deptFilter = document.getElementById('empDeptFilter').value;
  const statusFilter = document.getElementById('empStatusFilter').value;

  const filtered = employees.filter(e => {
    if (deptFilter && e.departmentId !== deptFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    if (search) {
      const hay = `${e.firstName || ''} ${e.lastName || ''} ${e.idNumber || ''} ${e.employeeNumber || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById('employeesTbody');
  tbody.innerHTML = filtered.map(e => `
    <tr>
      <td><img class="photo-preview" style="width:32px;height:32px" src="${e.photoDataUrl || DEFAULT_AVATAR_32}"></td>
      <td>${escapeHtml(e.employeeNumber || '')}</td>
      <td>${escapeHtml((e.firstName || '') + ' ' + (e.lastName || ''))}</td>
      <td>${escapeHtml(e.idNumber || '')}</td>
      <td>${escapeHtml(e.position || '')}</td>
      <td>${escapeHtml(deptName(e.departmentId))}</td>
      <td><span class="badge ${e.status === 'terminated' ? 'terminated' : 'active'}">${e.status === 'terminated' ? 'לא פעיל' : 'פעיל'}</span></td>
      <td><button class="btn small" data-open-emp="${e.id}">פתיחה</button></td>
    </tr>
  `).join('');
  document.getElementById('employeesEmpty').style.display = filtered.length ? 'none' : 'block';

  tbody.querySelectorAll('[data-open-emp]').forEach(btn => {
    btn.addEventListener('click', () => openEmployeeModal(btn.dataset.openEmp));
  });
}

document.getElementById('empSearch').addEventListener('input', renderEmployeesTable);
document.getElementById('empDeptFilter').addEventListener('change', renderEmployeesTable);
document.getElementById('empStatusFilter').addEventListener('change', renderEmployeesTable);
document.getElementById('addEmployeeBtn').addEventListener('click', () => openEmployeeModal(null));
document.getElementById('seedDemoEmployeeBtn').addEventListener('click', seedDemoEmployee);

async function seedDemoEmployee() {
  const btn = document.getElementById('seedDemoEmployeeBtn');
  btn.disabled = true;
  try {
    let departmentId = departments[0] && departments[0].id;
    if (!departmentId) {
      const deptRef = await db.collection('departments').add({ name: 'כללי', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      departmentId = deptRef.id;
      await loadDepartments();
    }

    const empRef = await db.collection('employees').add({
      firstName: 'ישראל', lastName: 'ישראלי',
      idNumber: '123456782', birthDate: '1985-06-15',
      phone: '050-1234567', email: 'israel.israeli@example.com',
      address: 'הרצל 12, תל אביב',
      position: 'טכנאי תחזוקה', departmentId,
      managerName: 'דוד כהן', status: 'active', startDate: '2023-01-01', endDate: '',
      customFields: {},
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUserLabel(),
      portalActive: false
    });

    await empRef.collection('equipment').add({
      name: 'מחשב נייד Dell Latitude', date: '2023-01-02', notes: 'מספר סידורי DL-4471',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await empRef.collection('trainings').add({
      name: 'בטיחות בעבודה', date: '2023-01-10', expiry: '2026-01-10',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await empRef.collection('notes').add({
      text: 'עובד לדוגמה שנוצר להמחשת המערכת.', authorEmail: currentUserLabel(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    await loadEmployees();
    await openEmployeeModal(empRef.id);
  } catch (e) {
    alert('שגיאה ביצירת העובד לדוגמה: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function wireEmployeeModal() {
  document.querySelectorAll('.emp-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.emp-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.modal-pane').forEach(p => p.classList.remove('active'));
      document.querySelector(`.modal-pane[data-pane="${btn.dataset.pane}"]`).classList.add('active');
    });
  });

  document.getElementById('closeEmployeeModalBtn').addEventListener('click', closeEmployeeModal);
  document.getElementById('saveEmployeeBtn').addEventListener('click', saveEmployee);
  document.getElementById('deleteEmployeeBtn').addEventListener('click', deleteEmployee);

  document.getElementById('photoInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) { alert('התמונה גדולה מדי (מקסימום 250KB).'); e.target.value = ''; return; }
    photoDataUrl = await fileToDataUrl(file);
    document.getElementById('photoPreview').src = photoDataUrl;
  });

  document.getElementById('addEquipmentBtn').addEventListener('click', addEquipmentItem);
  document.getElementById('addTrainingBtn').addEventListener('click', addTrainingItem);
  document.getElementById('addNoteBtn').addEventListener('click', addNoteItem);
  document.getElementById('uploadDocumentBtn').addEventListener('click', uploadDocument);
  document.getElementById('addReminderBtn').addEventListener('click', addReminder);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function openEmployeeModal(employeeId) {
  editingEmployeeId = employeeId;
  photoDataUrl = null;
  document.getElementById('employeeModalBackdrop').style.display = 'flex';
  document.querySelectorAll('.emp-tab-btn')[0].click();
  document.getElementById('deleteEmployeeBtn').style.display = employeeId && currentRole === 'superadmin' ? 'inline-block' : 'none';

  let data = {};
  if (employeeId) {
    document.getElementById('employeeModalTitle').textContent = 'עריכת עובד';
    const doc = await db.collection('employees').doc(employeeId).get();
    data = doc.data();
  } else {
    document.getElementById('employeeModalTitle').textContent = 'עובד חדש';
  }

  document.getElementById('f_firstName').value = data.firstName || '';
  document.getElementById('f_lastName').value = data.lastName || '';
  document.getElementById('f_idNumber').value = data.idNumber || '';
  document.getElementById('f_birthDate').value = data.birthDate || '';
  document.getElementById('f_phone').value = data.phone || '';
  document.getElementById('f_email').value = data.email || '';
  document.getElementById('f_address').value = data.address || '';
  document.getElementById('f_employeeNumber').value = data.employeeNumber || '';
  document.getElementById('f_position').value = data.position || '';
  document.getElementById('f_departmentId').value = data.departmentId || (departments[0] && departments[0].id) || '';
  document.getElementById('f_managerName').value = data.managerName || '';
  document.getElementById('f_status').value = data.status || 'active';
  document.getElementById('f_startDate').value = data.startDate || '';
  document.getElementById('f_endDate').value = data.endDate || '';
  document.getElementById('f_contractEndDate').value = data.contractEndDate || '';
  document.getElementById('photoPreview').src = data.photoDataUrl || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'90\' height=\'90\'%3E%3Crect width=\'90\' height=\'90\' fill=\'%23e6e9ee\'/%3E%3C/svg%3E';

  renderCustomFieldsInModal(data.customFields);
  renderPortalStatus(employeeId, data);
  renderRemindersList(data.customReminders || []);

  currentEmployeeData = data;
  document.getElementById('signRecipientEmail').value = data.email || '';

  if (employeeId) {
    await loadSubItems(employeeId, 'equipment', 'equipmentList', renderEquipmentLi);
    await loadSubItems(employeeId, 'trainings', 'trainingsList', renderTrainingLi);
    await loadSubItems(employeeId, 'notes', 'notesList', renderNoteLi);
    await loadDocuments(employeeId);
    try { await loadSigningRequests(employeeId); } catch (e) { console.error('loadSigningRequests failed', e); }
  } else {
    document.getElementById('equipmentList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('trainingsList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('notesList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('documentsList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('signingRequestsList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
  }
}

function closeEmployeeModal() {
  document.getElementById('employeeModalBackdrop').style.display = 'none';
  editingEmployeeId = null;
}

async function saveEmployee() {
  const departmentId = document.getElementById('f_departmentId').value;
  if (!departmentId) { alert('יש לבחור מחלקה / סניף.'); return; }

  const payload = {
    firstName: document.getElementById('f_firstName').value.trim(),
    lastName: document.getElementById('f_lastName').value.trim(),
    idNumber: document.getElementById('f_idNumber').value.trim(),
    birthDate: document.getElementById('f_birthDate').value,
    phone: document.getElementById('f_phone').value.trim(),
    email: document.getElementById('f_email').value.trim(),
    address: document.getElementById('f_address').value.trim(),
    employeeNumber: document.getElementById('f_employeeNumber').value.trim(),
    position: document.getElementById('f_position').value.trim(),
    departmentId,
    managerName: document.getElementById('f_managerName').value.trim(),
    status: document.getElementById('f_status').value,
    startDate: document.getElementById('f_startDate').value,
    endDate: document.getElementById('f_endDate').value,
    contractEndDate: document.getElementById('f_contractEndDate').value,
    customFields: collectCustomFieldValues(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (photoDataUrl) payload.photoDataUrl = photoDataUrl;

  try {
    if (editingEmployeeId) {
      await db.collection('employees').doc(editingEmployeeId).update(payload);
    } else {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      payload.createdBy = currentUserLabel();
      payload.portalActive = false;
      const ref = await db.collection('employees').add(payload);
      editingEmployeeId = ref.id;
    }
    await loadEmployees();
    await openEmployeeModal(editingEmployeeId); // refresh (unlocks equipment/trainings/notes tabs for new records)
  } catch (e) {
    alert('שגיאה בשמירה: ' + e.message);
  }
}

async function deleteEmployee() {
  if (!editingEmployeeId) return;
  if (!confirm('למחוק את תיק העובד לצמיתות? פעולה זו אינה הפיכה.')) return;
  await db.collection('employees').doc(editingEmployeeId).delete();
  closeEmployeeModal();
  await loadEmployees();
}

/* ---- equipment / trainings / notes subcollections ---- */

async function loadSubItems(employeeId, coll, listElId, renderFn) {
  const snap = await db.collection('employees').doc(employeeId).collection(coll).orderBy('createdAt', 'desc').get();
  const ul = document.getElementById(listElId);
  ul.innerHTML = snap.docs.map(d => renderFn(d.id, d.data())).join('') || '<li class="muted">אין רשומות</li>';
  ul.querySelectorAll('[data-del-sub]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.collection('employees').doc(employeeId).collection(coll).doc(btn.dataset.delSub).delete();
      await loadSubItems(employeeId, coll, listElId, renderFn);
    });
  });
}

function renderEquipmentLi(id, d) {
  return `<li><span>${escapeHtml(d.name)} ${d.date ? '· ' + escapeHtml(d.date) : ''} ${d.notes ? '· ' + escapeHtml(d.notes) : ''}</span><button class="btn small danger" data-del-sub="${id}">מחיקה</button></li>`;
}
function renderTrainingLi(id, d) {
  return `<li><span>${escapeHtml(d.name)} ${d.date ? '· ' + escapeHtml(d.date) : ''} ${d.expiry ? '· בתוקף עד ' + escapeHtml(d.expiry) : ''}</span><button class="btn small danger" data-del-sub="${id}">מחיקה</button></li>`;
}
function renderNoteLi(id, d) {
  return `<li><span>${escapeHtml(d.text)} <span class="muted">— ${escapeHtml(d.authorEmail || '')}</span></span><button class="btn small danger" data-del-sub="${id}">מחיקה</button></li>`;
}

async function addEquipmentItem() {
  if (!editingEmployeeId) return;
  const name = document.getElementById('eq_name').value.trim();
  if (!name) return;
  await db.collection('employees').doc(editingEmployeeId).collection('equipment').add({
    name, date: document.getElementById('eq_date').value, notes: document.getElementById('eq_notes').value.trim(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  document.getElementById('eq_name').value = ''; document.getElementById('eq_date').value = ''; document.getElementById('eq_notes').value = '';
  await loadSubItems(editingEmployeeId, 'equipment', 'equipmentList', renderEquipmentLi);
}

async function addTrainingItem() {
  if (!editingEmployeeId) return;
  const name = document.getElementById('tr_name').value.trim();
  if (!name) return;
  await db.collection('employees').doc(editingEmployeeId).collection('trainings').add({
    name, date: document.getElementById('tr_date').value, expiry: document.getElementById('tr_expiry').value,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  document.getElementById('tr_name').value = ''; document.getElementById('tr_date').value = ''; document.getElementById('tr_expiry').value = '';
  await loadSubItems(editingEmployeeId, 'trainings', 'trainingsList', renderTrainingLi);
}

async function addNoteItem() {
  if (!editingEmployeeId) return;
  const text = document.getElementById('noteText').value.trim();
  if (!text) return;
  await db.collection('employees').doc(editingEmployeeId).collection('notes').add({
    text, authorEmail: currentUserLabel(), createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  document.getElementById('noteText').value = '';
  await loadSubItems(editingEmployeeId, 'notes', 'notesList', renderNoteLi);
}

/* ---- custom reminders (raises/bonuses/etc, feeds the notifications bell) ---- */

function renderRemindersList(reminders) {
  const ul = document.getElementById('remindersList');
  if (!editingEmployeeId) { ul.innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>'; return; }
  ul.innerHTML = reminders.map(r => `
    <li>
      <span>${escapeHtml(r.title)} <span class="muted">· ${r.date}${r.recurring ? ' · חוזר מדי שנה' : ''}</span></span>
      <button class="btn small danger" data-del-reminder="${r.id}">מחיקה</button>
    </li>
  `).join('') || '<li class="muted">אין תזכורות</li>';

  ul.querySelectorAll('[data-del-reminder]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const remaining = (currentEmployeeData.customReminders || []).filter(r => r.id !== btn.dataset.delReminder);
      await db.collection('employees').doc(editingEmployeeId).update({ customReminders: remaining });
      currentEmployeeData.customReminders = remaining;
      renderRemindersList(remaining);
    });
  });
}

async function addReminder() {
  if (!editingEmployeeId) return;
  const title = document.getElementById('rm_title').value.trim();
  const date = document.getElementById('rm_date').value;
  const recurring = document.getElementById('rm_recurring').checked;
  if (!title || !date) return;

  const reminders = [...(currentEmployeeData.customReminders || []), { id: newId(), title, date, recurring }];
  await db.collection('employees').doc(editingEmployeeId).update({ customReminders: reminders });
  currentEmployeeData.customReminders = reminders;
  document.getElementById('rm_title').value = '';
  document.getElementById('rm_date').value = '';
  document.getElementById('rm_recurring').checked = false;
  renderRemindersList(reminders);
}

/* ---- documents ---- */

const MAX_DOCUMENT_BYTES = 14 * 1024 * 1024; // matches storage.rules cap (15MB), with headroom

async function loadDocuments(employeeId) {
  const snap = await db.collection('employees').doc(employeeId).collection('documents').orderBy('uploadedAt', 'desc').get();
  const ul = document.getElementById('documentsList');
  ul.innerHTML = snap.docs.map(d => {
    const doc = d.data();
    return `<li>
      <span>${escapeHtml(doc.name)} <span class="muted">${doc.uploadedAt ? '· ' + fmtDate(doc.uploadedAt) : ''}${doc.uploadedBy ? ' · ' + escapeHtml(doc.uploadedBy) : ''}</span></span>
      <span>
        <button class="btn small" data-view-doc="${d.id}">צפייה / הורדה</button>
        <button class="btn small danger" data-del-doc="${d.id}">מחיקה</button>
      </span>
    </li>`;
  }).join('') || '<li class="muted">אין מסמכים עדיין</li>';

  ul.querySelectorAll('[data-view-doc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const doc = (await db.collection('employees').doc(employeeId).collection('documents').doc(btn.dataset.viewDoc).get()).data();
      const url = await storage.ref(doc.storagePath).getDownloadURL();
      window.open(url, '_blank');
    });
  });
  ul.querySelectorAll('[data-del-doc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('למחוק את המסמך לצמיתות?')) return;
      const ref = db.collection('employees').doc(employeeId).collection('documents').doc(btn.dataset.delDoc);
      const doc = (await ref.get()).data();
      await storage.ref(doc.storagePath).delete().catch(() => {});
      await ref.delete();
      await loadDocuments(employeeId);
    });
  });
}

async function uploadDocument() {
  if (!editingEmployeeId) return;
  const name = document.getElementById('doc_name').value.trim();
  const file = document.getElementById('doc_file').files[0];
  const hint = document.getElementById('uploadDocumentHint');
  if (!name || !file) { hint.textContent = 'יש להזין שם ולבחור קובץ.'; return; }
  if (file.size > MAX_DOCUMENT_BYTES) { hint.textContent = 'הקובץ גדול מדי (מקסימום 14MB).'; return; }

  hint.textContent = 'מעלה...';
  try {
    const docRef = db.collection('employees').doc(editingEmployeeId).collection('documents').doc();
    const storagePath = `documents/${editingEmployeeId}/${docRef.id}_${file.name}`;
    await storage.ref(storagePath).put(file);
    await docRef.set({
      name, storagePath, contentType: file.type, sizeBytes: file.size,
      uploadedAt: firebase.firestore.FieldValue.serverTimestamp(), uploadedBy: currentUserLabel()
    });
    document.getElementById('doc_name').value = '';
    document.getElementById('doc_file').value = '';
    hint.textContent = '';
    await loadDocuments(editingEmployeeId);
  } catch (e) {
    hint.textContent = 'שגיאה בהעלאה: ' + e.message;
  }
}

/* ---- signing requests (PDFSign-derived e-signature flow) ---- */

async function loadTemplatesForSelect() {
  const snap = await db.collection('templates').where('active', '==', true).orderBy('name').get();
  signTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  document.getElementById('signTemplateSelect').innerHTML =
    '<option value="">-- בחירת תבנית --</option>' +
    signTemplates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  document.getElementById('bulkTemplateSelect').innerHTML =
    '<option value="">-- בחירת תבנית --</option>' +
    // Bulk-send only makes sense for single-mode templates (each selected
    // employee gets their own independent link) - matches PDFSign's own
    // "bulk invite is single-mode only" gating.
    signTemplates.filter(t => t.mode !== 'multiSign').map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}

/* ---- bulk send: one template -> many employees at once ---- */

function wireBulkSendView() {
  document.getElementById('bulkTemplateSelect').addEventListener('change', renderBulkSendView);
  document.getElementById('bulkDeptFilter').addEventListener('change', renderBulkEmployeesList);
  document.getElementById('bulkSelectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#bulkEmployeesList input[type=checkbox]').forEach(cb => cb.checked = true);
  });
  document.getElementById('bulkSelectNoneBtn').addEventListener('click', () => {
    document.querySelectorAll('#bulkEmployeesList input[type=checkbox]').forEach(cb => cb.checked = false);
  });
  document.getElementById('bulkSendBtn').addEventListener('click', bulkSend);
}

function renderBulkSendView() {
  const sel = document.getElementById('bulkDeptFilter');
  const visibleDepts = currentRole === 'superadmin' ? departments : departments.filter(d => myDeptIds.includes(d.id));
  sel.innerHTML = '<option value="">כל המחלקות</option>' +
    visibleDepts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  renderBulkEmployeesList();
}

function renderBulkEmployeesList() {
  const deptFilter = document.getElementById('bulkDeptFilter').value;
  const list = employees.filter(e => e.status === 'active' && (!deptFilter || e.departmentId === deptFilter) && e.email);
  const ul = document.getElementById('bulkEmployeesList');
  ul.innerHTML = list.map(e => `
    <li>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" data-emp-id="${e.id}" style="width:auto">
        ${escapeHtml((e.firstName || '') + ' ' + (e.lastName || ''))}
        <span class="muted">· ${escapeHtml(deptName(e.departmentId))} · ${escapeHtml(e.email)}</span>
      </label>
    </li>
  `).join('') || '<li class="muted">אין עובדים פעילים עם כתובת אימייל התואמים לסינון</li>';
}

async function bulkSend() {
  const hint = document.getElementById('bulkSendHint');
  const resultsEl = document.getElementById('bulkSendResults');
  const templateId = document.getElementById('bulkTemplateSelect').value;
  if (!templateId) { hint.textContent = 'יש לבחור תבנית.'; return; }
  const template = signTemplates.find(t => t.id === templateId);
  const selectedIds = Array.from(document.querySelectorAll('#bulkEmployeesList input:checked')).map(cb => cb.dataset.empId);
  if (!selectedIds.length) { hint.textContent = 'יש לבחור לפחות עובד אחד.'; return; }

  const existingCount = await countTemplateSubmissions(templateId);
  if (existingCount + selectedIds.length > MAX_SUBMISSIONS_PER_TEMPLATE) {
    hint.textContent = `שליחה זו תחרוג ממכסת ${MAX_SUBMISSIONS_PER_TEMPLATE} ההגשות לתבנית (נוצלו כבר ${existingCount}).`;
    return;
  }

  document.getElementById('bulkSendBtn').disabled = true;
  const results = [];
  for (const empId of selectedIds) {
    const emp = employees.find(e => e.id === empId);
    hint.textContent = `שולח... (${results.length + 1}/${selectedIds.length})`;
    try {
      const { emailed } = await createSingleSigningRequest(empId, emp, template, emp.email);
      results.push({ emp, ok: true, emailed });
    } catch (e) {
      results.push({ emp, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 300)); // light throttle, mirrors PDFSign's bulk-send pacing
  }
  document.getElementById('bulkSendBtn').disabled = false;
  hint.textContent = '';

  const sentOk = results.filter(r => r.ok).length;
  resultsEl.innerHTML = `<p><strong>נשלחו ${sentOk} מתוך ${results.length}.</strong></p>` +
    '<ul class="list-mini">' + results.filter(r => !r.ok || !r.emailed).map(r =>
      `<li class="muted">${escapeHtml((r.emp.firstName || '') + ' ' + (r.emp.lastName || ''))}: ${r.ok ? 'נוצר, אך לא נשלח אימייל (EmailJS לא מוגדר)' : 'נכשל - ' + escapeHtml(r.error)}</li>`
    ).join('') + '</ul>';
}

function resolveAutoFillValue(key, employeeData) {
  const dept = departments.find(d => d.id === employeeData.departmentId);
  switch (key) {
    case 'fullName': return `${employeeData.firstName || ''} ${employeeData.lastName || ''}`.trim();
    case 'firstName': return employeeData.firstName || '';
    case 'lastName': return employeeData.lastName || '';
    case 'idNumber': return employeeData.idNumber || '';
    case 'employeeNumber': return employeeData.employeeNumber || '';
    case 'position': return employeeData.position || '';
    case 'departmentName': return dept ? dept.name : '';
    case 'startDate': return employeeData.startDate ? isoToDdMmYyyy(employeeData.startDate) : '';
    case 'phone': return employeeData.phone || '';
    case 'email': return employeeData.email || '';
    case 'address': return employeeData.address || '';
    case 'birthDate': return employeeData.birthDate ? isoToDdMmYyyy(employeeData.birthDate) : '';
    case 'today': return isoToDdMmYyyy(new Date().toISOString().slice(0, 10));
    default: return '';
  }
}

function isoToDdMmYyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

const MAX_SUBMISSIONS_PER_TEMPLATE = 100;

function wireSigningView() {
  document.getElementById('sendForSignatureBtn').addEventListener('click', sendForSignature);
  document.getElementById('signTemplateSelect').addEventListener('change', onSignTemplateChange);
  document.getElementById('startMultiSignRoundBtn').addEventListener('click', startMultiSignRound);
}

function onSignTemplateChange() {
  const templateId = document.getElementById('signTemplateSelect').value;
  const template = signTemplates.find(t => t.id === templateId);
  const isMultiSign = template && template.mode === 'multiSign';
  document.getElementById('singleSignForm').style.display = isMultiSign ? 'none' : 'block';
  document.getElementById('multiSignForm').style.display = isMultiSign ? 'block' : 'none';
  document.getElementById('sendForSignatureHint').textContent = '';
  if (!isMultiSign) return;

  const roles = (template.fields || []).filter(f => f.type === 'signature');
  const rolesEl = document.getElementById('multiSignRoles');
  rolesEl.innerHTML = roles.map(f => `
    <div class="row" data-role-field="${f.id}">
      <div class="field"><label>תפקיד</label><input value="${escapeHtml(f.label || 'חותם')}" disabled></div>
      <div class="field"><label>שם</label><input class="role-name" placeholder="שם מלא"></div>
      <div class="field"><label>אימייל</label><input type="email" class="role-email" placeholder="אימייל"></div>
    </div>
  `).join('') || '<p class="muted">לתבנית זו אין שדות חתימה מוגדרים.</p>';
}

// A "submission" against a template's 100-cap is: one single-mode send, or
// one multi-sign round (not one per role) - mirrors PDFSign's per-template
// running counter semantics.
async function countTemplateSubmissions(templateId) {
  const [singleSnap, roundsSnap] = await Promise.all([
    db.collection('signingRequests').where('templateId', '==', templateId).where('mode', '==', 'single').get(),
    db.collection('signingRounds').where('templateId', '==', templateId).get()
  ]);
  return singleSnap.size + roundsSnap.size;
}

// Shared by the single "שליחה לחתימה" button and bulk-send - creates one
// OTP-gated signingRequests doc for one employee and emails (or returns, if
// EmailJS isn't configured) the link+code.
async function createSingleSigningRequest(employeeId, employeeData, template, recipientEmail) {
  const fields = JSON.parse(JSON.stringify(template.fields || []));
  const autoFilledValues = {};
  fields.forEach(f => { if (f.autoFillFrom) autoFilledValues[f.id] = resolveAutoFillValue(f.autoFillFrom, employeeData); });

  const otpCode = String(Math.floor(100000 + Math.random() * 900000));
  const otpCodeHash = await sha256Hex(otpCode);

  const reqRef = db.collection('signingRequests').doc();
  await db.collection('signingSecrets').doc(reqRef.id).set({ otpCodeHash });
  await reqRef.set({
    employeeId,
    employeeName: `${employeeData.firstName || ''} ${employeeData.lastName || ''}`.trim(),
    templateId: template.id, templateName: template.name, mode: 'single',
    recipientEmail, fields, autoFilledValues,
    otpVerified: false, otpAttempts: 0, status: 'sent',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUserLabel()
  });

  const link = new URL('sign.html?req=' + reqRef.id, location.href).toString();
  const emailed = await sendSigningEmail({
    to_email: recipientEmail, to_name: employeeData.firstName || '',
    subject: `${template.name} - לחתימה`, link, otp_code: otpCode
  });
  return { requestId: reqRef.id, link, otpCode, emailed };
}

async function sendForSignature() {
  const hint = document.getElementById('sendForSignatureHint');
  const templateId = document.getElementById('signTemplateSelect').value;
  const recipientEmail = document.getElementById('signRecipientEmail').value.trim();
  if (!editingEmployeeId) { hint.textContent = 'יש לשמור את העובד תחילה.'; return; }
  if (!templateId) { hint.textContent = 'יש לבחור תבנית.'; return; }
  if (!recipientEmail) { hint.textContent = 'יש להזין אימייל נמען.'; return; }

  hint.textContent = 'שולח...';
  try {
    if ((await countTemplateSubmissions(templateId)) >= MAX_SUBMISSIONS_PER_TEMPLATE) {
      hint.textContent = `התבנית הגיעה למכסה של ${MAX_SUBMISSIONS_PER_TEMPLATE} הגשות.`;
      return;
    }
    const template = signTemplates.find(t => t.id === templateId);
    const { link, otpCode, emailed } = await createSingleSigningRequest(editingEmployeeId, currentEmployeeData, template, recipientEmail);

    document.getElementById('signRecipientEmail').value = '';
    hint.textContent = '';
    await loadSigningRequests(editingEmployeeId);
    alert(
      `בקשת החתימה נוצרה.\n\nקישור: ${link}\nקוד אימות: ${otpCode}\n\n` +
      (emailed ? 'האימייל נשלח אוטומטית לנמען.' : 'לא הוגדר שירות שליחת אימייל (EmailJS) - יש להעתיק ולשלוח את הקישור והקוד ידנית.')
    );
  } catch (e) {
    hint.textContent = 'שגיאה: ' + e.message;
  }
}

async function startMultiSignRound() {
  const hint = document.getElementById('sendForSignatureHint');
  const templateId = document.getElementById('signTemplateSelect').value;
  if (!editingEmployeeId) { hint.textContent = 'יש לשמור את העובד תחילה.'; return; }
  if (!templateId) { hint.textContent = 'יש לבחור תבנית.'; return; }
  const template = signTemplates.find(t => t.id === templateId);

  const roleRows = Array.from(document.querySelectorAll('#multiSignRoles [data-role-field]'));
  if (!roleRows.length) { hint.textContent = 'לתבנית זו אין שדות חתימה.'; return; }
  const roleInputs = roleRows.map(row => ({
    fieldId: row.dataset.roleField,
    roleLabel: row.querySelector('input[disabled]').value,
    name: row.querySelector('.role-name').value.trim(),
    email: row.querySelector('.role-email').value.trim()
  }));
  if (roleInputs.some(r => !r.name || !r.email)) { hint.textContent = 'יש להזין שם ואימייל לכל תפקיד.'; return; }

  hint.textContent = 'יוצר סבב חתימות...';
  try {
    if ((await countTemplateSubmissions(templateId)) >= MAX_SUBMISSIONS_PER_TEMPLATE) {
      hint.textContent = `התבנית הגיעה למכסה של ${MAX_SUBMISSIONS_PER_TEMPLATE} הגשות.`;
      return;
    }
    const fields = JSON.parse(JSON.stringify(template.fields || []));
    const autoFilledValues = {};
    fields.forEach(f => { if (f.autoFillFrom) autoFilledValues[f.id] = resolveAutoFillValue(f.autoFillFrom, currentEmployeeData); });

    const roundRef = db.collection('signingRounds').doc();
    const employeeName = `${currentEmployeeData.firstName || ''} ${currentEmployeeData.lastName || ''}`.trim();
    const linksSummary = [];

    for (const role of roleInputs) {
      const otpCode = String(Math.floor(100000 + Math.random() * 900000));
      const otpCodeHash = await sha256Hex(otpCode);
      const reqRef = db.collection('signingRequests').doc();
      await db.collection('signingSecrets').doc(reqRef.id).set({ otpCodeHash });
      await reqRef.set({
        employeeId: editingEmployeeId, employeeName,
        templateId, templateName: template.name, mode: 'multiSign',
        roundId: roundRef.id, roleFieldId: role.fieldId, roleLabel: role.roleLabel,
        recipientEmail: role.email, recipientName: role.name,
        otpVerified: false, otpAttempts: 0, status: 'sent',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUserLabel()
      });
      role.requestId = reqRef.id;

      const link = new URL('sign.html?req=' + reqRef.id, location.href).toString();
      const emailed = await sendSigningEmail({
        to_email: role.email, to_name: role.name,
        subject: `${template.name} - לחתימה (${role.roleLabel})`,
        link, otp_code: otpCode
      });
      linksSummary.push(`${role.roleLabel} (${role.email}): ${link} | קוד: ${otpCode}${emailed ? '' : ' [לא נשלח אימייל]'}`);
    }

    await roundRef.set({
      employeeId: editingEmployeeId, employeeName,
      templateId, templateName: template.name,
      fields, autoFilledValues,
      roles: roleInputs.map(r => ({ fieldId: r.fieldId, roleLabel: r.roleLabel, requestId: r.requestId, email: r.email, name: r.name })),
      status: 'in_progress', values: {}, signerNames: {}, rawSignatures: {},
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUserLabel()
    });

    document.querySelectorAll('#multiSignRoles .role-name, #multiSignRoles .role-email').forEach(el => el.value = '');
    hint.textContent = '';
    await loadSigningRequests(editingEmployeeId);
    alert('סבב חתימות נוצר.\n\n' + linksSummary.join('\n\n'));
  } catch (e) {
    hint.textContent = 'שגיאה: ' + e.message;
  }
}

const SIGNING_STATUS_LABELS = { sent: 'ממתין', signed: 'נחתם', expired: 'פג תוקף' };
const ROUND_STATUS_LABELS = { in_progress: 'בתהליך', completing: 'משלים...', completed: 'הושלם' };

async function loadSigningRequests(employeeId) {
  const [singleSnap, roundsSnap] = await Promise.all([
    db.collection('signingRequests').where('employeeId', '==', employeeId).orderBy('createdAt', 'desc').get(),
    db.collection('signingRounds').where('employeeId', '==', employeeId).orderBy('createdAt', 'desc').get()
  ]);
  const ul = document.getElementById('signingRequestsList');

  const singleRows = singleSnap.docs
    .filter(d => d.data().mode !== 'multiSign')
    .map(d => {
      const r = d.data();
      const statusLabel = r.status === 'sent' && r.otpVerified ? 'בתהליך מילוי' : (SIGNING_STATUS_LABELS[r.status] || r.status);
      return `<li>
        <span>${escapeHtml(r.templateName)} <span class="muted">· ${statusLabel} · ${escapeHtml(r.recipientEmail)} ${r.createdAt ? '· ' + fmtDate(r.createdAt) : ''}</span></span>
        <span>
          ${r.status === 'signed' && !r.resultDocumentId ? `<button class="btn small" data-promote="${d.id}">הוספה לתיק המסמכים</button>` : ''}
          ${r.status === 'signed' && r.resultDocumentId ? '<span class="badge active">נוסף לתיק</span>' : ''}
          ${r.status === 'sent' ? `<button class="btn small danger" data-expire="${d.id}">ביטול</button>` : ''}
        </span>
      </li>`;
    });

  const roundRows = roundsSnap.docs.map(d => {
    const r = d.data();
    const signedCount = Object.keys(r.rawSignatures || {}).length + (r.status === 'completed' ? 0 : 0);
    const totalRoles = (r.roles || []).length;
    const summary = r.status === 'in_progress'
      ? `${Object.keys(r.signerNames || {}).length}/${totalRoles} חתמו`
      : (ROUND_STATUS_LABELS[r.status] || r.status);
    const roleLines = (r.roles || []).map(role => {
      const signed = !!(r.signerNames || {})[role.fieldId];
      return `<li style="padding-inline-start:16px">
        <span class="muted">${escapeHtml(role.roleLabel)} - ${signed ? 'נחתם ע"י ' + escapeHtml((r.signerNames || {})[role.fieldId]) : 'ממתין ל' + escapeHtml(role.email)}</span>
        ${!signed ? `<button class="btn small" data-copy-role-link="${role.requestId}">העתקת קישור</button>` : ''}
      </li>`;
    }).join('');
    return `<li style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between">
        <span>${escapeHtml(r.templateName)} (רב-חותמים) <span class="muted">· ${summary} ${r.createdAt ? '· ' + fmtDate(r.createdAt) : ''}</span></span>
        <span>
          ${r.status === 'completed' && !r.resultDocumentId ? `<button class="btn small" data-promote-round="${d.id}">הוספה לתיק המסמכים</button>` : ''}
          ${r.status === 'completed' && r.resultDocumentId ? '<span class="badge active">נוסף לתיק</span>' : ''}
          ${r.status === 'completing' ? `<button class="btn small" data-retry-round="${d.id}">נסה שוב להשלים</button>` : ''}
        </span>
      </div>
      <ul class="list-mini">${roleLines}</ul>
    </li>`;
  });

  ul.innerHTML = singleRows.join('') + roundRows.join('') || '<li class="muted">לא נשלחו בקשות חתימה</li>';

  ul.querySelectorAll('[data-promote]').forEach(btn => {
    btn.addEventListener('click', () => promoteSignedDocument(employeeId, btn.dataset.promote));
  });
  ul.querySelectorAll('[data-expire]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.collection('signingRequests').doc(btn.dataset.expire).update({ status: 'expired' });
      await loadSigningRequests(employeeId);
    });
  });
  ul.querySelectorAll('[data-promote-round]').forEach(btn => {
    btn.addEventListener('click', () => promoteSignedRound(employeeId, btn.dataset.promoteRound));
  });
  ul.querySelectorAll('[data-retry-round]').forEach(btn => {
    btn.addEventListener('click', () => retryRoundCompletion(employeeId, btn.dataset.retryRound));
  });
  ul.querySelectorAll('[data-copy-role-link]').forEach(btn => {
    btn.addEventListener('click', () => {
      const link = new URL('sign.html?req=' + btn.dataset.copyRoleLink, location.href).toString();
      navigator.clipboard.writeText(link).then(
        () => alert('הקישור הועתק (הקוד האישי נשלח באימייל בזמן היצירה ואינו ניתן לשליפה חוזרת).'),
        () => alert('הקישור: ' + link)
      );
    });
  });
}

async function promoteSignedRound(employeeId, roundId) {
  try {
    const roundDoc = await db.collection('signingRounds').doc(roundId).get();
    const r = roundDoc.data();
    const signedPath = `signingRounds/${roundId}/signed.pdf`;
    const url = await storage.ref(signedPath).getDownloadURL();
    const res = await fetch(url);
    const blob = await res.blob();

    const docRef = db.collection('employees').doc(employeeId).collection('documents').doc();
    const destPath = `documents/${employeeId}/${docRef.id}_signed.pdf`;
    await storage.ref(destPath).put(blob);
    await docRef.set({
      name: `${r.templateName} (חתום - רב-חותמים)`, storagePath: destPath, contentType: 'application/pdf', sizeBytes: blob.size,
      uploadedAt: firebase.firestore.FieldValue.serverTimestamp(), uploadedBy: currentUserLabel()
    });
    await db.collection('signingRounds').doc(roundId).update({ resultDocumentId: docRef.id });

    await loadDocuments(employeeId);
    await loadSigningRequests(employeeId);
  } catch (e) {
    alert('שגיאה בהוספת המסמך לתיק: ' + e.message);
  }
}

let _adminPdfLibLoaded = false;
function loadPdfLibForAdmin() {
  return new Promise((resolve, reject) => {
    if (window.PDFLib || _adminPdfLibLoaded) { resolve(); return; }
    const s = document.createElement('script');
    s.src = PDF_LIB_SCRIPT_URL;
    s.onload = () => { _adminPdfLibLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Recovery path for a round stuck at status 'completing' - e.g. the signer
// who completed the last role had their browser crash between the Firestore
// transaction committing and the flatten/upload finishing. Re-runs just that
// final step using whatever values/signatures are already on the round doc.
async function retryRoundCompletion(employeeId, roundId) {
  const roundRef = db.collection('signingRounds').doc(roundId);
  try {
    await loadPdfLibForAdmin();
    const round = (await roundRef.get()).data();
    const template = (await db.collection('templates').doc(round.templateId).get()).data();
    const url = await storage.ref(template.storagePath).getDownloadURL();
    const originalBytes = new Uint8Array(await (await fetch(url)).arrayBuffer());

    const resolveStamp = (field) => {
      if (field.type === 'signature') {
        const sig = (round.rawSignatures || {})[field.id];
        return sig ? { kind: 'signature', dataUrl: sig } : null;
      }
      if (field.type === 'checkbox') return { kind: 'checkbox', checked: !!(round.values || {})[field.id] };
      const val = (round.values || {})[field.id];
      return val ? { kind: 'text', value: String(val) } : null;
    };
    const flattenedBytes = await flattenPdf(originalBytes, round.fields, resolveStamp);
    await storage.ref(`signingRounds/${roundId}/signed.pdf`).put(new Blob([flattenedBytes], { type: 'application/pdf' }));
    await roundRef.update({
      status: 'completed', completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rawSignatures: firebase.firestore.FieldValue.delete()
    });

    await loadSigningRequests(employeeId);
    alert('הסבב הושלם בהצלחה.');
  } catch (e) {
    alert('שגיאה בניסיון להשלים: ' + e.message);
  }
}

async function promoteSignedDocument(employeeId, requestId) {
  try {
    const reqDoc = await db.collection('signingRequests').doc(requestId).get();
    const r = reqDoc.data();
    const signedPath = `signingRequests/${requestId}/signed.pdf`;
    const url = await storage.ref(signedPath).getDownloadURL();
    const res = await fetch(url);
    const blob = await res.blob();

    const docRef = db.collection('employees').doc(employeeId).collection('documents').doc();
    const destPath = `documents/${employeeId}/${docRef.id}_signed.pdf`;
    await storage.ref(destPath).put(blob);
    await docRef.set({
      name: `${r.templateName} (חתום)`, storagePath: destPath, contentType: 'application/pdf', sizeBytes: blob.size,
      uploadedAt: firebase.firestore.FieldValue.serverTimestamp(), uploadedBy: currentUserLabel()
    });
    await db.collection('signingRequests').doc(requestId).update({ resultDocumentId: docRef.id });

    await loadDocuments(employeeId);
    try { await loadSigningRequests(employeeId); } catch (e) { console.error('loadSigningRequests failed', e); }
  } catch (e) {
    alert('שגיאה בהוספת המסמך לתיק: ' + e.message);
  }
}

/* ---- portal access ---- */

function renderPortalStatus(employeeId, data) {
  const block = document.getElementById('portalStatusBlock');
  if (!employeeId) {
    block.innerHTML = '<p class="muted">יש לשמור את העובד תחילה כדי ליצור גישת פורטל.</p>';
    return;
  }
  if (data.uid) {
    block.innerHTML = `
      <p>גישת פורטל <strong>${data.portalActive === false ? 'מושבתת' : 'פעילה'}</strong> עבור ${escapeHtml(data.portalEmail || '')}</p>
      <button class="btn" id="togglePortalBtn">${data.portalActive === false ? 'הפעלת גישה' : 'השבתת גישה'}</button>
    `;
    document.getElementById('togglePortalBtn').addEventListener('click', async () => {
      await db.collection('employees').doc(employeeId).update({ portalActive: data.portalActive === false });
      await openEmployeeModal(employeeId);
    });
  } else {
    block.innerHTML = `
      <div class="field"><label>אימייל לכניסת העובד לפורטל</label><input id="portalEmailInput" type="email" value="${escapeHtml(data.email || '')}"></div>
      <button class="btn primary" id="createPortalBtn">יצירת גישת פורטל</button>
      <p class="hint">העובד יקבל אימייל לקביעת סיסמה אישית.</p>
    `;
    document.getElementById('createPortalBtn').addEventListener('click', () => createPortalAccess(employeeId));
  }
}

async function createPortalAccess(employeeId) {
  const email = document.getElementById('portalEmailInput').value.trim();
  if (!email) { alert('נא להזין אימייל.'); return; }
  const tempPassword = Math.random().toString(36).slice(2) + 'A1!';
  try {
    const secAuth = withSecondaryAuth();
    const cred = await secAuth.createUserWithEmailAndPassword(email, tempPassword);
    await db.collection('employees').doc(employeeId).update({
      uid: cred.user.uid, portalEmail: email, portalActive: true
    });
    await secAuth.sendPasswordResetEmail(email);
    await secAuth.signOut();
    await openEmployeeModal(employeeId);
    alert('נוצרה גישת פורטל, ונשלח לעובד אימייל לקביעת סיסמה.');
  } catch (e) {
    alert('שגיאה ביצירת גישת פורטל: ' + e.message);
  }
}

/* ---- utils ---- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
