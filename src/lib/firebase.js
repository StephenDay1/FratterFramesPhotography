import { initializeApp, getApps } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

function createFirebaseApp() {
  if (getApps().length) return getApps()[0]
  return initializeApp(firebaseConfig)
}

export const firebaseApp = createFirebaseApp()
export const auth = getAuth(firebaseApp)
export const db = getFirestore(firebaseApp)

const region = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1'
export const functions = getFunctions(firebaseApp, region)

const useEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'

if (import.meta.env.DEV && useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
}
