init();

async function init() {
  const info = await requireRole(['employee']);
  document.getElementById('whoAmI').textContent = info.name || info.user.email;
  document.getElementById('logoutBtn').addEventListener('click', () => auth.signOut().then(() => location.href = 'login.html'));

  const empDoc = await db.collection('employees').doc(info.employeeId).get();
  const data = empDoc.data();

  document.getElementById('fullName').textContent = `${data.firstName || ''} ${data.lastName || ''}`;
  document.getElementById('positionLine').textContent = data.position || '';
  if (data.photoDataUrl) document.getElementById('photoPreview').src = data.photoDataUrl;

  let deptName = '';
  if (data.departmentId) {
    const deptDoc = await db.collection('departments').doc(data.departmentId).get();
    if (deptDoc.exists) deptName = deptDoc.data().name;
  }

  renderKv('personalList', [
    ['ת.ז.', data.idNumber],
    ['תאריך לידה', data.birthDate],
    ['טלפון', data.phone],
    ['אימייל', data.email],
    ['כתובת', data.address]
  ]);

  renderKv('employmentList', [
    ['תפקיד', data.position],
    ['מחלקה / סניף', deptName],
    ['מנהל ישיר', data.managerName],
    ['סטטוס', data.status === 'terminated' ? 'לא פעיל' : 'פעיל'],
    ['תאריך תחילת עבודה', data.startDate]
  ]);

  if (data.customFields && Object.keys(data.customFields).length) {
    const fieldDefsSnap = await db.collection('fieldDefs').get();
    const defs = {};
    fieldDefsSnap.docs.forEach(d => defs[d.id] = d.data());
    const rows = Object.entries(data.customFields)
      .filter(([id]) => defs[id])
      .map(([id, val]) => [defs[id].label, typeof val === 'boolean' ? (val ? 'כן' : 'לא') : val]);
    if (rows.length) {
      document.getElementById('customFieldsCard').style.display = 'block';
      renderKv('customList', rows);
    }
  }

  await renderSubList(info.employeeId, 'equipment', 'equipmentList', d => `${d.name}${d.date ? ' · ' + d.date : ''}${d.notes ? ' · ' + d.notes : ''}`);
  await renderSubList(info.employeeId, 'trainings', 'trainingsList', d => `${d.name}${d.date ? ' · ' + d.date : ''}${d.expiry ? ' · בתוקף עד ' + d.expiry : ''}`);
  await renderDocuments(info.employeeId);
}

async function renderDocuments(employeeId) {
  const snap = await db.collection('employees').doc(employeeId).collection('documents').orderBy('uploadedAt', 'desc').get();
  const ul = document.getElementById('documentsList');
  ul.innerHTML = snap.docs.map(d => `
    <li>
      <span>${escapeHtml(d.data().name)} <span class="muted">${d.data().uploadedAt ? '· ' + fmtDate(d.data().uploadedAt) : ''}</span></span>
      <button class="btn small" data-view-doc="${d.id}">צפייה / הורדה</button>
    </li>
  `).join('') || '<li class="muted">אין מסמכים</li>';

  ul.querySelectorAll('[data-view-doc]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const doc = (await db.collection('employees').doc(employeeId).collection('documents').doc(btn.dataset.viewDoc).get()).data();
      const url = await storage.ref(doc.storagePath).getDownloadURL();
      window.open(url, '_blank');
    });
  });
}

function renderKv(elId, pairs) {
  const ul = document.getElementById(elId);
  ul.innerHTML = pairs.filter(([, v]) => v).map(([k, v]) => `<li><span class="muted">${k}</span><span>${escapeHtml(String(v))}</span></li>`).join('') || '<li class="muted">אין מידע</li>';
}

async function renderSubList(employeeId, coll, elId, fmt) {
  const snap = await db.collection('employees').doc(employeeId).collection(coll).orderBy('createdAt', 'desc').get();
  const ul = document.getElementById(elId);
  ul.innerHTML = snap.docs.map(d => `<li>${escapeHtml(fmt(d.data()))}</li>`).join('') || '<li class="muted">אין רשומות</li>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
