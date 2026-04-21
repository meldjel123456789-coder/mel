/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User as FirebaseUser,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  onSnapshot, 
  collection, 
  query, 
  where,
  orderBy,
  Timestamp,
  getDocFromServer,
  getDocs,
  addDoc,
  updateDoc,
  limit,
  serverTimestamp,
  deleteDoc
} from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth as getClientAuth, signOut as clientSignOut } from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';
import { auth, db } from './firebase';
import { cn, handleFirestoreError, OperationType } from './lib/utils';
import { 
  LayoutDashboard, 
  Users, 
  CheckSquare, 
  Clock, 
  LogOut, 
  LogIn,
  Plus,
  Search,
  Calendar as CalendarIcon,
  CheckCircle2,
  Circle,
  AlertCircle,
  Loader2,
  X,
  Mail,
  Lock,
  UserPlus,
  MapPin,
  Navigation,
  Crosshair,
  Bell,
  FileText,
  Download,
  Camera,
  Scan,
  ShieldCheck,
  Settings,
  Briefcase,
  Calendar,
  Coffee,
  Calculator,
  CheckCircle,
  History
} from 'lucide-react';
import { 
  format, 
  startOfDay, 
  startOfMonth, 
  endOfMonth, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isSameMonth, 
  isSameDay, 
  addMonths, 
  subMonths 
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { motion, AnimatePresence } from 'motion/react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

// Fix Leaflet default icon issue
const defaultIcon = L.icon({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

L.Marker.prototype.options.icon = defaultIcon;

// --- Types ---

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: 'admin' | 'employee';
  createdAt: Timestamp;
  lastLocation?: {
    latitude: number;
    longitude: number;
    timestamp: Timestamp;
    source: string;
  };
  faceDescriptor?: number[];
  workGroup?: 'morning' | 'evening';
  baseSalary?: number;
}

interface AppSettings {
  workDays: string[]; // ['Monday', 'Tuesday', ...]
  workHours: {
    morning: { start: string; end: string };
    evening: { start: string; end: string };
  };
  overtimeRate: number;
}

interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: 'vacation' | 'sick' | 'exit-permission';
  startDate: Timestamp;
  endDate: Timestamp;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  createdAt: Timestamp;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'completed';
  assignedTo: string;
  assignedToName: string;
  assignedByName: string;
  dueDate: Timestamp;
  createdAt: Timestamp;
}

interface Attendance {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  checkIn: Timestamp;
  checkOut?: Timestamp;
  status: 'present' | 'absent' | 'late';
  latitude?: number;
  longitude?: number;
  latitudeOut?: number;
  longitudeOut?: number;
  locationSource?: string;
  locationOutSource?: string;
  photoIn?: string;
  photoOut?: string;
  totalHours?: number;
  overtimeHours?: number;
  isLeave?: boolean;
}

interface Notification {
  id: string;
  type: 'check-in' | 'check-out';
  employeeName: string;
  employeeId: string;
  timestamp: Timestamp;
  read: boolean;
  message: string;
}

// --- Helpers ---

const getPreciseLocation = async (): Promise<{ latitude: number, longitude: number, source: string, accuracy?: number }> => {
  // Create a timeout promise for GPS
  const gpsPromise = new Promise<{ latitude: number, longitude: number, source: string, accuracy?: number }>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("No Geolocation"));
      return;
    }
    // We use watchPosition briefly to get a better lock if possible, or just getCurrentPosition with high accuracy
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ 
        latitude: pos.coords.latitude, 
        longitude: pos.coords.longitude, 
        source: 'gps',
        accuracy: pos.coords.accuracy
      }),
      (err) => reject(err),
      { 
        enableHighAccuracy: true, 
        timeout: 15000, // Increase timeout to 15s for better GPS lock
        maximumAge: 0 
      }
    );
  });

  // Create a fast IP fallback promise
  const ipPromise = (async () => {
    const services = [
      'https://ipapi.co/json/',
      'https://ipwho.is/',
      'https://freeipapi.com/api/json',
      'https://geolocation-db.com/json/',
      'https://api.ipify.org?format=json' // Just to get IP if others fail, but we need lat/lon
    ];
    
    for (const url of services) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const lat = data.latitude || data.lat || data.location?.latitude;
          const lon = data.longitude || data.lon || data.lng || data.location?.longitude;
          if (lat && lon) return { latitude: lat, longitude: lon, source: 'ip' };
        }
      } catch (e) {}
    }
    throw new Error("All IP failed");
  })();

  try {
    // Strategy: Wait up to 7 seconds for GPS. GPS is the ONLY way to get "Souidania" accurately.
    // IP will almost always point to "Sidi Mhamed" (Algiers center).
    
    const result = await Promise.race([
      gpsPromise,
      new Promise<{ latitude: number, longitude: number, source: string }>((resolve) => 
        setTimeout(async () => {
          try {
            const ipRes = await ipPromise;
            resolve(ipRes);
          } catch (e) {
            // Wait for GPS till the end
          }
        }, 8000) // Increase to 8s for more reliable GPS on mobile
      )
    ]);
    
    return result;
  } catch (e) {
    try {
      return await ipPromise;
    } catch (ipErr) {
      return { latitude: 0, longitude: 0, source: 'none' };
    }
  }
};

// --- Components ---

function Modal({ isOpen, onClose, title, children }: { isOpen: boolean, onClose: () => void, title: string, children: React.ReactNode }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-6">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-white z-50">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
        <p className="text-gray-500 font-medium">Chargement de StaffTrack...</p>
      </div>
    </div>
  );
}

