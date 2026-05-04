import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { environment } from '../environments/environment';

// Initialize Firebase once at module load. Subsequent imports of `firebase/app`
// or `firebase/firestore` reuse this default app. Save-code service in
// `core/services/save-code.service.ts` calls `getFirestore()` which picks up
// this default app.
initializeApp(environment.firebase);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
  ]
};
