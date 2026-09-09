// Shared across login/admin/portal pages. Depends on firebase-init.js having run first.

// Resolves the signed-in user's role by checking, in order:
// 1) users/{uid} -> superadmin or manager (must be active)
// 2) employees where uid == current uid -> employee (self-service portal only)
// Returns one of:
//   { role: 'superadmin' }
//   { role: 'manager', departmentIds: [...] }
//   { role: 'employee', employeeId }
//   null  (no access record found — caller should sign the user out)
async function resolveCurrentUserRole(user) {
  const userDoc = await db.collection('users').doc(user.uid).get();
  if (userDoc.exists) {
    const data = userDoc.data();
    if (data.active) {
      return { role: data.role, departmentIds: data.departmentIds || [] };
    }
    return null; // revoked admin/manager account
  }

  const empQuery = await db.collection('employees').where('uid', '==', user.uid).limit(1).get();
  if (!empQuery.empty) {
    const empDoc = empQuery.docs[0];
    if (empDoc.data().portalActive === false) return null;
    return { role: 'employee', employeeId: empDoc.id };
  }

  return null;
}

async function requireRole(allowedRoles, redirectOnFail) {
  return new Promise((resolve) => {
    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = 'login.html';
        return;
      }
      const info = await resolveCurrentUserRole(user);
      if (!info || !allowedRoles.includes(info.role)) {
        await auth.signOut();
        window.location.href = redirectOnFail || 'login.html?denied=1';
        return;
      }
      resolve({ user, ...info });
    });
  });
}

function fmtDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.toDate) return v.toDate().toLocaleDateString('he-IL');
  return String(v);
}