function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {
        const role = user.email === 'meldjel123456789@gmail.com' ? 'admin' : 'employee';
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || 'Utilisateur',
          photoURL: user.photoURL || '',
          role: role,
          createdAt: serverTimestamp()
        });
      }
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/popup-closed-by-user') {
        setError("La fenêtre de connexion a été fermée.");
      } else if (err.code === 'auth/too-many-requests') {
        setError("Trop de tentatives. Veuillez patienter quelques minutes.");
      } else {
        setError("Échec de la connexion Google.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      console.error(err);
      let message = "Erreur de connexion.";
      if (err.code === 'auth/invalid-credential') {
        message = "Email ou mot de passe incorrect.";
      } else if (err.code === 'auth/too-many-requests') {
        message = "Trop de tentatives échouées. Veuillez patienter quelques minutes.";
      } else if (err.code === 'auth/user-disabled') {
        message = "Ce compte a été désactivé.";
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center"
      >
        <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-200">
          <LayoutDashboard className="text-white w-8 h-8" />
        </div>
        <h1 className="text-3xl font-bold text-gray-900 mb-2">StaffTrack</h1>
        <p className="text-gray-500 mb-8">Gérez vos équipes et vos tâches en toute simplicité.</p>
        
        {error && (
          <div className="mb-6 p-3 bg-red-50 text-red-600 rounded-lg text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <div className="space-y-6">
          {/* Google Login Option */}
          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white border-2 border-gray-100 text-gray-700 font-bold py-4 px-4 rounded-2xl hover:border-blue-100 hover:bg-blue-50/30 transition-all active:scale-95 disabled:opacity-50 shadow-sm"
          >
            {loading ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-6 h-6" alt="Google" />
            )}
            Connexion avec Google
          </button>

          {/* Separator */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-gray-200"></span>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-4 text-gray-400 font-bold tracking-widest">OU</span>
            </div>
          </div>

          {/* Email Login Option */}
          <form onSubmit={handleEmailLogin} className="space-y-4 text-left">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email professionnel</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input 
                  required
                  type="email" 
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  placeholder="votre@email.com"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mot de passe</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input 
                  required
                  type="password" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  placeholder="••••••••"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white font-bold py-4 px-4 rounded-2xl hover:bg-blue-700 transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-blue-100"
            >
              {loading ? <Loader2 className="w-6 h-6 animate-spin mx-auto" /> : "Se connecter par Email"}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'tasks' | 'attendance' | 'team' | 'map' | 'reports' | 'hr'>('dashboard');
  const [modelsLoaded, setModelsLoaded] = useState(false);

  useEffect(() => {
    const loadModels = async () => {
      try {
        const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        setModelsLoaded(true);
        console.log("Face-api models loaded");
      } catch (err) {
        console.error("Failed to load face-api models:", err);
      }
    };
    loadModels();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const unsubProfile = onSnapshot(userRef, (doc) => {
          if (doc.exists()) {
            setProfile(doc.data() as UserProfile);
          } else {
            setProfile(null);
          }
          setLoading(false);
        }, (error) => {
          // If we get a permission error, it might be because the document doesn't exist yet
          // or the auth state is still syncing. We'll set loading to false to allow the UI to react.
          console.warn('Profile fetch error:', error);
          setLoading(false);
        });

        return () => unsubProfile();
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user && !profile && !loading) {
      const ensureProfile = async () => {
        try {
          const userRef = doc(db, 'users', user.uid);
          const role = user.email === 'meldjel123456789@gmail.com' ? 'admin' : 'employee';
          await setDoc(userRef, {
            uid: user.uid,
            email: user.email || '',
            displayName: user.displayName || user.email?.split('@')[0] || 'Utilisateur',
            photoURL: user.photoURL || '',
            role: role,
            createdAt: serverTimestamp()
          }, { merge: true });
        } catch (err) {
          console.error('Failed to auto-create profile:', err);
        }
      };
      ensureProfile();
    }
  }, [user, profile, loading]);

  const fixAdminRole = async () => {
    if (!user || !user.email) return;
    if (user.email === 'meldjel123456789@gmail.com') {
      try {
        await setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || 'Admin',
          photoURL: user.photoURL || '',
          role: 'admin',
          createdAt: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error('Failed to fix admin role:', err);
      }
    }
  };

  if (loading) return <LoadingScreen />;
  if (!user) return <LoginScreen />;
  
  // If user exists but profile doesn't, we might be creating it or it's a new user
  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center max-w-sm">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2">Préparation de votre profil...</h2>
          <p className="text-gray-500 mb-6">Nous configurons votre espace de travail. Cela ne prend que quelques secondes.</p>
          
          <div className="space-y-3">
            {user.email === 'meldjel123456789@gmail.com' && (
              <button 
                onClick={fixAdminRole}
                className="w-full bg-amber-50 text-amber-700 font-bold py-3 rounded-xl hover:bg-amber-100 transition-all flex items-center justify-center gap-2"
              >
                <ShieldCheck className="w-5 h-5" />
                Forcer la création Admin
              </button>
            )}
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-white border border-gray-200 text-gray-700 font-bold py-3 rounded-xl hover:bg-gray-50 transition-all"
            >
              Actualiser
            </button>
            <button 
              onClick={() => signOut(auth)}
              className="text-blue-600 text-sm font-medium hover:underline"
            >
              Retour à la connexion
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isAdmin = profile?.role === 'admin' || user?.email === 'meldjel123456789@gmail.com';
  const isInIframe = window.self !== window.top;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col md:flex-row">
      {/* Mobile Iframe Warning */}
      {isInIframe && (
        <div className="md:hidden bg-amber-600 text-white p-3 text-center text-xs font-bold shadow-lg z-[1000]">
          <p className="flex items-center justify-center gap-2">
            <AlertCircle className="w-4 h-4" />
            POUR LE GPS : Ouvrez l'app dans un nouvel onglet
          </p>
          <a 
            href={window.location.href} 
            target="_blank" 
            rel="noopener noreferrer"
            className="mt-2 inline-block bg-white text-amber-700 px-4 py-1 rounded-full text-[10px] uppercase tracking-wider"
          >
            Cliquez ici pour ouvrir
          </a>
        </div>
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col hidden md:flex">
        <div className="p-6 flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-100">
            <LayoutDashboard className="text-white w-6 h-6" />
          </div>
          <span className="font-bold text-xl text-gray-900">StaffTrack</span>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <SidebarItem 
            icon={<LayoutDashboard />} 
            label="Tableau de bord" 
            active={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')} 
          />
          <SidebarItem 
            icon={<CheckSquare />} 
            label="Tâches" 
            active={activeTab === 'tasks'} 
            onClick={() => setActiveTab('tasks')} 
          />
          <SidebarItem 
            icon={<Clock />} 
            label="Présence" 
            active={activeTab === 'attendance'} 
            onClick={() => setActiveTab('attendance')} 
          />
          {isAdmin && (
            <SidebarItem 
              icon={<MapPin />} 
              label="Carte" 
              active={activeTab === 'map'} 
              onClick={() => setActiveTab('map')} 
            />
          )}
          {isAdmin && (
            <SidebarItem 
              icon={<Users />} 
              label="Équipe" 
              active={activeTab === 'team'} 
              onClick={() => setActiveTab('team')} 
            />
          )}
          {isAdmin && (
            <SidebarItem 
              icon={<FileText />} 
              label="Rapports" 
              active={activeTab === 'reports'} 
              onClick={() => setActiveTab('reports')} 
            />
          )}
          {isAdmin && (
            <SidebarItem 
              icon={<Briefcase />} 
              label="Système RH" 
              active={activeTab === 'hr'} 
              onClick={() => setActiveTab('hr')} 
            />
          )}
        </nav>

        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center gap-3 p-2 mb-4">
            {profile.photoURL && profile.photoURL.trim() !== "" ? (
              <img src={profile.photoURL} className="w-10 h-10 rounded-full border border-gray-200" alt="" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                {profile.displayName ? profile.displayName.charAt(0) : '?'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{profile.displayName}</p>
              <p className="text-xs text-gray-500 truncate capitalize">{profile.role}</p>
            </div>
          </div>
          
          {user.email === 'meldjel123456789@gmail.com' && profile.role !== 'admin' && (
            <button 
              onClick={fixAdminRole}
              className="w-full mb-2 flex items-center gap-2 px-4 py-2 text-xs font-bold text-amber-700 bg-amber-50 rounded-xl hover:bg-amber-100 transition-colors"
            >
              <AlertCircle className="w-4 h-4" />
              Réparer rôle Admin
            </button>
          )}

          <button 
            onClick={() => signOut(auth)}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Déconnexion
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden pb-16 md:pb-0">
        {/* Desktop Header */}
        <header className="h-16 bg-white border-b border-gray-200 hidden md:flex items-center justify-between px-8">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900 capitalize">{activeTab}</h1>
          </div>
          <div className="flex items-center gap-4">
            {isAdmin && <NotificationCenter profile={profile} />}
            <button 
              onClick={() => signOut(auth)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-xl transition-all active:scale-95 border border-transparent hover:border-red-100"
            >
              <LogOut className="w-4 h-4" />
              Déconnexion
            </button>
          </div>
        </header>

        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 md:hidden">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="text-blue-600 w-6 h-6" />
            <span className="font-bold text-lg">StaffTrack</span>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && <NotificationCenter profile={profile} />}
            <button 
              onClick={() => signOut(auth)} 
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 rounded-lg"
            >
              <LogOut className="w-4 h-4" />
              Déconnexion
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <AnimatePresence>
            {activeTab === 'dashboard' && <DashboardView key="dashboard" profile={profile} />}
            {activeTab === 'tasks' && <TasksView key="tasks" profile={profile} />}
            {activeTab === 'attendance' && <AttendanceView key="attendance" profile={profile} modelsLoaded={modelsLoaded} />}
            {activeTab === 'map' && isAdmin && <MapView key="map" profile={profile} />}
            {activeTab === 'team' && isAdmin && <TeamView key="team" profile={profile} />}
            {activeTab === 'reports' && isAdmin && <ReportsView key="reports" profile={profile} />}
            {activeTab === 'hr' && isAdmin && <HRView key="hr" profile={profile} />}
          </AnimatePresence>
        </div>
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-2 py-2 flex items-center justify-around z-50">
        <MobileNavItem 
          icon={<LayoutDashboard />} 
          active={activeTab === 'dashboard'} 
          onClick={() => setActiveTab('dashboard')} 
        />
        <MobileNavItem 
          icon={<CheckSquare />} 
          active={activeTab === 'tasks'} 
          onClick={() => setActiveTab('tasks')} 
        />
        <MobileNavItem 
          icon={<Clock />} 
          active={activeTab === 'attendance'} 
          onClick={() => setActiveTab('attendance')} 
        />
        {isAdmin && (
          <MobileNavItem 
            icon={<MapPin />} 
            active={activeTab === 'map'} 
            onClick={() => setActiveTab('map')} 
          />
        )}
        {isAdmin && (
          <MobileNavItem 
            icon={<Users />} 
            active={activeTab === 'team'} 
            onClick={() => setActiveTab('team')} 
          />
        )}
        {isAdmin && (
          <MobileNavItem 
            icon={<FileText />} 
            active={activeTab === 'reports'} 
            onClick={() => setActiveTab('reports')} 
          />
        )}
        {isAdmin && (
          <MobileNavItem 
            icon={<Briefcase />} 
            active={activeTab === 'hr'} 
            onClick={() => setActiveTab('hr')} 
          />
        )}
      </nav>
    </div>
  );
}

function MobileNavItem({ icon, active, onClick }: { icon: React.ReactNode, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "p-2 rounded-xl transition-all",
        active ? "bg-blue-50 text-blue-600" : "text-gray-400"
      )}
    >
      {React.cloneElement(icon as React.ReactElement<any>, { className: "w-6 h-6" })}
    </button>
  );
}

function SidebarItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
        active 
          ? "bg-blue-50 text-blue-600 shadow-sm" 
          : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
      )}
    >
      {React.cloneElement(icon as React.ReactElement<any>, { className: "w-5 h-5" })}
      {label}
    </button>
  );
}

// --- Views ---

function CalendarWidget({ profile }: { profile: UserProfile }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    const q = profile.role === 'admin'
      ? query(collection(db, 'tasks'))
      : query(collection(db, 'tasks'), where('assignedTo', '==', profile.uid));
    
    return onSnapshot(q, (snap) => {
      setTasks(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Task)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });
  }, [profile]);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-bold text-gray-900">Calendrier des tâches</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <LogIn className="w-4 h-4 rotate-180" />
          </button>
          <span className="text-sm font-bold text-gray-700 min-w-[100px] text-center">
            {format(currentMonth, 'MMMM yyyy', { locale: fr })}
          </span>
          <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <LogIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(day => (
          <div key={day} className="text-center text-[10px] font-bold text-gray-400 uppercase py-1">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {calendarDays.map((day, i) => {
          const dayTasks = tasks.filter(t => t.dueDate && typeof t.dueDate.toDate === 'function' && isSameDay(t.dueDate.toDate(), day));
          const isCurrentMonth = isSameMonth(day, monthStart);
          const isToday = isSameDay(day, new Date());

          return (
            <div 
              key={i} 
              className={cn(
                "min-h-[60px] p-1 border border-gray-50 rounded-lg transition-all",
                !isCurrentMonth && "opacity-20",
                isToday && "bg-blue-50/50 border-blue-100"
              )}
            >
              <span className={cn(
                "text-[10px] font-bold block mb-1",
                isToday ? "text-blue-600" : "text-gray-400"
              )}>
                {format(day, 'd')}
              </span>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 2).map(task => (
                  <div 
                    key={task.id} 
                    className={cn(
                      "text-[8px] px-1 py-0.5 rounded truncate font-medium",
                      task.status === 'completed' ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"
                    )}
                  >
                    {task.title}
                  </div>
                ))}
                {dayTasks.length > 2 && (
                  <div className="text-[8px] text-gray-400 font-bold pl-1">
                    +{dayTasks.length - 2}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NotificationCenter({ profile }: { profile: UserProfile }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (profile.role !== 'admin') return;

    const q = query(
      collection(db, 'notifications'),
      orderBy('timestamp', 'desc'),
      limit(10)
    );

    return onSnapshot(q, (snap) => {
      setNotifications(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Notification)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notifications');
    });
  }, [profile]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllAsRead = async () => {
    const unread = notifications.filter(n => !n.read);
    for (const n of unread) {
      await updateDoc(doc(db, 'notifications', n.id), { read: true });
    }
  };

  if (profile.role !== 'admin') return null;

  return (
    <div className="relative">
      <button 
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) markAllAsRead();
        }}
        className="relative p-2 bg-white rounded-xl border border-gray-100 shadow-sm hover:bg-gray-50 transition-all active:scale-95"
      >
        <Bell className={cn("w-6 h-6", unreadCount > 0 ? "text-blue-600 animate-bounce" : "text-gray-400")} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
            {unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden"
            >
              <div className="p-4 border-b border-gray-50 flex items-center justify-between bg-gray-50/50">
                <h3 className="font-bold text-gray-900">Notifications</h3>
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full uppercase">
                  Direct
                </span>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="p-8 text-center">
                    <Bell className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">Aucune notification</p>
                  </div>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} className={cn("p-4 border-b border-gray-50 hover:bg-gray-50 transition-colors", !n.read && "bg-blue-50/30")}>
                      <div className="flex gap-3">
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                          n.type === 'check-in' ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"
                        )}>
                          {n.type === 'check-in' ? <LogIn className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 leading-tight mb-1">{n.message}</p>
                          <p className="text-[10px] text-gray-400 font-medium">
                            {n.timestamp && format(n.timestamp.toDate(), "HH:mm 'le' d MMM", { locale: fr })}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function DashboardView({ profile }: { profile: UserProfile, key?: string }) {
  const [stats, setStats] = useState({ tasks: 0, attendance: 0, team: 0 });

  useEffect(() => {
    const qTasks = profile.role === 'admin' 
      ? query(collection(db, 'tasks'))
      : query(collection(db, 'tasks'), where('assignedTo', '==', profile.uid));
    
    const unsubTasks = onSnapshot(qTasks, (snap) => {
      setStats(prev => ({ ...prev, tasks: snap.size }));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });

    if (profile.role === 'admin') {
      const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
        setStats(prev => ({ ...prev, team: snap.size }));
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'users');
      });
      return () => { unsubTasks(); unsubUsers(); };
    }

    return () => unsubTasks();
  }, [profile]);

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="space-y-8"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Bonjour, {profile.displayName} 👋</h2>
          <p className="text-gray-500">Voici un aperçu de l'activité d'aujourd'hui.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard 
          icon={<CheckSquare className="text-blue-600" />} 
          label="Tâches actives" 
          value={stats.tasks.toString()} 
          color="bg-blue-50" 
        />
        <StatCard 
          icon={<Clock className="text-emerald-600" />} 
          label="Présence" 
          value="En ligne" 
          color="bg-emerald-50" 
        />
        {profile.role === 'admin' && (
          <StatCard 
            icon={<Users className="text-purple-600" />} 
            label="Membres de l'équipe" 
            value={stats.team.toString()} 
            color="bg-purple-50" 
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-8">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-bold mb-4">Tâches récentes</h3>
            <RecentTasks profile={profile} />
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-bold mb-4">Activité de présence</h3>
            <RecentAttendance profile={profile} />
          </div>
        </div>
        <CalendarWidget profile={profile} />
      </div>
    </motion.div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: string, color: string }) {
  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-4">
      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center", color)}>
        {icon}
      </div>
      <div>
        <p className="text-sm text-gray-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function RecentTasks({ profile }: { profile: UserProfile }) {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    const q = profile.role === 'admin'
      ? query(collection(db, 'tasks'), orderBy('createdAt', 'desc'), limit(5))
      : query(collection(db, 'tasks'), where('assignedTo', '==', profile.uid), orderBy('createdAt', 'desc'), limit(5));
    
    return onSnapshot(q, (snap) => {
      setTasks(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Task)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });
  }, [profile]);

  const updateTaskStatus = async (taskId: string, newStatus: Task['status']) => {
    try {
      await updateDoc(doc(db, 'tasks', taskId), { status: newStatus });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `tasks/${taskId}`);
    }
  };

  if (tasks.length === 0) return <p className="text-gray-400 text-sm italic">Aucune tâche récente.</p>;

  return (
    <div className="space-y-4">
      {tasks.map(task => (
        <div key={task.id} className="flex items-center justify-between p-3 hover:bg-gray-50 rounded-xl transition-colors group">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => task.status !== 'completed' && updateTaskStatus(task.id, 'completed')}
              className="focus:outline-none"
            >
              {task.status === 'completed' ? <CheckCircle2 className="text-emerald-500 w-5 h-5" /> : <Circle className="text-gray-300 w-5 h-5 group-hover:text-blue-400" />}
            </button>
            <div>
              <p className={cn("text-sm font-medium text-gray-900", task.status === 'completed' && "line-through text-gray-400")}>{task.title}</p>
              <p className="text-xs text-gray-500">
                {profile.role === 'admin' ? `Assigné à ${task.assignedToName}` : `Par ${task.assignedByName}`}
              </p>
            </div>
          </div>
          <select 
            value={task.status}
            onChange={(e) => updateTaskStatus(task.id, e.target.value as Task['status'])}
            className={cn(
              "text-[10px] uppercase font-bold px-2 py-1 rounded-full border-none focus:ring-0 cursor-pointer",
              task.status === 'completed' ? "bg-emerald-100 text-emerald-700" : 
              task.status === 'in-progress' ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
            )}
          >
            <option value="todo">À faire</option>
            <option value="in-progress">En cours</option>
            <option value="completed">Terminé</option>
          </select>
        </div>
      ))}
    </div>
  );
}

