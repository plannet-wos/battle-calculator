/**
 * Firebase web SDK config for the save-code feature.
 *
 * To populate these values:
 *   1. Open the Firebase console for project `tal-coordinator`.
 *   2. Project settings → General → Your apps → Web app → Config.
 *   3. Copy the `firebaseConfig` object's fields into the placeholders below.
 *
 * These values are PUBLIC (they end up in the client bundle either way) —
 * security comes from Firestore Security Rules, not from hiding the config.
 *
 * Firestore must also be enabled in the Firebase console (Build → Firestore
 * Database → Create database). The save-code feature will silently fail at
 * runtime if Firestore is not enabled.
 */
export const environment = {
  production: false,
  firebase: {
    apiKey:            'REPLACE_ME_API_KEY',
    authDomain:        'tal-coordinator.firebaseapp.com',
    projectId:         'tal-coordinator',
    storageBucket:     'tal-coordinator.appspot.com',
    messagingSenderId: 'REPLACE_ME_SENDER_ID',
    appId:             'REPLACE_ME_APP_ID',
  },
};
