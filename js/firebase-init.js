// Firebase project: hr-manager-vc
const FIREBASE_CONFIG = {
  projectId: "hr-manager-vc",
  appId: "1:553944662091:web:1d735dc2811e5db7c08dce",
  storageBucket: "hr-manager-vc.firebasestorage.app",
  apiKey: "AIzaSyANOq1nvN8yXZ5RwsosOj1vpE6eoCIcTSk",
  authDomain: "hr-manager-vc.firebaseapp.com",
  messagingSenderId: "553944662091"
};

if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
const auth = firebase.auth();

// Secondary app instance, used only when an admin/manager creates a new
// portal login for an employee — createUserWithEmailAndPassword() on the
// primary app would otherwise sign the admin out and sign in as the new user.
function withSecondaryAuth() {
  let secondaryApp = firebase.apps.find(a => a.name === 'secondary');
  if (!secondaryApp) secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'secondary');
  return secondaryApp.auth();
}
