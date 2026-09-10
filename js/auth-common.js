// Shared across login/admin/portal pages. Depends on firebase-init.js having run first.

// Hardcoded fallback owner — mirrors isHardcodedOwner() in firestore.rules.
// Bootstraps the very first superadmin (no users/ doc needs to exist yet)
// and is a recovery path if that doc is ever corrupted. Same convention
// used in the PDFSign app.
const HARDCODED_OWNER_EMAIL = 'v.carmel@gmail.com';

// Resolves the signed-in user's role by checking, in order:
// 0) hardcoded owner email -> superadmin, always (name comes from users/{uid} if set)
// 1) users/{uid} -> superadmin or manager (must be active)
// 2) employees where uid == current uid -> employee (self-service portal only,
//    name comes from the employee's own record — always available)
// Returns one of:
//   { role: 'superadmin', name }
//   { role: 'manager', departmentIds: [...], name }
//   { role: 'employee', employeeId, name }
//   null  (no access record found — caller should sign the user out)
async function resolveCurrentUserRole(user) {
  if (user.email === HARDCODED_OWNER_EMAIL) {
    const ownerDoc = await db.collection('users').doc(user.uid).get();
    return { role: 'superadmin', departmentIds: [], name: (ownerDoc.exists && ownerDoc.data().name) || null };
  }

  const userDoc = await db.collection('users').doc(user.uid).get();
  if (userDoc.exists) {
    const data = userDoc.data();
    if (data.active) {
      return { role: data.role, departmentIds: data.departmentIds || [], name: data.name || null };
    }
    return null; // revoked admin/manager account
  }

  const empQuery = await db.collection('employees').where('uid', '==', user.uid).limit(1).get();
  if (!empQuery.empty) {
    const empDoc = empQuery.docs[0];
    const empData = empDoc.data();
    if (empData.portalActive === false) return null;
    return { role: 'employee', employeeId: empDoc.id, name: `${empData.firstName || ''} ${empData.lastName || ''}`.trim() || null };
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