function RecentAttendance({ profile }: { profile: UserProfile }) {
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  useEffect(() => {
    const q = profile.role === 'admin'
      ? query(collection(db, 'attendance'), orderBy('checkIn', 'desc'), limit(5))
      : query(collection(db, 'attendance'), where('employeeId', '==', profile.uid), orderBy('checkIn', 'desc'), limit(5));
    
    return onSnapshot(q, (snap) => {
      setAttendance(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Attendance)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'attendance');
    });
  }, [profile]);

  if (attendance.length === 0) return <p className="text-gray-400 text-sm italic">Aucun enregistrement récent.</p>;

  return (
    <div className="space-y-4">
      {attendance.map(record => (
        <div key={record.id} className="flex items-center justify-between p-3 hover:bg-gray-50 rounded-xl transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center overflow-hidden">
              {record.photoIn ? (
                <img src={record.photoIn} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
              ) : (
                <Clock className="w-4 h-4 text-gray-500" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{record.employeeName}</p>
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500">
                  {record.checkIn && typeof record.checkIn.toDate === 'function' && format(record.checkIn.toDate(), 'HH:mm', { locale: fr })}
                  {record.checkOut && typeof record.checkOut.toDate === 'function' && ` - ${format(record.checkOut.toDate(), 'HH:mm', { locale: fr })}`}
                </p>
                {record.latitude && record.longitude && (
                  <a 
                    href={`https://www.google.com/maps?q=${record.latitude},${record.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-[10px] text-blue-600 rounded-md hover:bg-blue-100 transition-colors font-bold"
                    title={`Position à l'arrivée (${record.locationSource || 'gps'})`}
                  >
                    <MapPin className="w-3 h-3" />
                    ARRIVÉE {record.locationSource === 'ip' && "(PC)"}
                  </a>
                )}
                {record.latitudeOut && record.longitudeOut && (
                  <a 
                    href={`https://www.google.com/maps?q=${record.latitudeOut},${record.longitudeOut}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-0.5 bg-red-50 text-[10px] text-red-600 rounded-md hover:bg-red-100 transition-colors font-bold"
                    title={`Position au départ (${record.locationOutSource || 'gps'})`}
                  >
                    <MapPin className="w-3 h-3" />
                    DÉPART {record.locationOutSource === 'ip' && "(PC)"}
                  </a>
                )}
              </div>
            </div>
          </div>
          <span className="text-xs font-medium text-gray-500">
            {record.date}
          </span>
        </div>
      ))}
    </div>
  );
}

function TasksView({ profile }: { profile: UserProfile, key?: string }) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [team, setTeam] = useState<UserProfile[]>([]);
  const [newTask, setNewTask] = useState({ title: '', description: '', assignedTo: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (profile.role === 'admin') {
      return onSnapshot(collection(db, 'users'), (snap) => {
        setTeam(snap.docs.map(doc => doc.data() as UserProfile));
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'users');
      });
    }
  }, [profile]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const assignedUser = team.find(u => u.uid === newTask.assignedTo);
      await addDoc(collection(db, 'tasks'), {
        ...newTask,
        status: 'todo',
        assignedToName: assignedUser?.displayName || 'Inconnu',
        assignedByName: profile.displayName,
        createdAt: serverTimestamp(),
        dueDate: Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) // 1 week default
      });
      setIsModalOpen(false);
      setNewTask({ title: '', description: '', assignedTo: '' });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'tasks');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Gestion des Tâches</h2>
          <p className="text-gray-500">Suivez et gérez les missions de votre équipe.</p>
        </div>
        {profile.role === 'admin' && (
          <button 
            onClick={() => setIsModalOpen(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 hover:bg-blue-700 transition-all active:scale-95"
          >
            <Plus className="w-5 h-5" />
            Nouvelle Tâche
          </button>
        )}
      </div>
      <div className="flex-1 bg-white rounded-2xl border border-gray-100 shadow-sm p-6 overflow-y-auto">
        <RecentTasks profile={profile} />
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Créer une nouvelle tâche">
        <form onSubmit={handleCreateTask} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Titre</label>
            <input 
              required
              type="text" 
              value={newTask.title}
              onChange={e => setNewTask({...newTask, title: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              placeholder="Nom de la tâche"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea 
              value={newTask.description}
              onChange={e => setNewTask({...newTask, description: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none h-24"
              placeholder="Détails de la tâche..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assigner à</label>
            <select 
              required
              value={newTask.assignedTo}
              onChange={e => setNewTask({...newTask, assignedTo: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            >
              <option value="">Sélectionner un employé</option>
              {team.map(member => (
                <option key={member.uid} value={member.uid}>{member.displayName}</option>
              ))}
            </select>
          </div>
          <button 
            disabled={loading}
            type="submit"
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Créer la tâche"}
          </button>
        </form>
      </Modal>
    </motion.div>
  );
}

function FaceAuthModal({ isOpen, onClose, onConfirm, onFailure, type, profile }: { 
  isOpen: boolean, 
  onClose: () => void, 
  onConfirm: (photo: string, location?: any) => void, 
  onFailure: () => void,
  type: 'in' | 'out',
  profile: UserProfile
}) {
  const webcamRef = useRef<Webcam>(null);
  const [capturing, setCapturing] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [status, setStatus] = useState<'idle' | 'locating' | 'analyzing' | 'success' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<any>(null);

  const capture = useCallback(async () => {
    if (!webcamRef.current) return;
    const imageSrc = webcamRef.current.getScreenshot();
    if (imageSrc) {
      setStatus('analyzing');
      setError(null);
      
      try {
        if (!profile.faceDescriptor) {
          setStatus('success');
          // Wait briefly for location if it's still being fetched
          let loc = location;
          if (!loc) {
            loc = await getPreciseLocation().catch(() => ({ latitude: 0, longitude: 0, source: 'none' }));
          }
          onConfirm(imageSrc, loc);
          return;
        }

        const img = await faceapi.fetchImage(imageSrc);
        const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
        
        if (detection) {
          const distance = faceapi.euclideanDistance(detection.descriptor, new Float32Array(profile.faceDescriptor));
          if (distance < 0.6) { // Threshold for match
            setStatus('success');
            let loc = location;
            if (!loc) {
               loc = await getPreciseLocation().catch(() => ({ latitude: 0, longitude: 0, source: 'none' }));
            }
            onConfirm(imageSrc, loc);
          } else {
            const newAttempts = attempts + 1;
            setAttempts(newAttempts);
            if (newAttempts >= 3) {
              setStatus('failed');
              setError("Identité non reconnue après 3 tentatives.");
              setTimeout(onFailure, 1000);
            } else {
              setStatus('idle');
              setError(`Visage non reconnu. Tentative ${newAttempts}/3`);
              setCountdown(0); // Immediate retry
              setCapturing(true);
            }
          }
        } else {
          const newAttempts = attempts + 1;
          setAttempts(newAttempts);
          if (newAttempts >= 3) {
            setStatus('failed');
            setError("Aucun visage détecté après 3 tentatives.");
            setTimeout(onFailure, 1000);
          } else {
            setStatus('idle');
            setError(`Aucun visage détecté. Tentative ${newAttempts}/3`);
            setCountdown(0);
            setCapturing(true);
          }
        }
      } catch (err) {
        console.error(err);
        setStatus('idle');
        setError("Erreur lors de l'analyse.");
      }
    }
  }, [webcamRef, onConfirm, onFailure, profile, attempts, location]);

  useEffect(() => {
    if (isOpen) {
      setAttempts(0);
      setError(null);
      setCapturing(true);
      setStatus('idle');
      
      // Automatic capture as soon as possible
      const initTimer = setTimeout(() => {
        setCountdown(0);
      }, 100);
      
      // Parallel location fetch
      getPreciseLocation().then(loc => {
        setLocation(loc);
      }).catch(err => {
        console.error("Location failed in modal:", err);
      });

      return () => clearTimeout(initTimer);
    } else {
      setCountdown(null);
      setCapturing(false);
      setLocation(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (countdown !== null && countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else if (countdown === 0 && capturing) {
      capture();
    }
  }, [countdown, capture, capturing]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }} 
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white rounded-3xl overflow-hidden max-w-md w-full shadow-2xl relative"
      >
        <div className={cn(
          "p-6 border-b border-gray-100 flex items-center justify-between text-white transition-colors duration-500",
          status === 'success' ? "bg-emerald-600" : status === 'failed' ? "bg-red-600" : "bg-blue-600"
        )}>
          <div className="flex items-center gap-3">
            {status === 'success' ? <CheckCircle2 className="w-6 h-6" /> : 
             status === 'failed' ? <AlertCircle className="w-6 h-6" /> : 
             <Scan className="w-6 h-6 animate-pulse" />}
            <h3 className="font-bold text-lg">
              {status === 'success' ? "Identité Confirmée" : 
               status === 'failed' ? "Échec de Vérification" : 
               status === 'locating' ? "Localisation..." :
               "Vérification Biométrique"}
            </h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="relative aspect-video bg-black">
          {/* @ts-ignore */}
          <Webcam
            audio={false}
            ref={webcamRef}
            screenshotFormat="image/jpeg"
            className="w-full h-full object-cover"
            videoConstraints={{ 
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }}
            onUserMedia={() => {
              // Trigger capture automatically once camera is ready
              setTimeout(() => setCountdown(0), 500);
            }}
            mirrored={true}
            playsInline={true}
          />
          
          {/* Scanning Line Animation */}
          {(status === 'analyzing' || status === 'idle') && (
            <motion.div 
              initial={{ top: 0 }}
              animate={{ top: '100%' }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="absolute left-0 right-0 h-1 bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.8)] z-10"
            />
          )}

          <div className="absolute inset-0 border-[40px] border-black/40 flex items-center justify-center">
            <div className={cn(
              "w-64 h-64 border-2 border-dashed rounded-full relative transition-colors duration-500",
              status === 'success' ? "border-emerald-400" : status === 'failed' ? "border-red-400" : "border-blue-400"
            )}>
              <div className={cn(
                "absolute inset-0 border-2 rounded-full animate-ping opacity-20",
                status === 'success' ? "border-emerald-500" : status === 'failed' ? "border-red-500" : "border-blue-500"
              )}></div>
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full pb-4">
                <span className={cn(
                  "text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-widest whitespace-nowrap transition-colors duration-500",
                  status === 'success' ? "bg-emerald-600" : status === 'failed' ? "bg-red-600" : "bg-blue-600"
                )}>
                  {status === 'success' ? "Reconnu" : status === 'failed' ? "Non reconnu" : "Positionnez votre visage"}
                </span>
              </div>
            </div>
          </div>

          {countdown !== null && countdown > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <motion.span 
                key={countdown}
                initial={{ scale: 2, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-8xl font-black text-white drop-shadow-2xl"
              >
                {countdown}
              </motion.span>
            </div>
          )}

          {(status === 'analyzing' || status === 'locating') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-blue-600/40 backdrop-blur-[2px]">
              <Loader2 className="w-12 h-12 text-white animate-spin mb-4" />
              <p className="text-white font-bold text-lg animate-pulse">
                {status === 'locating' ? "Récupération GPS..." : "Analyse Biométrique..."}
              </p>
            </div>
          )}

          {error && (
            <div className="absolute bottom-4 left-4 right-4 bg-red-600 text-white text-xs font-bold p-2 rounded-lg text-center shadow-lg animate-bounce">
              {error}
            </div>
          )}
        </div>

        <div className="p-6 bg-gray-50">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4" />
              Tentatives
            </div>
            <div className="flex gap-1">
              {[1, 2, 3].map(i => (
                <div key={i} className={cn(
                  "w-3 h-3 rounded-full border transition-colors",
                  attempts >= i ? "bg-red-500 border-red-600" : "bg-gray-200 border-gray-300"
                )}></div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-2 h-2 rounded-full",
              location ? "bg-emerald-500 animate-pulse" : "bg-gray-300"
            )} />
            <p className="text-xs font-medium text-gray-500">
              {location ? `GPS Prêt (${location.source})` : "Recherche GPS..."}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function AttendanceView({ profile, modelsLoaded }: { profile: UserProfile, modelsLoaded: boolean, key?: string }) {
  const [currentRecord, setCurrentRecord] = useState<Attendance | null>(null);
  const [loading, setLoading] = useState(false);
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const [showPreviewMap, setShowPreviewMap] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [manualLocation, setManualLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [lastSource, setLastSource] = useState<string | null>(null);
  const [showFaceAuth, setShowFaceAuth] = useState<{ type: 'in' | 'out', active: boolean }>({ type: 'in', active: false });

  const handleUpdateLiveLocation = async () => {
    if (!profile?.uid) {
      setGeoStatus("Erreur: Identifiant manquant.");
      return;
    }

    setLiveLoading(true);
    setGeoStatus("Mise à jour de votre position...");
    
    try {
      let location;
      if (manualLocation) {
        location = { latitude: manualLocation.lat, longitude: manualLocation.lng, source: 'manual' };
      } else {
        location = await getPreciseLocation();
      }

      setLastSource(location.source);

      if (location.source !== 'none') {
        const userRef = doc(db, 'users', profile.uid);
        await updateDoc(userRef, {
          lastLocation: {
            latitude: location.latitude,
            longitude: location.longitude,
            source: location.source,
            timestamp: serverTimestamp()
          }
        });
        setGeoStatus(`Position mise à jour (${location.source === 'gps' ? 'GPS' : location.source === 'manual' ? 'Manuel' : 'PC'}) !`);
      } else {
        setGeoStatus("Localisation impossible. Vérifiez vos réglages.");
      }
    } catch (error) {
      console.error('Live location update failed:', error);
      setGeoStatus("Erreur de connexion ou de permission.");
    } finally {
      setLiveLoading(false);
      setTimeout(() => setGeoStatus(null), 4000);
    }
  };

  useEffect(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    const q = query(
      collection(db, 'attendance'), 
      where('employeeId', '==', profile.uid),
      where('date', '==', today)
    );
    
    return onSnapshot(q, (snap) => {
      if (!snap.empty) {
        setCurrentRecord({ id: snap.docs[0].id, ...snap.docs[0].data() } as Attendance);
      } else {
        setCurrentRecord(null);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'attendance');
    });
  }, [profile]);

  const handleCheckIn = async () => {
    setShowFaceAuth({ type: 'in', active: true });
  };

  const handleCheckOut = async () => {
    setShowFaceAuth({ type: 'out', active: true });
  };

  const handleFaceAuthFailure = async () => {
    setShowFaceAuth({ ...showFaceAuth, active: false });
    setLoading(true);
    setGeoStatus("Enregistrement de l'absence...");
    
    const now = new Date();
    const today = format(now, 'yyyy-MM-dd');

    try {
      await addDoc(collection(db, 'attendance'), {
        employeeId: profile.uid,
        employeeName: profile.displayName,
        date: today,
        checkIn: serverTimestamp(),
        status: 'absent',
        note: 'Échec de reconnaissance faciale (3 tentatives)'
      });
      
      // Create admin notification
      await addDoc(collection(db, 'notifications'), {
        type: 'check-in',
        employeeName: profile.displayName,
        employeeId: profile.uid,
        timestamp: serverTimestamp(),
        read: false,
        message: `${profile.displayName} a échoué la reconnaissance faciale 3 fois. Marqué absent.`
      });

      alert("Pointage refusé : Identité non reconnue. Vous avez été marqué comme absent pour aujourd'hui.");
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'attendance');
    } finally {
      setLoading(false);
      setTimeout(() => setGeoStatus(null), 3000);
    }
  };

  const processCheckIn = async (photo: string, locationData?: any) => {
    if (loading) return; // Prevent double trigger
    setLoading(true);
    setShowFaceAuth({ ...showFaceAuth, active: false });
    
    const now = new Date();
    const today = format(now, 'yyyy-MM-dd');

    try {
      // Check if already checked in today to prevent duplicates
      const q = query(
        collection(db, 'attendance'),
        where('employeeId', '==', profile.uid),
        where('date', '==', today)
      );
      const existing = await getDocs(q);
      if (!existing.empty) {
        alert("Vous avez déjà pointé votre arrivée aujourd'hui.");
        return;
      }

      setGeoStatus("Finalisation du pointage...");
      
      let finalLocation = locationData;
      if (!finalLocation) {
        if (manualLocation) {
          finalLocation = { latitude: manualLocation.lat, longitude: manualLocation.lng, source: 'manual' };
        } else {
          finalLocation = await getPreciseLocation();
        }
      }

      setLastSource(finalLocation.source);

      const location = {
        latitude: finalLocation.latitude,
        longitude: finalLocation.longitude,
        locationSource: finalLocation.source
      };

      await addDoc(collection(db, 'attendance'), {
        employeeId: profile.uid,
        employeeName: profile.displayName,
        date: today,
        checkIn: serverTimestamp(),
        status: now.getHours() >= 9 ? 'late' : 'present',
        photoIn: photo,
        ...location
      });

      // Update live location for admin map
      if (finalLocation.source !== 'none') {
        await updateDoc(doc(db, 'users', profile.uid), {
          lastLocation: {
            latitude: finalLocation.latitude,
            longitude: finalLocation.longitude,
            source: finalLocation.source,
            timestamp: serverTimestamp()
          }
        });
      }

      // Create admin notification
      await addDoc(collection(db, 'notifications'), {
        type: 'check-in',
        employeeName: profile.displayName,
        employeeId: profile.uid,
        timestamp: serverTimestamp(),
        read: false,
        message: `${profile.displayName} vient de pointer son arrivée avec succès.`
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'attendance');
    } finally {
      setLoading(false);
      setTimeout(() => setGeoStatus(null), 3000);
    }
  };

  const processCheckOut = async (photo: string, locationData?: any) => {
    if (loading || !currentRecord) return;
    if (currentRecord.checkOut) {
      alert("Vous avez déjà pointé votre départ aujourd'hui.");
      return;
    }

    setLoading(true);
    setShowFaceAuth({ ...showFaceAuth, active: false });
    setGeoStatus("Finalisation du pointage...");
    
    try {
      let finalLocation = locationData;
      if (!finalLocation) {
        if (manualLocation) {
          finalLocation = { latitude: manualLocation.lat, longitude: manualLocation.lng, source: 'manual' };
        } else {
          finalLocation = await getPreciseLocation();
        }
      }

      setLastSource(finalLocation.source);

      const location = {
        latitudeOut: finalLocation.latitude,
        longitudeOut: finalLocation.longitude,
        locationOutSource: finalLocation.source
      };

      await updateDoc(doc(db, 'attendance', currentRecord.id), {
        checkOut: serverTimestamp(),
        photoOut: photo,
        ...location
      });

      // Update live location for admin map
      if (finalLocation.source !== 'none') {
        await updateDoc(doc(db, 'users', profile.uid), {
          lastLocation: {
            latitude: finalLocation.latitude,
            longitude: finalLocation.longitude,
            source: finalLocation.source,
            timestamp: serverTimestamp()
          }
        });
      }

      // Create admin notification
      await addDoc(collection(db, 'notifications'), {
        type: 'check-out',
        employeeName: profile.displayName,
        employeeId: profile.uid,
        timestamp: serverTimestamp(),
        read: false,
        message: `${profile.displayName} vient de pointer son départ avec succès.`
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `attendance/${currentRecord.id}`);
    } finally {
      setLoading(false);
      setTimeout(() => setGeoStatus(null), 3000);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900">Présence & Horaires</h2>
        <p className="text-gray-500">Enregistrez vos heures et consultez votre historique.</p>
      </div>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-8">
        <h3 className="text-lg font-bold mb-4">Pointer</h3>
        <div className="flex items-center gap-2 mb-4 text-[10px] font-bold uppercase tracking-wider">
          <div className={cn("w-2 h-2 rounded-full", geoStatus ? "bg-blue-500 animate-pulse" : "bg-emerald-500")}></div>
          <span className={geoStatus ? "text-blue-600" : "text-emerald-600"}>
            {geoStatus || "GPS Prêt"}
          </span>
        </div>
        <div className="flex flex-wrap gap-4">
          {!currentRecord ? (
            <button 
              onClick={handleCheckIn}
              disabled={loading || !modelsLoaded}
              className="flex-1 bg-emerald-600 text-white py-4 rounded-xl font-bold shadow-lg shadow-emerald-100 hover:bg-emerald-700 transition-all active:scale-95 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-6 h-6 animate-spin mx-auto" /> : !modelsLoaded ? "IA..." : "Arrivée"}
            </button>
          ) : !currentRecord.checkOut ? (
            <button 
              onClick={handleCheckOut}
              disabled={loading || !modelsLoaded}
              className="flex-1 bg-red-500 text-white py-4 rounded-xl font-bold shadow-lg shadow-red-100 hover:bg-red-600 transition-all active:scale-95 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-6 h-6 animate-spin mx-auto" /> : !modelsLoaded ? "IA..." : "Départ"}
            </button>
          ) : (
            <div className="flex-1 bg-gray-100 text-gray-500 py-4 rounded-xl font-bold text-center">
              Journée terminée
            </div>
          )}
          <button 
            onClick={() => setShowPreviewMap(!showPreviewMap)}
            className={cn(
              "px-4 rounded-xl transition-all flex items-center justify-center",
              showPreviewMap ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            )}
            title="Voir ma position sur la carte"
          >
            <Navigation className="w-6 h-6" />
          </button>
          <button 
            onClick={handleUpdateLiveLocation}
            disabled={liveLoading}
            className="px-4 bg-blue-50 text-blue-600 rounded-xl hover:bg-blue-100 transition-all flex items-center gap-2 font-bold text-xs"
            title="Envoyer ma position exacte actuelle à l'admin"
          >
            {liveLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crosshair className="w-4 h-4" />}
            Position Direct
          </button>
        </div>

        {lastSource === 'ip' && !manualLocation && (
          <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-800">
              <p className="font-bold mb-1">Position PC approximative détectée (Sidi Mhamed)</p>
              <p>La localisation par internet est souvent imprécise. Pour être exact à <strong>Souidania</strong>, cliquez sur la boussole bleue et déplacez le marqueur sur la carte.</p>
            </div>
          </div>
        )}

        {showPreviewMap && (
          <div className="mt-6 space-y-2">
            <p className="text-[10px] font-bold text-amber-600 bg-amber-50 p-2 rounded-lg border border-amber-100 uppercase tracking-wider">
              Note: Sur PC, cliquez sur la carte pour placer le marqueur exactement sur votre chantier.
            </p>
            <div className="h-64 rounded-2xl border border-gray-100 overflow-hidden shadow-inner relative">
              <MapContainer 
                center={[48.8566, 2.3522]} 
                zoom={15} 
                style={{ height: '100%', width: '100%' }}
                className="z-0"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapControls />
                <LocationMarker onLocationSelected={(lat, lng) => setManualLocation({ lat, lng })} />
              </MapContainer>
              <div className="absolute top-2 right-2 z-[400] bg-white/90 backdrop-blur px-2 py-1 rounded-lg text-[10px] font-bold text-blue-600 shadow-sm border border-blue-100">
                {manualLocation ? "POSITION MANUELLE FIXÉE" : "VOTRE POSITION ACTUELLE"}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex-1 bg-white rounded-2xl border border-gray-100 shadow-sm p-6 overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">Historique</h3>
        <RecentAttendance profile={profile} />
      </div>

      <FaceAuthModal 
        isOpen={showFaceAuth.active} 
        onClose={() => setShowFaceAuth({ ...showFaceAuth, active: false })}
        onConfirm={(photo, location) => {
          if (showFaceAuth.type === 'in') processCheckIn(photo, location);
          else processCheckOut(photo, location);
        }}
        onFailure={handleFaceAuthFailure}
        type={showFaceAuth.type}
        profile={profile}
      />
    </motion.div>
  );
}

function MapControls() {
  const map = useMap();
  const [loading, setLoading] = useState(false);

  const handleLocate = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!map) return;
    setLoading(true);
    try {
      const loc = await getPreciseLocation();
      if (loc.source !== 'none' && map) {
        map.flyTo([loc.latitude, loc.longitude], 16);
      }
    } finally {
      if (map) setLoading(false);
    }
  };

  return (
    <div className="absolute top-2 left-12 z-[400] flex flex-col gap-2">
      <button 
        onClick={handleLocate}
        disabled={loading}
        className="bg-white p-2 rounded-lg shadow-md border border-gray-100 text-gray-600 hover:text-blue-600 transition-colors disabled:opacity-50"
        title="Ma position"
      >
        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Crosshair className="w-5 h-5" />}
      </button>
    </div>
  );
}

function LocationMarker({ onLocationSelected }: { onLocationSelected?: (lat: number, lng: number) => void }) {
  const [position, setPosition] = useState<L.LatLng | null>(null);
  const map = useMap();

  useMapEvents({
    click(e) {
      if (onLocationSelected) {
        setPosition(e.latlng);
        onLocationSelected(e.latlng.lat, e.latlng.lng);
      }
    },
  });

  useEffect(() => {
    const initLoc = async () => {
      const loc = await getPreciseLocation();
      if (loc.source !== 'none' && map) {
        const latlng = L.latLng(loc.latitude, loc.longitude);
        setPosition(latlng);
        map.flyTo(latlng, map.getZoom());
      }
    };
    if (map) initLoc();
  }, [map]);

  return position === null ? null : (
    <Marker 
      key={`my-pos-${position.lat}-${position.lng}`}
      position={position} 
      draggable={!!onLocationSelected} 
      icon={defaultIcon}
      eventHandlers={{
        dragend: (e) => {
          const marker = e.target;
          const pos = marker.getLatLng();
          setPosition(pos);
          if (onLocationSelected) onLocationSelected(pos.lat, pos.lng);
        }
      }}
    >
      <Popup>
        {onLocationSelected ? "Votre position (Déplacez-moi si besoin)" : "Vous êtes ici"}
      </Popup>
    </Marker>
  );
}

function MapView({ profile }: { profile: UserProfile, key?: string }) {
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [team, setTeam] = useState<UserProfile[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('map');

  useEffect(() => {
    const qAtt = query(collection(db, 'attendance'), orderBy('checkIn', 'desc'), limit(50));
    const unsubAtt = onSnapshot(qAtt, (snap) => {
      setAttendance(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Attendance)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'attendance');
    });

    const unsubTeam = onSnapshot(collection(db, 'users'), (snap) => {
      setTeam(snap.docs.map(doc => doc.data() as UserProfile));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });

    return () => { unsubAtt(); unsubTeam(); };
  }, []);

  const recordsWithLocation = attendance.filter(r => (r.latitude && r.longitude) || (r.latitudeOut && r.longitudeOut));
  const liveLocations = team.filter(u => u.lastLocation && u.role === 'employee');

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Carte des Pointages</h2>
          <p className="text-gray-500">Visualisez la localisation de vos employés en temps réel.</p>
        </div>
        <div className="flex bg-gray-100 p-1 rounded-xl">
          <button 
            onClick={() => setViewMode('map')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-bold transition-all",
              viewMode === 'map' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            Carte
          </button>
          <button 
            onClick={() => setViewMode('list')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-bold transition-all",
              viewMode === 'list' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
            )}
          >
            Liste
          </button>
        </div>
      </div>

      {viewMode === 'map' ? (
        <div className="flex-1 bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden relative min-h-[500px]">
          <MapContainer 
            center={[48.8566, 2.3522]} 
            zoom={13} 
            style={{ height: '100%', width: '100%' }}
            className="z-0"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapControls />
            <LocationMarker />
            
            {/* Live Locations */}
            {liveLocations.map(member => {
              const isImprecise = member.lastLocation?.source === 'ip';
              return (
                <Marker 
                  key={`live-${member.uid}`} 
                  position={[member.lastLocation!.latitude, member.lastLocation!.longitude]}
                  icon={L.divIcon({
                    className: 'custom-div-icon',
                    html: `<div style="background-color: ${isImprecise ? '#f59e0b' : '#10b981'}; width: 12px; height: 12px; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 10px ${isImprecise ? '#f59e0b' : '#10b981'};"></div>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                  })}
                >
                  <Popup>
                    <div className="p-1">
                      <p className={cn("font-bold", isImprecise ? "text-amber-600" : "text-emerald-600")}>
                        {isImprecise ? "EN DIRECT (APPROX):" : "EN DIRECT (PRÉCIS):"} {member.displayName}
                      </p>
                      <p className="text-[10px] text-gray-500">
                        Mise à jour: {member.lastLocation?.timestamp && format(member.lastLocation.timestamp.toDate(), "HH:mm", { locale: fr })}
                      </p>
                      <div className={cn(
                        "mt-2 p-1.5 rounded-md text-[9px] font-bold uppercase",
                        isImprecise ? "bg-amber-50 text-amber-700 border border-amber-100" : "bg-emerald-50 text-emerald-700 border border-emerald-100"
                      )}>
                        Source: {isImprecise ? "PC / Réseau (Imprécis)" : member.lastLocation?.source === 'manual' ? "Manuel (Exact)" : "GPS (Précis)"}
                      </div>
                      {isImprecise && (
                        <p className="text-[9px] text-amber-600 mt-1 italic">Note: L'employé est sur PC, la position peut être décalée.</p>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}

            {recordsWithLocation.map(record => (
              <React.Fragment key={record.id}>
                {record.latitude && record.longitude && (
                  <Marker 
                    key={`in-${record.id}`}
                    position={[record.latitude, record.longitude]}
                    icon={record.locationSource === 'ip' ? L.divIcon({
                      className: 'custom-div-icon',
                      html: `<div style="background-color: #3b82f6; width: 10px; height: 10px; border: 2px solid white; border-radius: 50%; opacity: 0.7;"></div>`,
                      iconSize: [10, 10],
                      iconAnchor: [5, 5]
                    }) : defaultIcon}
                  >
                    <Popup>
                      <div className="p-1">
                        <p className="font-bold text-blue-600">Arrivée: {record.employeeName}</p>
                        <p className="text-xs text-gray-500">
                          {record.checkIn && format(record.checkIn.toDate(), "HH:mm", { locale: fr })}
                        </p>
                        <div className={cn(
                          "mt-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase inline-block",
                          record.locationSource === 'ip' ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"
                        )}>
                          {record.locationSource === 'ip' ? "Source: PC (Approximatif)" : `Source: ${record.locationSource || 'GPS'}`}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                )}
                {record.latitudeOut && record.longitudeOut && (
                  <Marker 
                    key={`out-${record.id}`}
                    position={[record.latitudeOut, record.longitudeOut]}
                    icon={record.locationOutSource === 'ip' ? L.divIcon({
                      className: 'custom-div-icon',
                      html: `<div style="background-color: #ef4444; width: 10px; height: 10px; border: 2px solid white; border-radius: 50%; opacity: 0.7;"></div>`,
                      iconSize: [10, 10],
                      iconAnchor: [5, 5]
                    }) : defaultIcon}
                  >
                    <Popup>
                      <div className="p-1">
                        <p className="font-bold text-red-600">Départ: {record.employeeName}</p>
                        <p className="text-xs text-gray-500">
                          {record.checkOut && format(record.checkOut.toDate(), "HH:mm", { locale: fr })}
                        </p>
                        <div className={cn(
                          "mt-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase inline-block",
                          record.locationOutSource === 'ip' ? "bg-amber-50 text-amber-600" : "bg-red-50 text-red-600"
                        )}>
                          {record.locationOutSource === 'ip' ? "Source: PC (Approximatif)" : `Source: ${record.locationOutSource || 'GPS'}`}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                )}
              </React.Fragment>
            ))}
          </MapContainer>
          <div className="absolute bottom-4 right-4 z-[400] bg-white p-3 rounded-xl shadow-lg border border-gray-100 max-w-[200px]">
            <p className="text-[10px] font-bold text-gray-400 uppercase mb-2">Légende</p>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
              <span className="text-xs text-gray-600">Arrivée</span>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-3 h-3 bg-red-500 rounded-full"></div>
              <span className="text-xs text-gray-600">Départ</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-emerald-500 rounded-full shadow-[0_0_5px_#10b981]"></div>
              <span className="text-xs text-gray-600 font-bold">En Direct</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 overflow-y-auto pr-2">
          {attendance.map(record => (
            <div key={record.id} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                  <MapPin className="w-6 h-6" />
                </div>
                <div>
                  <p className="font-bold text-gray-900">{record.employeeName}</p>
                  <p className="text-sm text-gray-500">
                    {record.checkIn && typeof record.checkIn.toDate === 'function' && format(record.checkIn.toDate(), "eeee d MMMM 'à' HH:mm", { locale: fr })}
                  </p>
                </div>
              </div>

              <div className="flex gap-2">
                {record.latitude && record.longitude ? (
                  <a 
                    href={`https://www.google.com/maps?q=${record.latitude},${record.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-blue-700 transition-all active:scale-95"
                  >
                    <LogIn className="w-4 h-4" />
                    Voir Arrivée {record.locationSource === 'ip' && "(PC)"}
                  </a>
                ) : (
                  <span className="text-xs text-gray-400 italic px-4 py-2">Pas de GPS (Arrivée)</span>
                )}

                {record.latitudeOut && record.longitudeOut ? (
                  <a 
                    href={`https://www.google.com/maps?q=${record.latitudeOut},${record.longitudeOut}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-red-600 text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-red-700 transition-all active:scale-95"
                  >
                    <LogOut className="w-4 h-4" />
                    Voir Départ {record.locationOutSource === 'ip' && "(PC)"}
                  </a>
                ) : record.checkOut ? (
                  <span className="text-xs text-gray-400 italic px-4 py-2">Pas de GPS (Départ)</span>
                ) : null}
              </div>
            </div>
          ))}
          {attendance.length === 0 && (
            <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-gray-200">
              <MapPin className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">Aucun pointage avec localisation pour le moment.</p>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function TeamView({ profile }: { profile: UserProfile, key?: string }) {
  const [team, setTeam] = useState<UserProfile[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newMember, setNewMember] = useState({ email: '', password: '', displayName: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referencePhoto, setReferencePhoto] = useState<string | null>(null);
  const [referenceDescriptor, setReferenceDescriptor] = useState<number[] | null>(null);
  const webcamRef = useRef<Webcam>(null);

  useEffect(() => {
    return onSnapshot(collection(db, 'users'), (snap) => {
      setTeam(snap.docs.map(doc => doc.data() as UserProfile));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });
  }, []);

  const handleCaptureReference = async () => {
    const imageSrc = webcamRef.current?.getScreenshot();
    if (imageSrc) {
      setReferencePhoto(imageSrc);
      try {
        const img = await faceapi.fetchImage(imageSrc);
        const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
        if (detection) {
          setReferenceDescriptor(Array.from(detection.descriptor));
          setError(null);
        } else {
          setError("Aucun visage détecté. Veuillez réessayer.");
          setReferencePhoto(null);
        }
      } catch (err) {
        setError("Erreur lors de l'analyse du visage.");
      }
    }
  };

  const handleCreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!referenceDescriptor) {
      setError("Veuillez capturer une photo de référence du visage.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 1. Create a secondary Firebase app to create the user without signing out the admin
      const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
      const secondaryAuth = getClientAuth(secondaryApp);

      try {
        // 2. Create the user in Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(
          secondaryAuth, 
          newMember.email, 
          newMember.password
        );
        const newUser = userCredential.user;

        // 3. Create the user profile in Firestore using the PRIMARY app (admin session)
        await setDoc(doc(db, 'users', newUser.uid), {
          uid: newUser.uid,
          email: newUser.email,
          displayName: newMember.displayName || 'Employé',
          photoURL: referencePhoto || '',
          role: 'employee',
          faceDescriptor: referenceDescriptor,
          createdAt: serverTimestamp()
        });

        // 4. Sign out from the secondary app and delete it
        await clientSignOut(secondaryAuth);
        await deleteApp(secondaryApp);

        setIsModalOpen(false);
        setNewMember({ email: '', password: '', displayName: '' });
        setReferencePhoto(null);
        setReferenceDescriptor(null);
        alert('Compte employé créé avec succès !');
      } catch (authError: any) {
        await deleteApp(secondaryApp);
        throw authError;
      }
    } catch (err: any) {
      console.error('Error creating member:', err);
      if (err.code === 'auth/email-already-exists' || err.code === 'auth/email-already-in-use') {
        setError('Cet email est déjà utilisé.');
      } else if (err.code === 'auth/weak-password') {
        setError('Le mot de passe est trop faible (min 6 caractères).');
      } else if (err.code === 'auth/operation-not-allowed') {
        setError("L'authentification Email/Mot de passe n'est pas activée dans votre console Firebase.");
      } else if (err.code === 'auth/too-many-requests') {
        setError("Trop de requêtes. Veuillez patienter avant de créer un autre compte.");
      } else {
        setError(err.message || 'Une erreur est survenue lors de la création.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Mon Équipe</h2>
          <p className="text-gray-500">Gérez les membres et leurs rôles.</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2 hover:bg-blue-700 transition-all active:scale-95"
        >
          <UserPlus className="w-5 h-5" />
          Ajouter un membre
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {team.map(member =>{team.map(member => (
  <div key={member.uid} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
    
    <div className="flex items-center gap-4">
      {member.photoURL && member.photoURL.trim() !== "" ? (
        <img src={member.photoURL} className="w-12 h-12 rounded-full border border-gray-200" alt="" />
      ) : (
        <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
          {member.displayName ? member.displayName.charAt(0) : '?'}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="font-bold text-gray-900 truncate">{member.displayName}</p>
        <p className="text-sm text-gray-500 truncate">{member.email}</p>

        <span className="inline-block mt-2 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
          {member.role}
        </span>
      </div>
    </div>

    <div className="flex gap-2 mt-4">
      <button
        onClick={() => {
          const name = prompt("Nouveau nom :", member.displayName);
          if(name){
            updateDoc(doc(db,"users",member.uid), { displayName:name });
          }
        }}
        className="flex-1 bg-blue-500 text-white py-2 rounded-xl text-sm font-bold"
      >
        Modifier
      </button>

      <button
        onClick={() => {
          if(confirm("Supprimer cet employé ?")){
            deleteDoc(doc(db,"users",member.uid));
          }
        }}
        className="flex-1 bg-red-500 text-white py-2 rounded-xl text-sm font-bold"
      >
        Supprimer
      </button>
    </div>

  </div>
))}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-gray-900 truncate">{member.displayName}</p>
              <p className="text-sm text-gray-500 truncate">{member.email}</p>
              <span className={cn(
                "inline-block mt-2 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full",
                member.role === 'admin' ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-700"
              )}>
                {member.role}
              </span>
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Ajouter un nouvel employé">
        <form onSubmit={handleCreateMember} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Photo de référence (Visage)</label>
            <div className="relative aspect-video bg-black rounded-xl overflow-hidden mb-2">
              {referencePhoto ? (
                <img src={referencePhoto} className="w-full h-full object-cover" alt="Reference" />
              ) : (
                /* @ts-ignore */
                <Webcam
                  audio={false}
                  ref={webcamRef}
                  screenshotFormat="image/jpeg"
                  className="w-full h-full object-cover"
                  videoConstraints={{ facingMode: "user" }}
                />
              )}
              {referencePhoto && (
                <button 
                  type="button"
                  onClick={() => { setReferencePhoto(null); setReferenceDescriptor(null); }}
                  className="absolute top-2 right-2 bg-red-600 text-white p-1 rounded-lg shadow-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {!referencePhoto && (
              <button 
                type="button"
                onClick={handleCaptureReference}
                className="w-full py-2 bg-blue-50 text-blue-600 rounded-xl font-bold text-sm border border-blue-100 hover:bg-blue-100 transition-all flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4" />
                Capturer le visage de référence
              </button>
            )}
            {referenceDescriptor && (
              <p className="text-[10px] text-emerald-600 font-bold mt-1 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Visage analysé et prêt pour la reconnaissance
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nom complet</label>
            <input 
              required
              type="text" 
              value={newMember.displayName}
              onChange={e => setNewMember({...newMember, displayName: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="Jean Dupont"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input 
              required
              type="email" 
              value={newMember.email}
              onChange={e => setNewMember({...newMember, email: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="employe@entreprise.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mot de passe provisoire</label>
            <input 
              required
              type="text" 
              value={newMember.password}
              onChange={e => setNewMember({...newMember, password: e.target.value})}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="••••••••"
            />
            <p className="text-[10px] text-gray-500 mt-1">L'employé pourra utiliser ce mot de passe pour sa première connexion.</p>
          </div>
          <button 
            disabled={loading}
            type="submit"
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Créer le compte"}
          </button>
        </form>
      </Modal>
    </motion.div>
  );
}

function ReportsView({ profile }: { profile: UserProfile, key?: string }) {
  const [startDate, setStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportCSV = async (type: 'attendance' | 'tasks') => {
    setExporting(true);
    setError(null);
    try {
      const start = Timestamp.fromDate(new Date(startDate));
      const end = Timestamp.fromDate(new Date(endDate + 'T23:59:59'));

      let q;
      if (type === 'attendance') {
        q = query(
          collection(db, 'attendance'),
          where('checkIn', '>=', start),
          where('checkIn', '<=', end),
          orderBy('checkIn', 'desc')
        );
      } else {
        q = query(
          collection(db, 'tasks'),
          where('createdAt', '>=', start),
          where('createdAt', '<=', end),
          orderBy('createdAt', 'desc')
        );
      }

      const snapshot = await getDocs(q);
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));

      if (data.length === 0) {
        setError("Aucune donnée trouvée pour cette période.");
        return;
      }

      let csvContent = "";
      if (type === 'attendance') {
        csvContent = "ID,Employe,Date,Arrivee,Depart,Statut,Latitude,Longitude,PhotoArrivee,PhotoDepart\n";
        data.forEach((row: any) => {
          const checkIn = row.checkIn?.toDate ? format(row.checkIn.toDate(), 'HH:mm:ss') : '';
          const checkOut = row.checkOut?.toDate ? format(row.checkOut.toDate(), 'HH:mm:ss') : '';
          const hasPhotoIn = row.photoIn ? "Oui" : "Non";
          const hasPhotoOut = row.photoOut ? "Oui" : "Non";
          csvContent += `${row.id},"${row.employeeName}",${row.date},${checkIn},${checkOut},${row.status},${row.latitude || ''},${row.longitude || ''},${hasPhotoIn},${hasPhotoOut}\n`;
        });
      } else {
        csvContent = "ID,Titre,Description,Assigne a,Assigne par,Statut,Cree le\n";
        data.forEach((row: any) => {
          const createdAt = row.createdAt?.toDate ? format(row.createdAt.toDate(), 'yyyy-MM-dd HH:mm:ss') : '';
          csvContent += `${row.id},"${row.title}","${row.description}","${row.assignedToName}","${row.assignedByName}",${row.status},${createdAt}\n`;
        });
      }

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `rapport_${type}_${startDate}_au_${endDate}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Export failed:", error);
      setError("Une erreur est survenue lors de l'exportation.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Rapports & Exportations</h2>
        <p className="text-gray-500">Générez des fichiers CSV pour vos archives et analyses.</p>
      </div>

      <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Date de début</label>
            <input 
              type="date" 
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Date de fin</label>
            <input 
              type="date" 
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
          <button 
            onClick={() => exportCSV('attendance')}
            disabled={exporting}
            className="flex items-center justify-center gap-3 bg-emerald-50 text-emerald-700 p-6 rounded-2xl border border-emerald-100 hover:bg-emerald-100 transition-all group"
          >
            <div className="w-12 h-12 bg-emerald-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-emerald-100 group-hover:scale-110 transition-transform">
              <Clock className="w-6 h-6" />
            </div>
            <div className="text-left">
              <p className="font-bold">Présences</p>
              <p className="text-xs opacity-70">Exporter au format CSV</p>
            </div>
            <Download className="w-5 h-5 ml-auto opacity-40 group-hover:opacity-100 transition-opacity" />
          </button>

          <button 
            onClick={() => exportCSV('tasks')}
            disabled={exporting}
            className="flex items-center justify-center gap-3 bg-blue-50 text-blue-700 p-6 rounded-2xl border border-blue-100 hover:bg-blue-100 transition-all group"
          >
            <div className="w-12 h-12 bg-blue-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-blue-100 group-hover:scale-110 transition-transform">
              <CheckSquare className="w-6 h-6" />
            </div>
            <div className="text-left">
              <p className="font-bold">Tâches</p>
              <p className="text-xs opacity-70">Exporter au format CSV</p>
            </div>
            <Download className="w-5 h-5 ml-auto opacity-40 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>

        {exporting && (
          <div className="flex items-center justify-center gap-2 text-blue-600 font-medium py-4">
            <Loader2 className="w-5 h-5 animate-spin" />
            Génération du fichier en cours...
          </div>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-100 p-6 rounded-2xl flex items-start gap-4">
        <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center shrink-0">
          <AlertCircle className="w-6 h-6" />
        </div>
        <div>
          <h4 className="font-bold text-blue-900">Note sur l'exportation</h4>
          <p className="text-sm text-blue-700 mt-1">
            Les fichiers CSV peuvent être ouverts avec Excel, Google Sheets ou tout autre tableur. 
            Les données exportées respectent la période sélectionnée ci-dessus.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function HRView({ profile }: { profile: UserProfile, key?: string }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSubTab, setActiveSubTab] = useState<'settings' | 'calculations' | 'leaves'>('settings');
  const [employees, setEmployees] = useState<UserProfile[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [calcResults, setCalcResults] = useState<any[]>([]);
  const [isCalcLoading, setIsCalcLoading] = useState(false);

  useEffect(() => {
    // Load settings
    const unsubSettings = onSnapshot(doc(db, 'settings', 'app_config'), (doc) => {
      try {
        if (doc.exists()) {
          setSettings(doc.data() as AppSettings);
        } else {
          // Default settings
          const defaultSettings: AppSettings = {
            workDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            workHours: {
              morning: { start: '08:00', end: '17:00' },
              evening: { start: '18:00', end: '02:00' }
            },
            overtimeRate: 1.5
          };
          const saveDefault = async () => {
            try {
              // @ts-ignore
              await setDoc(doc(db, 'settings', 'app_config'), defaultSettings);
            } catch (e) {
              console.error("Error saving default settings:", e);
            }
          };
          saveDefault();
          setSettings(defaultSettings);
        }
      } finally {
        setLoading(false);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'settings/app_config');
      setLoading(false); // Ensure we stop loading even on error
    });

    // Load employees
    const unsubEmployees = onSnapshot(collection(db, 'users'), (snap) => {
      setEmployees(snap.docs.map(doc => doc.data() as UserProfile));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });

    return () => {
      unsubSettings();
      unsubEmployees();
    };
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setLoading(true);
    try {
      // @ts-ignore
      await setDoc(doc(db, 'settings', 'app_config'), settings);
      alert("Paramètres RH mis à jour !");
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const calculateHours = async () => {
    setIsCalcLoading(true);
    try {
      const q = query(collection(db, 'attendance'), orderBy('date', 'desc'));
      const snap = await getDocs(q);
      const allAttendance = snap.docs.map(doc => doc.data() as Attendance);
      
      const results = employees.map(emp => {
        const empAttendance = allAttendance.filter(a => a.employeeId === emp.uid);
        let totalHours = 0;
        let totalOvertime = 0;
        let absences = 0;
        let presents = 0;

        empAttendance.forEach(record => {
          if (record.status === 'absent') {
            absences++;
          } else if (record.checkIn && record.checkOut) {
            presents++;
            const start = record.checkIn.toDate();
            const end = record.checkOut.toDate();
            const diffMs = end.getTime() - start.getTime();
            const hours = diffMs / (1000 * 60 * 60);
            
            totalHours += hours;
            if (hours > 8) {
              totalOvertime += (hours - 8);
            }
          }
        });

        return {
          ...emp,
          totalHours: totalHours.toFixed(2),
          totalOvertime: totalOvertime.toFixed(2),
          absences,
          presents
        };
      });

      setCalcResults(results);
    } catch (err) {
      console.error(err);
    } finally {
      setIsCalcLoading(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Système RH</h2>
          <p className="text-gray-500">Gérez les horaires, calculs et congés.</p>
        </div>
      </div>

      <div className="flex gap-2 p-1 bg-gray-100 rounded-xl w-fit">
        <button 
          onClick={() => setActiveSubTab('settings')}
          className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-all", activeSubTab === 'settings' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700")}
        >
          Paramètres
        </button>
        <button 
          onClick={() => setActiveSubTab('calculations')}
          className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-all", activeSubTab === 'calculations' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700")}
        >
          Calculs & Paie
        </button>
        <button 
          onClick={() => setActiveSubTab('leaves')}
          className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-all", activeSubTab === 'leaves' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700")}
        >
          Congés & Sorties
        </button>
      </div>

      {activeSubTab === 'settings' && settings && (
        <form onSubmit={handleSaveSettings} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-blue-600" />
                Jours de travail
              </h3>
              <div className="flex flex-wrap gap-2">
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      const newDays = settings.workDays.includes(day)
                        ? settings.workDays.filter(d => d !== day)
                        : [...settings.workDays, day];
                      setSettings({ ...settings, workDays: newDays });
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-bold border transition-all",
                      settings.workDays.includes(day) 
                        ? "bg-blue-600 text-white border-blue-600" 
                        : "bg-white text-gray-500 border-gray-200 hover:border-blue-200"
                    )}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <Calculator className="w-5 h-5 text-blue-600" />
                Taux Heures Sup (%)
              </h3>
              <input 
                type="number" 
                step="0.1"
                value={settings.overtimeRate}
                onChange={e => setSettings({ ...settings, overtimeRate: parseFloat(e.target.value) })}
                className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>

            <div className="space-y-4">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <Clock className="w-5 h-5 text-blue-600" />
                Horaires Matin
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Début</label>
                  <input 
                    type="time" 
                    value={settings.workHours.morning.start}
                    onChange={e => setSettings({ ...settings, workHours: { ...settings.workHours, morning: { ...settings.workHours.morning, start: e.target.value } } })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Fin</label>
                  <input 
                    type="time" 
                    value={settings.workHours.morning.end}
                    onChange={e => setSettings({ ...settings, workHours: { ...settings.workHours, morning: { ...settings.workHours.morning, end: e.target.value } } })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <Coffee className="w-5 h-5 text-blue-600" />
                Horaires Soir
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Début</label>
                  <input 
                    type="time" 
                    value={settings.workHours.evening.start}
                    onChange={e => setSettings({ ...settings, workHours: { ...settings.workHours, evening: { ...settings.workHours.evening, start: e.target.value } } })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase">Fin</label>
                  <input 
                    type="time" 
                    value={settings.workHours.evening.end}
                    onChange={e => setSettings({ ...settings, workHours: { ...settings.workHours, evening: { ...settings.workHours.evening, end: e.target.value } } })}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-gray-100">
            <button 
              type="submit"
              disabled={loading}
              className="bg-blue-600 text-white px-8 py-3 rounded-2xl font-bold hover:bg-blue-700 transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-blue-100"
            >
              Enregistrer les paramètres
            </button>
          </div>
        </form>
      )}

      {activeSubTab === 'calculations' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex items-center justify-between">
            <div>
              <h3 className="font-bold text-gray-900">Calculateur de Paie</h3>
              <p className="text-sm text-gray-500">Calculez les heures, absences et heures sup.</p>
            </div>
            <button 
              onClick={calculateHours}
              disabled={isCalcLoading}
              className="bg-emerald-600 text-white px-6 py-3 rounded-2xl font-bold hover:bg-emerald-700 transition-all flex items-center gap-2 shadow-lg shadow-emerald-100"
            >
              {isCalcLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Calculator className="w-5 h-5" />}
              Lancer le calcul
            </button>
          </div>

          {calcResults.length > 0 && (
            <div className="grid grid-cols-1 gap-4">
              {calcResults.map(res => (
                <div key={res.uid} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex flex-wrap items-center justify-between gap-6">
                  <div className="flex items-center gap-4 min-w-[200px]">
                    <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
                      {res.displayName.charAt(0)}
                    </div>
                    <div>
                      <p className="font-bold text-gray-900">{res.displayName}</p>
                      <p className="text-xs text-gray-500">{res.email}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-8 flex-1">
                    <div className="text-center">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Heures Totales</p>
                      <p className="text-lg font-black text-blue-600">{res.totalHours}h</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Heures Sup</p>
                      <p className="text-lg font-black text-amber-600">{res.totalOvertime}h</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Présences</p>
                      <p className="text-lg font-black text-emerald-600">{res.presents}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Absences</p>
                      <p className="text-lg font-black text-red-600">{res.absences}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'leaves' && (
        <div className="bg-white p-12 rounded-2xl border border-dashed border-gray-200 text-center">
          <Coffee className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-gray-900">Gestion des Congés</h3>
          <p className="text-gray-500 max-w-sm mx-auto mt-2">
            Le système de demande de congés et d'autorisations de sortie est en cours de déploiement.
          </p>
        </div>
      )}
    </motion.div>
  );
}
