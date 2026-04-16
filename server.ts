import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json' assert { type: 'json' };

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

const db = getFirestore(firebaseConfig.firestoreDatabaseId);
const auth = getAuth();

async function startServer() {
  console.log('Starting server...');
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // API Routes
  app.post('/api/admin/create-employee', async (req, res) => {
    const { email, password, displayName, idToken } = req.body;

    console.log(`[API] Attempting to create employee: ${email}`);

    if (!idToken) {
      console.error('[API] No ID Token provided');
      return res.status(401).json({ error: 'ID Token manquant' });
    }

    try {
      // 1. Verify the requester is an admin
      console.log('[API] Verifying ID Token...');
      const decodedToken = await auth.verifyIdToken(idToken);
      const adminUid = decodedToken.uid;
      
      console.log(`[API] Requester UID: ${adminUid}. Checking admin role in Firestore...`);
      console.log(`[API] Database ID: ${firebaseConfig.firestoreDatabaseId}`);
      
      const adminDoc = await db.collection('users').doc(adminUid).get();
      console.log('[API] Firestore query completed');
      
      if (!adminDoc.exists) {
        console.error('[API] Admin profile not found in Firestore');
        return res.status(403).json({ error: 'Profil administrateur non trouvé' });
      }

      const adminData = adminDoc.data();
      console.log(`[API] Admin role: ${adminData?.role}`);
      
      if (adminData?.role !== 'admin') {
        console.error(`[API] User is not an admin. Role: ${adminData?.role}`);
        return res.status(403).json({ error: 'Accès refusé : rôle administrateur requis' });
      }

      // 2. Create the user in Firebase Auth
      console.log('[API] Creating user in Firebase Auth...');
      const userRecord = await auth.createUser({
        email,
        password,
        displayName,
      });
      console.log(`[API] User created in Auth with UID: ${userRecord.uid}`);

      // 3. Create the user profile in Firestore
      console.log('[API] Creating user profile in Firestore...');
      await db.collection('users').doc(userRecord.uid).set({
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || 'Employé',
        photoURL: '',
        role: 'employee',
        createdAt: FieldValue.serverTimestamp()
      });
      console.log('[API] User profile created successfully');

      res.json({ success: true, uid: userRecord.uid });
    } catch (error: any) {
      console.error('[API] Error in create-employee:', error);
      console.error('[API] Error Code:', error.code);
      console.error('[API] Error Stack:', error.stack);
      
      // Handle specific Firebase errors
      if (error.code === 'auth/email-already-exists') {
        return res.status(400).json({ error: 'Cet email est déjà utilisé par un autre compte.' });
      }
      if (error.code === 'auth/invalid-password') {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      }
      if (error.code === 'auth/operation-not-allowed') {
        return res.status(400).json({ error: "L'authentification par email/mot de passe n'est pas activée dans votre console Firebase." });
      }
      
      res.status(500).json({ error: error.message || 'Une erreur interne est survenue' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    const distExists = fs.existsSync(distPath);
    console.log(`[Server] Production mode. dist folder exists: ${distExists} at ${distPath}`);
    
    if (distExists) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        const indexPath = path.join(distPath, 'index.html');
        res.sendFile(indexPath);
      });
    } else {
      console.warn('[Server] dist folder NOT found. Falling back to dev-like serving or root files.');
      // Fallback to serving from root if dist is missing (should not happen in prod)
      app.use(express.static(process.cwd()));
      app.get('*', (req, res) => {
        res.sendFile(path.join(process.cwd(), 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
