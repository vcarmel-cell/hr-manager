let currentUser, currentRole, currentUserName, myDeptIds = [];
let departments = [];
let fieldDefs = [];
let employees = [];
let editingEmployeeId = null;
let photoDataUrl = null;

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
  }

  wireNav();
  wireEmployeeModal();
  wireDepartmentsView();
  wireFieldsView();
  wireUsersView();

  await loadDepartments();
  await loadFieldDefs();
  if (currentRole === 'superadmin') await loadUsers();
  await loadEmployees();
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
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
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

const FIELD_TYPE_LABELS = { text: 'טקסט', number: 'מספר', date: 'תאריך', select: 'רשימה', checkbox: 'תיבת סימון' };

function renderFieldDefList() {
  const ul = document.getElementById('fieldDefList');
  ul.innerHTML = fieldDefs.map(f => `
    <li>
      <span>${escapeHtml(f.label)} <span class="muted">(${FIELD_TYPE_LABELS[f.type] || f.type})</span></span>
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
      await secAuth.sendPasswordResetEmail(email);
      await secAuth.signOut();
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserEmail').value = '';
      await loadUsers();
      alert('המשתמש נוצר, ונשלח אליו אימייל לקביעת סיסמה.');
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
}

function renderEmployeesTable() {
  const search = document.getElementById('empSearch').value.trim().toLowerCase();
  const deptFilter = document.getElementById('empDeptFilter').value;
  const statusFilter = document.getElementById('empStatusFilter').value;

  const filtered = employees.filter(e => {
    if (deptFilter && e.departmentId !== deptFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    if (search) {
      const hay = `${e.firstName || ''} ${e.lastName || ''} ${e.idNumber || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const tbody = document.getElementById('employeesTbody');
  tbody.innerHTML = filtered.map(e => `
    <tr>
      <td><img class="photo-preview" style="width:32px;height:32px" src="${e.photoDataUrl || DEFAULT_AVATAR_32}"></td>
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
  document.getElementById('f_position').value = data.position || '';
  document.getElementById('f_departmentId').value = data.departmentId || (departments[0] && departments[0].id) || '';
  document.getElementById('f_managerName').value = data.managerName || '';
  document.getElementById('f_status').value = data.status || 'active';
  document.getElementById('f_startDate').value = data.startDate || '';
  document.getElementById('f_endDate').value = data.endDate || '';
  document.getElementById('photoPreview').src = data.photoDataUrl || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'90\' height=\'90\'%3E%3Crect width=\'90\' height=\'90\' fill=\'%23e6e9ee\'/%3E%3C/svg%3E';

  renderCustomFieldsInModal(data.customFields);
  renderPortalStatus(employeeId, data);

  if (employeeId) {
    await loadSubItems(employeeId, 'equipment', 'equipmentList', renderEquipmentLi);
    await loadSubItems(employeeId, 'trainings', 'trainingsList', renderTrainingLi);
    await loadSubItems(employeeId, 'notes', 'notesList', renderNoteLi);
    await loadDocuments(employeeId);
  } else {
    document.getElementById('equipmentList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('trainingsList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('notesList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
    document.getElementById('documentsList').innerHTML = '<li class="muted">יש לשמור את העובד תחילה</li>';
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
    position: document.getElementById('f_position').value.trim(),
    departmentId,
    managerName: document.getElementById('f_managerName').value.trim(),
    status: document.getElementById('f_status').value,
    startDate: document.getElementById('f_startDate').value,
    endDate: document.getElementById('f_endDate').value,
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
