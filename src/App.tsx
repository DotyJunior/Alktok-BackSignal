import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Radio, 
  Shield, 
  Map as MapIcon, 
  Activity, 
  Users, 
  Mic, 
  MicOff, 
  Settings, 
  Info, 
  ChevronRight, 
  Search, 
  Bell, 
  Terminal as TerminalIcon,
  Wifi,
  Lock,
  RefreshCcw,
  Eye,
  EyeOff,
  Signal,
  ArrowLeft,
  Volume2,
  Mail,
  User,
  LogOut,
  AlertCircle,
  Flame,
  AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { io, Socket } from 'socket.io-client';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AudioEngine } from './lib/audioEngine';
import { auth, db } from './lib/firebase';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  onAuthStateChanged, 
  signOut, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  serverTimestamp, 
  onSnapshot,
  getDocFromServer,
  deleteDoc
} from 'firebase/firestore';

// Types
type View = 'channels' | 'scanner' | 'reports' | 'status' | 'active-channel';
type AuthState = 'landing' | 'login' | 'register' | 'authenticated';

interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
}

interface Channel {
  id: string;
  name: string;
  activity: number;
  ops: number;
}

interface Operator {
  id: string;
  callsign: string;
  channel: string | null;
  status: 'IDLE' | 'TX' | 'RX';
  silent: boolean;
}

interface UserProfile {
  callsign: string;
  trustLevel: string;
  region: string;
  encryptionStatus: string;
  activityStatus: string;
}

// Error Handling
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
}

export default function App() {
  // Authentication / Identity
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authState, setAuthState] = useState<AuthState>('landing');
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [showPanicDialog, setShowPanicDialog] = useState(false);
  const [isPanicking, setIsPanicking] = useState(false);

  // Recovery Profile states
  const [profileNotFound, setProfileNotFound] = useState(false);
  const [recoveryCallsign, setRecoveryCallsign] = useState(generateCallsign());
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const handleRecoverProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsRecovering(true);
    setRecoveryError(null);
    try {
      const userDocRef = doc(db, 'users', user.uid);
      const newProfile: any = {
        callsign: (recoveryCallsign.trim() || generateCallsign()).toUpperCase(),
        trustLevel: 'Básico',
        region: '',
        encryptionStatus: 'Ativa',
        activityStatus: 'Online',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      await setDoc(userDocRef, newProfile);
      setProfileNotFound(false);
    } catch (err: any) {
      console.error('Error recovering profile:', err);
      setRecoveryError('Falha ao restaurar o perfil. Verifique sua conexão.');
    } finally {
      setIsRecovering(false);
    }
  };

  // App State
  const [currentView, setCurrentView] = useState<View>('channels');
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([
    { id: 'ch-07', name: 'CH-07 EMERGÊNCIA', activity: 12, ops: 0 },
    { id: 'ch-12', name: 'CH-12 REGIÃO 7B', activity: 5, ops: 0 },
    { id: 'ch-22', name: 'CH-22 TÁTICO', activity: 85, ops: 0 },
    { id: 'ch-31', name: 'CH-31 SUPRIMENTOS', activity: 20, ops: 0 },
    { id: 'ch-99', name: 'CH-99 BLACK SIGNAL', activity: 100, ops: 0 },
  ]);
  const [operators, setOperators] = useState<Operator[]>([]);
  
  // Audio & Communication
  const [isPttActive, setIsPttActive] = useState(false);
  const [isRxActive, setIsRxActive] = useState(false);
  const [rxFrom, setRxFrom] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const audioEngine = useRef<AudioEngine | null>(null);
  const analyzerRef = useRef<NodeJS.Timeout | null>(null);
  const [waveformData, setWaveformData] = useState<Uint8Array>(new Uint8Array(0));

  // Initialize Auth
  useEffect(() => {
    // Test Connection
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, '_health', 'check'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Firebase connection check failed: client is offline or config is invalid.");
        }
      }
    };
    testConnection();

    let unsubSnap: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      if (unsubSnap) {
        unsubSnap();
        unsubSnap = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (firebaseUser) {
        setAuthState('authenticated');
        // Fetch profile
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        unsubSnap = onSnapshot(userDocRef, (docSnap) => {
          if (docSnap.exists()) {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            setProfile(docSnap.data() as UserProfile);
            setProfileNotFound(false);
          } else {
            if (timer) {
              clearTimeout(timer);
            }
            timer = setTimeout(() => {
              setProfileNotFound(true);
            }, 1800);
          }
        }, (err) => {
          handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
          setProfileNotFound(true);
        });
      } else {
        setAuthState('landing');
        setProfile(null);
        setProfileNotFound(false);
      }
      setIsAuthLoading(false);
    });

    return () => {
      unsubscribe();
      if (unsubSnap) unsubSnap();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Initialize Socket and Audio
  useEffect(() => {
    if (authState !== 'authenticated' || !profile) return;

    const newSocket = io();
    setSocket(newSocket);
    audioEngine.current = new AudioEngine();

    newSocket.on('connect', () => {
      newSocket.emit('join-network', { callsign: profile.callsign });
      addLog(`SESSÃO INICIADA: ${profile.callsign}`);
    });

    newSocket.on('log-update', (msg: string) => {
      setLogs(prev => [{ id: Math.random().toString(), timestamp: new Date().toLocaleTimeString(), message: msg }, ...prev].slice(0, 50));
    });

    newSocket.on('operators-update', (ops: Operator[]) => {
      setOperators(ops);
    });

    newSocket.on('rx-start', ({ from }) => {
      setIsRxActive(true);
      setRxFrom(from);
      audioEngine.current?.playBeep(440, 0.05); // Receive beep
      audioEngine.current?.playNoise(0.18, 0.06); // RX Start white noise squelch
    });

    newSocket.on('rx-stop', () => {
      setIsRxActive(false);
      setRxFrom(null);
      audioEngine.current?.playBeep(330, 0.05); // End receive beep
      audioEngine.current?.playNoise(0.25, 0.08); // RX End white noise squelch
    });

    return () => {
      newSocket.disconnect();
      audioEngine.current?.close();
    };
  }, [authState, profile?.callsign]); // Re-init if identity changes (though rare in one session)

  // Update operator counts based on active operators list
  useEffect(() => {
    setChannels(prev => prev.map(ch => ({
      ...ch,
      ops: operators.filter(op => op.channel === ch.id && op.online !== false).length
    })));
  }, [operators]);

  // Handle PTT
  const handlePttStart = async () => {
    if (!audioEngine.current || !socket || !selectedChannel) return;
    
    // Request mic on first use
    const allowed = await audioEngine.current.startMic();
    if (!allowed) {
      addLog('PERMISSÃO DE MICROFONE NEGADA');
      return;
    }

    setIsPttActive(true);
    socket.emit('ptt-start');
    audioEngine.current.playBeep(880, 0.1); // PTT Start beep
    
    // Visualization
    analyzerRef.current = setInterval(() => {
      if (audioEngine.current) {
        setWaveformData(audioEngine.current.getAnalyzerData());
      }
    }, 50);
  };

  const handlePttEnd = () => {
    if (!socket || !isPttActive) return;
    setIsPttActive(false);
    socket.emit('ptt-stop');
    audioEngine.current?.playBeep(660, 0.1); // PTT Stop beep (lower)
    audioEngine.current?.stopMic(); // Stop and release the mic tracks completely on release
    
    if (analyzerRef.current) clearInterval(analyzerRef.current);
    setWaveformData(new Uint8Array(0));
  };

  const addLog = (message: string) => {
    setLogs(prev => [{ id: Math.random().toString(), timestamp: new Date().toLocaleTimeString(), message }, ...prev].slice(0, 50));
  }

  const handlePanic = async () => {
    setIsPanicking(true);
    try {
      if (user) {
        await deleteDoc(doc(db, 'users', user.uid));
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, user ? `users/${user.uid}` : null);
    } finally {
      setLogs([]);
      setIsPanicking(false);
      setShowPanicDialog(false);
      await signOut(auth);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex h-screen bg-tactical-bg items-center justify-center">
         <RefreshCcw className="w-8 h-8 text-tactical-green animate-spin" />
      </div>
    );
  }

  if (authState !== 'authenticated' || (user && !profile)) {
    return (
      <div className="flex flex-col h-screen max-w-lg mx-auto bg-tactical-bg relative overflow-hidden">
        <div className="tactical-grid absolute inset-0 opacity-20" />
        <div className="scanline" />
        <AnimatePresence mode="wait">
          {authState === 'landing' && <LandingView key="landing" onProceed={() => setAuthState('register')} />}
          {authState === 'register' && <AuthForm key="register" mode="register" onToggle={() => setAuthState('login')} onSuccess={() => setAuthState('authenticated')} />}
          {authState === 'login' && <AuthForm key="login" mode="login" onToggle={() => setAuthState('register')} onSuccess={() => setAuthState('authenticated')} />}
          {user && !profile && (
            profileNotFound ? (
              <div key="profile-not-found" className="flex flex-col h-full justify-center p-6 z-10 gap-6">
                <div className="border border-tactical-red bg-tactical-red/5 p-4 rounded flex flex-col gap-3 font-mono">
                  <div className="flex items-center gap-2 text-tactical-red font-bold text-xs tracking-wider animate-pulse">
                    <span>⚠️</span>
                    <span>ALERTA: PERFIL INEXISTENTE</span>
                  </div>
                  <p className="text-[10px] text-tactical-red/85 leading-relaxed uppercase">
                    O perfil tático de rádio correspondente a esta conta não pôde ser recuperado do banco de dados distribuído de canais do Black Signal.
                  </p>
                  <p className="text-[10px] opacity-60 leading-relaxed uppercase">
                    Causa provável: Uso recente do protocolo de autodestruição "PÂNICO", exclusão manual ou falha cadastral de sincronização.
                  </p>
                </div>

                <form onSubmit={handleRecoverProfile} className="flex flex-col gap-4 font-mono">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-semibold text-tactical-green uppercase tracking-wider">
                      Crie um novo Codinome de Operador para Reativar o rádio:
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        required
                        maxLength={18}
                        value={recoveryCallsign}
                        onChange={(e) => setRecoveryCallsign(e.target.value)}
                        placeholder="Ex: ALPHA-1"
                        className="flex-1 px-3 py-2 bg-black border border-tactical-green/30 text-tactical-green text-xs rounded focus:outline-none focus:border-tactical-green uppercase tracking-widest"
                      />
                      <button
                        type="button"
                        onClick={() => setRecoveryCallsign(generateCallsign())}
                        className="px-3 border border-tactical-green/30 text-tactical-green hover:border-tactical-green hover:bg-tactical-green/10 text-xs rounded flex items-center justify-center font-bold"
                        title="Gerar Aleatório"
                      >
                        🔀
                      </button>
                    </div>
                  </div>

                  {recoveryError && (
                    <span className="text-[10px] font-bold text-tactical-red font-mono uppercase">
                      {recoveryError}
                    </span>
                  )}

                  <button
                    type="submit"
                    disabled={isRecovering}
                    className="w-full py-2.5 bg-tactical-green text-black font-semibold text-xs rounded hover:bg-tactical-green/95 transition-all text-center tracking-widest flex items-center justify-center gap-2 uppercase active:scale-[0.98] cursor-pointer"
                  >
                    {isRecovering ? (
                      <RefreshCcw className="w-3 h-3 animate-spin" />
                    ) : (
                      <span>⚙️ ATIVAR E RECOMPOR PERFIL</span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => signOut(auth)}
                    className="w-full py-2 border border-tactical-red/30 hover:border-tactical-red hover:bg-tactical-red/10 text-tactical-red font-semibold text-[10px] rounded transition-all text-center tracking-widest uppercase active:scale-[0.98] cursor-pointer"
                  >
                    SAIR DA CONTA (MUDAR DE E-MAIL)
                  </button>
                </form>
              </div>
            ) : (
              <div key="loading-profile" className="flex flex-col h-full items-center justify-center z-10 gap-4">
                 <RefreshCcw className="w-8 h-8 text-tactical-green animate-spin" />
                 <span className="text-[10px] font-bold tracking-widest text-tactical-green animate-pulse uppercase">Recuperando Perfil Tático...</span>
              </div>
            )
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen max-w-lg mx-auto border-x border-tactical-border relative overflow-hidden bg-tactical-bg shadow-2xl shadow-tactical-green/10">
      <div className="tactical-grid absolute inset-0 pointer-events-none opacity-20" />
      <div className="scanline" />
      
      {/* Header */}
      <header className="p-4 bg-tactical-surface border-b border-tactical-border z-10 flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded border border-tactical-green flex items-center justify-center animate-pulse">
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xs font-bold font-display tracking-widest text-tactical-green">BLACK SIGNAL</h1>
              <p className="text-[10px] opacity-60 flex items-center gap-1 uppercase">
                Operador <span className="text-tactical-green font-bold">{profile.callsign}</span> • E2EE ATIVA
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="bg-tactical-green/10 border border-tactical-green/30 px-3 py-1 rounded text-[10px] flex items-center gap-2 hover:bg-tactical-green/20 transition-all active:scale-95">
              <EyeOff className="w-3 h-3" />
              VISÍVEL
            </button>
            <button 
              onClick={() => setShowPanicDialog(true)}
              className="bg-red-950/40 hover:bg-red-900/40 border border-red-500/30 hover:border-red-500/65 text-red-500 px-2 py-1 rounded text-[10px] font-bold tracking-widest flex items-center gap-1 transition-all active:scale-95"
            >
              <Flame className="w-3.5 h-3.5 text-red-500 animate-pulse" />
              PANIC
            </button>
            <button 
              onClick={() => signOut(auth)}
              className="bg-tactical-red/10 border border-tactical-red/30 p-1.5 rounded text-tactical-red hover:bg-tactical-red/20 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto z-10 relative custom-scrollbar">
        <AnimatePresence mode="wait">
          {currentView === 'channels' && (
            <motion.div 
              key="channels"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="p-4 flex flex-col gap-4"
            >
              <div className="flex justify-between items-center py-2 border-b border-tactical-border mb-2">
                <span className="text-[10px] opacity-40 font-bold uppercase tracking-tighter">// CANAIS TÁTICOS</span>
                <span className="text-[10px] opacity-60">{channels.length} ATIVOS</span>
              </div>
              {channels.map(channel => (
                <ChannelCard 
                  key={channel.id} 
                  channel={channel} 
                  onClick={() => {
                    setSelectedChannel(channel);
                    setCurrentView('active-channel');
                    socket?.emit('join-channel', channel.id);
                  }} 
                />
              ))}
            </motion.div>
          )}

          {currentView === 'active-channel' && selectedChannel && (
            <motion.div 
              key="active-channel"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              className="flex flex-col h-full bg-tactical-bg"
            >
              <div className="p-4 border-b border-tactical-border bg-tactical-surface/50 flex items-center justify-between">
                <button 
                  onClick={() => setCurrentView('channels')}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div className="text-center flex-1">
                  <div className="flex items-center justify-center gap-2">
                    {isRxActive && (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-tactical-amber opacity-75 shadow-[0_0_8px_#f59e0b]"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-tactical-amber shadow-[0_0_8px_#f59e0b]"></span>
                      </span>
                    )}
                    <h2 className={cn("text-sm font-bold transition-all duration-300", isRxActive ? "text-tactical-amber animate-pulse" : "text-tactical-green")}>
                      {selectedChannel.name}
                    </h2>
                  </div>
                  <p className="text-[10px] opacity-50 uppercase flex items-center justify-center gap-2 mt-0.5">
                    <Lock className="w-2.5 h-2.5" /> E2EE • {selectedChannel.ops} OPS • {isRxActive ? 'RECEBENDO' : 'IDLE'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Glowing RX LED Banner */}
                  {isRxActive && (
                    <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded bg-tactical-amber/10 border border-tactical-amber/30 animate-pulse">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-tactical-amber opacity-75 shadow-[0_0_8px_#f59e0b]"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-tactical-amber"></span>
                      </span>
                      <span className="text-[8px] font-mono font-bold text-tactical-amber tracking-widest">RX ACT</span>
                    </div>
                  )}
                  <div className={cn(
                    "w-10 h-10 rounded border flex items-center justify-center flex-col gap-0.5 transition-all duration-300",
                    isRxActive ? "border-tactical-amber bg-tactical-amber/10 text-tactical-amber" : "border-tactical-green/30 text-tactical-green"
                  )}>
                     {isRxActive ? (
                       <Volume2 className="w-3 h-3 text-tactical-amber animate-bounce" />
                     ) : (
                       <Eye className="w-3 h-3" />
                     )}
                     <span className="text-[8px] font-bold">
                       {isRxActive ? 'RX' : 'ATIVO'}
                     </span>
                  </div>
                </div>
              </div>

              {/* Waveform Visualization area */}
              <div className="flex-1 p-4 flex flex-col gap-4">
                <div className="h-24 bg-tactical-surface/30 border border-tactical-border rounded p-2 relative overflow-hidden flex items-center justify-center">
                  <div className="text-[10px] absolute top-2 left-2 opacity-30 flex items-center gap-1 uppercase">
                    <Activity className="w-3 h-3" /> {isRxActive ? 'RX RECEBENDO' : 'TX STANDBY'}
                  </div>
                  <div className="text-[10px] absolute top-2 right-2 opacity-30 uppercase">
                    50ms • 0% LOSS
                  </div>
                  
                  {/* Waveform Renderer */}
                  <div className="flex items-center gap-0.5 h-full w-full justify-center opacity-80">
                    {(isPttActive || isRxActive) ? (
                      Array.from({ length: 48 }).map((_, i) => (
                        <motion.div 
                          key={i}
                          className="w-1 bg-tactical-green rounded-full"
                          animate={{ 
                            height: isPttActive 
                              ? (waveformData[i % (waveformData.length || 1)] / 255) * 80 + 4 
                              : Math.random() * 40 + 4 
                          }}
                          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                        />
                      ))
                    ) : (
                      <div className="w-full h-[2px] bg-tactical-green/20" />
                    )}
                  </div>
                </div>

                {/* PTT Button */}
                <div className="flex-1 flex flex-col items-center justify-center gap-6">
                  <button
                    onMouseDown={handlePttStart}
                    onMouseUp={handlePttEnd}
                    onTouchStart={handlePttStart}
                    onTouchEnd={handlePttEnd}
                    className={cn(
                      "w-48 h-48 rounded-2xl border-2 flex flex-col items-center justify-center gap-4 transition-all active:scale-95 relative",
                      isPttActive 
                        ? "bg-tactical-red/20 border-tactical-red text-tactical-red shadow-[0_0_40px_rgba(255,62,62,0.3)] shadow-inner" 
                        : isRxActive
                          ? "bg-tactical-amber/20 border-tactical-amber text-tactical-amber animate-pulse"
                          : "bg-tactical-surface border-tactical-green/30 text-tactical-green hover:border-tactical-green/60 active:bg-tactical-green/10"
                    )}
                  >
                     <div className={cn(
                       "absolute -top-4 px-3 py-1 rounded bg-black border text-[10px] font-bold tracking-widest",
                       isPttActive ? "border-tactical-red text-tactical-red" : "border-tactical-green text-tactical-green"
                     )}>
                        {isPttActive ? 'TRANSMISSÃO ATIVA' : isRxActive ? `RECEBENDO DE ${rxFrom}` : 'RÁDIO PRONTO'}
                     </div>
                     
                     <div className="relative">
                       {isPttActive ? <Mic className="w-12 h-12" /> : <Volume2 className="w-12 h-12" />}
                       {isPttActive && (
                         <motion.div 
                           className="absolute -inset-4 rounded-full border border-tactical-red flex items-center justify-center"
                           animate={{ scale: [1, 1.5], opacity: [1, 0] }}
                           transition={{ repeat: Infinity, duration: 1 }}
                         />
                       )}
                     </div>

                     <div className="text-center">
                       <span className="text-sm font-bold uppercase tracking-widest">Push-to-Talk</span>
                       <p className="text-[10px] opacity-50 mt-1 uppercase">Segure para falar • Barra de Espaço</p>
                     </div>
                  </button>
                </div>

                {/* Active Operators in this channel */}
                <div className="bg-tactical-surface/30 border border-tactical-border rounded p-3 flex flex-col gap-2">
                  <span className="text-[9px] opacity-40 font-bold uppercase tracking-tighter self-start px-1">// OPERADORES ATIVOS • {selectedChannel.id.toUpperCase()}</span>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between p-2 rounded bg-tactical-green/5 border border-tactical-green/10">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-2 h-2 rounded-full", isPttActive ? 'bg-tactical-red animate-pulse' : 'bg-tactical-green')} />
                        <span className="text-xs font-bold">{profile.callsign}</span>
                        <span className="text-[9px] opacity-30 text-white">(VOCÊ)</span>
                      </div>
                      <div className="text-[10px] flex items-center gap-2 text-tactical-green/85">
                        <span className="w-1 h-1 rounded-full bg-tactical-green animate-pulse" />
                        <span className="font-mono font-bold text-[8px] tracking-widest">ONLINE</span>
                        <span className="opacity-30">•</span>
                        <span className="opacity-80 flex items-center gap-1">
                          <Radio className="w-3 h-3" /> {isPttActive ? 'TX' : 'STANDBY'}
                        </span>
                      </div>
                    </div>
                    {operators.filter(op => op.channel === selectedChannel.id && op.id !== socket?.id).map(op => {
                      const isOpOnline = op.online !== false;
                      return (
                        <div 
                          key={op.id} 
                          className={cn(
                            "flex items-center justify-between p-2 rounded transition-all duration-300",
                            isOpOnline 
                              ? "bg-white/5 border border-white/5 opacity-90" 
                              : "bg-black/25 border border-white/5 opacity-50"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <div className={cn(
                              "w-2 h-2 rounded-full",
                              !isOpOnline 
                                ? "bg-zinc-700" 
                                : op.status === 'TX' 
                                  ? 'bg-tactical-amber animate-pulse' 
                                  : 'bg-tactical-green/60'
                            )} />
                            <span className={cn("text-xs", !isOpOnline && "text-zinc-500 line-through decoration-zinc-800")}>{op.callsign}</span>
                          </div>
                          <div className="text-[10px] flex items-center gap-2">
                            {isOpOnline ? (
                              <div className="flex items-center gap-2 text-tactical-green/60">
                                <span className="w-1 h-1 rounded-full bg-tactical-green animate-pulse" />
                                <span className="font-mono font-bold text-[8px] tracking-widest">ONLINE</span>
                                <span className="opacity-30 text-white">•</span>
                                <span className="opacity-80 text-white flex items-center gap-1">
                                  <Radio className="w-2.5 h-2.5" /> {op.status}
                                </span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 text-red-500/50">
                                <span className="w-1 h-1 rounded-full bg-zinc-700" />
                                <span className="font-mono font-bold text-[8px] tracking-widest">OFFLINE</span>
                                <span className="opacity-30 text-white">•</span>
                                <span className="opacity-50 text-white flex items-center gap-1">
                                  <Radio className="w-2.5 h-2.5 text-zinc-800" /> COLD
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {currentView === 'scanner' && <ScannerView onTune={(ch) => { setSelectedChannel(ch); setCurrentView('active-channel'); socket?.emit('join-channel', ch.id); }} channels={channels} />}
          {currentView === 'reports' && <ReportsView />}
          {currentView === 'status' && <StatusView logs={logs} profile={profile} />}
        </AnimatePresence>
      </main>

      {/* Footer Nav */}
      <footer className="bg-tactical-surface border-t border-tactical-border z-20 flex p-1 pb-4">
        <NavButton active={currentView === 'channels'} onClick={() => setCurrentView('channels')} icon={<Radio />} label="CANAIS" />
        <NavButton active={currentView === 'scanner'} onClick={() => setCurrentView('scanner')} icon={<Activity />} label="VARRER" />
        <NavButton active={currentView === 'reports'} onClick={() => setCurrentView('reports')} icon={<MapIcon />} label="RELATOS" />
        <NavButton active={currentView === 'status'} onClick={() => setCurrentView('status')} icon={<Activity />} label="STATUS" />
      </footer>

      {/* Panic Modal Overlay */}
      <AnimatePresence>
        {showPanicDialog && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-55 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-sm border-2 border-red-500/80 bg-zinc-950 p-6 rounded-lg flex flex-col gap-4 relative shadow-2xl shadow-red-500/10 z-50"
            >
              <div className="absolute inset-0 border border-red-500/10 m-1 pointer-events-none rounded" />
              
              <div className="flex items-center gap-3 text-red-500">
                <AlertTriangle className="w-8 h-8 animate-pulse text-red-500 shrink-0" />
                <div>
                  <h2 className="text-sm font-extrabold tracking-widest uppercase">PROTOCOLO DE PÂNICO</h2>
                  <p className="text-[9px] text-red-400 font-mono tracking-wider">AÇÃO IRREVERSÍVEL • APAGAR REGISTROS</p>
                </div>
              </div>

              <div className="text-[11px] leading-relaxed text-zinc-300 font-mono border-y border-red-500/20 py-4 my-1">
                Ao confirmar, todos os logs serão limpos e seu documento de usuário <span className="text-red-400 font-bold bg-red-950/30 px-1 rounded">@{profile?.callsign || 'operador'}</span> será excluído permanentemente do Firestore. Você será deslogado instantaneamente.
              </div>

              <div className="flex gap-3 mt-2">
                <button
                  disabled={isPanicking}
                  onClick={() => setShowPanicDialog(false)}
                  className="flex-1 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 p-2 rounded text-[11px] font-bold tracking-wider uppercase transition-all"
                >
                  CANCELAR
                </button>
                <button
                  disabled={isPanicking}
                  onClick={handlePanic}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-mono font-bold p-2 rounded text-[11px] tracking-wider uppercase flex items-center justify-center gap-2 shadow-lg shadow-red-600/30 relative overflow-hidden transition-all duration-200 active:scale-95"
                >
                  {isPanicking ? (
                    <>
                      <RefreshCcw className="w-3.5 h-3.5 animate-spin" />
                      EXECUTANDO...
                    </>
                  ) : (
                    <>
                      <Flame className="w-3.5 h-3.5 animate-pulse" />
                      CONFIRMAR
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Sub-components
function ChannelCard({ channel, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className="group flex items-center gap-4 bg-white/5 border border-white/5 p-4 rounded-lg hover:bg-tactical-green/5 hover:border-tactical-green/20 transition-all active:scale-[0.98] text-left"
    >
      <div className="w-12 h-12 bg-black border border-tactical-green/10 flex items-center justify-center rounded group-hover:border-tactical-green/40">
        <Radio className={cn("w-6 h-6", channel.ops > 0 ? "text-tactical-green animate-pulse" : "opacity-30")} />
      </div>
      <div className="flex-1">
        <div className="flex justify-between items-start">
          <h3 className="text-sm font-bold text-tactical-green tracking-wide">{channel.name}</h3>
          <span className="text-[10px] px-2 rounded-full border border-tactical-green/20 text-tactical-green flex items-center gap-1 uppercase">
            <Lock className="w-2.5 h-2.5" /> E2EE
          </span>
        </div>
        <div className="flex items-center gap-4 mt-1 opacity-60 text-[10px] uppercase">
          <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {channel.ops} OPS</span>
          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
            <motion.div 
              className="h-full bg-tactical-green/40" 
              initial={{ width: 0 }}
              animate={{ width: `${channel.activity}%` }}
            />
          </div>
        </div>
      </div>
      <ChevronRight className="w-5 h-5 opacity-20 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
    </button>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex-1 flex flex-col items-center justify-center gap-1 p-2 transition-all relative overflow-hidden",
        active ? "text-tactical-green" : "text-white/40 hover:text-white/70"
      )}
    >
      {active && <motion.div layoutId="nav-active" className="absolute bottom-0 left-0 w-full h-1 bg-tactical-green" />}
      <div className={cn("transition-transform", active && "scale-110")}>{icon}</div>
      <span className="text-[10px] font-bold tracking-widest">{label}</span>
    </button>
  );
}

function ScannerView({ onTune, channels }: { onTune: (ch: Channel) => void, channels: Channel[] }) {
  const [isScanning, setIsScanning] = useState(true);
  const [scanIdx, setScanIdx] = useState(0);
  const [scanLogs, setScanLogs] = useState<string[]>([]);

  useEffect(() => {
    if (!isScanning) return;
    const interval = setInterval(() => {
      setScanIdx(p => (p + 1) % channels.length);
      const ch = channels[scanIdx];
      const logMsg = `[${new Date().toLocaleTimeString()}] VARRENDO ${ch.id.toUpperCase()} • ${ch.ops > 0 ? 'ATIVIDADE DETECTADA' : 'SILÊNCIO'}`;
      setScanLogs(p => [logMsg, ...p].slice(0, 15));
    }, 1500);
    return () => clearInterval(interval);
  }, [isScanning, scanIdx, channels]);

  return (
    <div className="p-4 flex flex-col gap-6 h-full">
       <div className="p-4 border-b border-tactical-border text-center">
         <h2 className="text-sm font-bold tracking-widest opacity-60 uppercase mb-4">Scanner Multi-Canal</h2>
         <div className="flex items-center justify-center gap-6">
           <div className="w-20 h-20 rounded-full border-2 border-tactical-green/20 flex items-center justify-center p-2">
              <Activity className={cn("w-10 h-10", isScanning && "animate-pulse text-tactical-green")} />
           </div>
           <div className="text-left">
             <div className="text-[10px] opacity-40 uppercase">Sintonizando</div>
             <div className="text-2xl font-display font-bold text-tactical-green">{channels[scanIdx].id.toUpperCase()}</div>
             <div className="text-xs opacity-60">{channels[scanIdx].name.split(' ')[1]}</div>
           </div>
         </div>
         <div className="flex gap-2 mt-6 justify-center">
           <button 
             onClick={() => setIsScanning(!isScanning)}
             className="px-6 py-2 border border-tactical-green/30 rounded text-xs font-bold uppercase bg-tactical-green/5"
           >
             {isScanning ? 'Parar' : 'Iniciar'}
           </button>
           <button 
             onClick={() => onTune(channels[scanIdx])}
             className="px-6 py-2 bg-tactical-green text-black rounded text-xs font-bold uppercase"
           >
             Sintonizar
           </button>
         </div>
       </div>

       <div className="flex-1 flex flex-col gap-2">
         <span className="text-[9px] opacity-40 font-bold uppercase tracking-tighter px-1">// LOG DE VARREDURA</span>
         <div className="bg-black/40 border border-tactical-border rounded p-4 flex-1 flex flex-col gap-1.5 custom-scrollbar overflow-y-auto">
            {scanLogs.map((log, i) => (
              <div key={i} className="text-[10px] opacity-80 animate-in fade-in slide-in-from-left-2 duration-300">
                {log}
              </div>
            ))}
            {scanLogs.length === 0 && <div className="text-[10px] opacity-20 italic">Aguardando tráfego...</div>}
         </div>
       </div>
    </div>
  );
}

function ReportsView() {
  const reports = [
    { time: '20:02', text: 'Intensa atividade de inspeção perto da BR-116 sentido sul.', type: 'AVISO' },
    { time: '19:40', text: 'Rede de suprimentos secundária operacional na zona norte.', type: 'INFO' },
    { time: '18:12', text: 'Interferência de rádio detectada na frequência CH-07.', type: 'SINAL' },
  ];

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex justify-between items-center py-2 border-b border-tactical-border">
         <span className="text-[10px] opacity-40 font-bold uppercase tracking-tighter">// RELATOS DA COMUNIDADE</span>
         <button className="text-[10px] text-tactical-green border border-tactical-green/30 px-2 py-0.5 rounded">+ NOVO RELATO</button>
      </div>
      
      <div className="flex flex-col gap-4">
        {reports.map((r, i) => (
          <div key={i} className="p-4 bg-tactical-surface/50 border-l-2 border-tactical-green border-tactical-border rounded-r-lg">
             <div className="flex justify-between items-center mb-2">
                <span className="text-[9px] bg-tactical-green/10 text-tactical-green px-1.5 py-0.5 rounded font-bold uppercase tracking-widest">{r.type}</span>
                <span className="text-[10px] opacity-40">{r.time} • HOJE</span>
             </div>
             <p className="text-sm opacity-90 leading-relaxed tracking-wide">{r.text}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 p-8 bg-black/30 border border-dashed border-tactical-border rounded-xl text-center opacity-40">
        <MapIcon className="w-8 h-8 mx-auto mb-2" />
        <span className="text-xs uppercase font-bold tracking-widest italic">Integração Map Center Desativada</span>
        <p className="text-[10px] mt-1">Nenhuma localização GPS rastreada. Apenas eventos regionais exibidos.</p>
      </div>
    </div>
  );
}

function StatusView({ logs, profile }: { logs: LogEntry[], profile: UserProfile }) {
  return (
    <div className="p-4 flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <StatusCard icon={<Wifi className="w-4 h-4" />} label="SINAL" value="ESTÁVEL" variant="green" />
        <StatusCard icon={<Activity className="w-4 h-4" />} label="LATÊNCIA" value="48 ms" variant="green" />
        <StatusCard icon={<Lock className="w-4 h-4" />} label="E2EE" value="ATIVA" variant="green" />
        <StatusCard icon={<Shield className="w-4 h-4" />} label="ROTEAMENTO" value="SEGURO" variant="green" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[9px] opacity-40 font-bold uppercase tracking-tighter px-1">// PERFIL DO OPERADOR</span>
        <div className="bg-tactical-surface/50 border border-tactical-border rounded p-4 grid grid-cols-2 gap-y-4 shadow-inner shadow-black">
           <SecurityItem label="INDICATIVO" value={profile.callsign} />
           <SecurityItem label="NÍVEL CONFIANÇA" value={profile.trustLevel} />
           <SecurityItem label="REGIÃO" value={profile.region || 'NÃO DEFINIDA'} />
           <SecurityItem label="CRIPTO" value={profile.encryptionStatus} />
           <SecurityItem label="ATIVIDADE" value={profile.activityStatus} />
           <SecurityItem label="STATUS REDE" value="SINCRO" />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 overflow-hidden">
        <span className="text-[9px] opacity-40 font-bold uppercase tracking-tighter px-1 flex justify-between items-center">
          <span>// TERMINAL LIVE FEED</span>
          <span className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-tactical-green rounded-full animate-pulse" /> CONECTADO</span>
        </span>
        <div className="bg-black border border-tactical-border rounded p-4 flex-1 font-mono text-[10px] overflow-y-auto custom-scrollbar">
           {logs.map((log) => (
             <div key={log.id} className="mb-1.5 flex gap-2">
               <span className="opacity-20">[{log.timestamp}]</span>
               <span className="opacity-80 uppercase tracking-tighter">{log.message}</span>
             </div>
           ))}
           {logs.length === 0 && <div className="opacity-20 italic">[--:--:--] Aguardando tráfego...</div>}
        </div>
      </div>
    </div>
  );
}

function StatusCard({ icon, label, value, variant }: { icon: React.ReactNode, label: string, value: string, variant: 'green' | 'amber' }) {
  return (
    <div className="p-3 bg-tactical-surface/50 border border-tactical-border rounded flex flex-col gap-1">
      <div className="flex justify-between items-center opacity-40">
        <span className="text-[8px] font-bold uppercase tracking-widest">{label}</span>
        {icon}
      </div>
      <div className={cn("text-sm font-bold uppercase tracking-tighter", variant === 'green' ? 'text-tactical-green' : 'text-tactical-amber')}>
        {value}
      </div>
    </div>
  );
}

function SecurityItem({ label, value, variant }: { label: string, value: string, variant?: 'dim' }) {
  return (
    <div>
       <div className="text-[8px] opacity-30 font-bold mb-1 uppercase tracking-widest">{label}</div>
       <div className={cn("text-xs font-bold uppercase tracking-tighter", variant === 'dim' ? 'opacity-40' : 'text-tactical-green')}>
         {value}
       </div>
    </div>
  );
}

function LandingView({ onProceed }: any) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="flex flex-col h-full p-8 items-center justify-center relative z-10"
    >
        <div className="text-center space-y-4 mb-12">
          <motion.div 
            animate={{ scale: [1, 1.05, 1], rotate: [0, 1, 0, -1, 0] }}
            transition={{ repeat: Infinity, duration: 4 }}
            className="w-24 h-24 mx-auto border-2 border-tactical-green rounded-full flex items-center justify-center p-4 relative"
          >
             <div className="absolute inset-0 rounded-full border border-tactical-green/20 animate-ping" />
             <Radio className="w-12 h-12 text-tactical-green drop-shadow-[0_0_8px_rgba(0,255,65,0.8)]" />
          </motion.div>
          <div>
            <h1 className="text-2xl font-bold font-display tracking-[0.3em] text-tactical-green mb-1">BLACK SIGNAL</h1>
            <p className="text-[10px] opacity-50 uppercase tracking-[0.2em]">COMUNICAÇÃO TÁTICA SEGURA</p>
          </div>
        </div>

        <div className="bg-tactical-surface border border-tactical-border p-6 rounded-lg w-full">
           <div className="space-y-6">
              <div className="flex items-start gap-4 p-3 bg-white/5 rounded border border-white/5">
                 <Shield className="w-8 h-8 text-tactical-green/60 mt-1" />
                 <p className="text-[11px] leading-relaxed opacity-70">
                   Você vai operar com um <span className="text-tactical-green font-bold">indicativo tático</span>. Nenhum nome real, email ou localização será coletado para consumo externo. Tráfego de voz é cifrado fim-a-fim.
                 </p>
              </div>

              <button 
                onClick={onProceed}
                className="w-full bg-tactical-green/10 border border-tactical-green text-tactical-green font-display py-4 rounded font-bold tracking-widest hover:bg-tactical-green hover:text-black transition-all active:scale-95 flex items-center justify-center gap-3"
              >
                ENTRAR NA REDE <ChevronRight className="w-5 h-5" />
              </button>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 opacity-40 text-[9px] font-bold uppercase tracking-tighter pt-4 border-t border-tactical-border">
                <div className="flex items-center gap-2">• SINCRO E2EE</div>
                <div className="flex items-center gap-2">• ANONIMATO INTEGRAL</div>
                <div className="flex items-center gap-2">• ZERO LOG IP</div>
                <div className="flex items-center gap-2">• SEM RASTREIO GPS</div>
              </div>
           </div>
        </div>
    </motion.div>
  );
}

function AuthForm({ mode, onToggle, onSuccess }: any) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [callsign, setCallsign] = useState(generateCallsign());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      if (mode === 'register') {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        // Create profile in Firestore
        const userDocRef = doc(db, 'users', user.uid);
        const newProfile: any = {
          callsign: callsign.trim() || generateCallsign(),
          trustLevel: 'Básico',
          region: '',
          encryptionStatus: 'Ativa',
          activityStatus: 'Online',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        
        await setDoc(userDocRef, newProfile);
        onSuccess();
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        onSuccess();
      }
    } catch (err: any) {
      let friendlyMessage = 'Erro operacional detectado.';
      
      switch (err.code) {
        case 'auth/email-already-in-use':
          friendlyMessage = 'Este e-mail já está em uso na rede.';
          break;
        case 'auth/weak-password':
          friendlyMessage = 'Cifra muito curta. Use no mínimo 6 caracteres.';
          break;
        case 'auth/invalid-email':
          friendlyMessage = 'Formato de e-mail inválido.';
          break;
        case 'auth/user-not-found':
        case 'auth/wrong-password':
          friendlyMessage = 'Credenciais táticas inválidas.';
          break;
        case 'auth/operation-not-allowed':
          friendlyMessage = 'Provedor E-mail/Senha bloqueado. Ative no Console Firebase.';
          break;
        case 'permission-denied':
          friendlyMessage = 'Acesso ao banco de dados negado pela segurança.';
          break;
        default:
          friendlyMessage = err.message || 'Falha na sincronização.';
      }
      
      setError(friendlyMessage);
      console.error('Auth Error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex flex-col h-full p-8 items-center justify-center relative z-10"
    >
      <div className="w-full bg-tactical-surface border border-tactical-border p-6 rounded-lg space-y-6">
        <div className="flex justify-between items-center mb-4">
           <span className="text-[10px] opacity-40 font-bold uppercase tracking-tighter">// {mode.toUpperCase()} • HANDSHAKE</span>
           <button onClick={onToggle} className="text-[10px] text-tactical-green hover:underline uppercase tracking-widest">
             {mode === 'login' ? 'CADASTRAR' : 'LOGAR'}
           </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
             <label className="text-[9px] opacity-40 uppercase font-bold px-1">Email de Acesso</label>
             <div className="relative">
               <Mail className="absolute left-3 top-3.5 w-4 h-4 opacity-30" />
               <input 
                 type="email"
                 required
                 value={email}
                 onChange={(e) => setEmail(e.target.value)}
                 className="w-full bg-black border border-tactical-border p-3 pl-10 rounded text-sm text-tactical-green outline-none focus:border-tactical-green/50"
                 placeholder="operador@protonmail.me"
               />
             </div>
             {mode === 'register' && (
               <p className="text-[9px] opacity-50 px-1 mt-1 leading-tight">
                 Para máxima privacidade operacional, recomendamos o uso de um provedor de e-mail seguro como o (<span className="text-tactical-green">ProtonMail.me</span>)
               </p>
             )}
          </div>

          <div className="space-y-1">
             <label className="text-[9px] opacity-40 uppercase font-bold px-1">Cifra de Acesso</label>
             <div className="relative">
               <Lock className="absolute left-3 top-3.5 w-4 h-4 opacity-30" />
               <input 
                 type="password"
                 required
                 value={password}
                 onChange={(e) => setPassword(e.target.value)}
                 className="w-full bg-black border border-tactical-border p-3 pl-10 rounded text-sm text-tactical-green outline-none focus:border-tactical-green/50"
                 placeholder="••••••••"
               />
             </div>
          </div>

          {mode === 'register' && (
            <div className="space-y-1">
               <label className="text-[9px] opacity-40 uppercase font-bold px-1">Indicativo Tático</label>
               <div className="flex gap-2">
                 <div className="relative flex-1">
                   <User className="absolute left-3 top-3.5 w-4 h-4 opacity-30" />
                   <input 
                     value={callsign}
                     onChange={(e) => setCallsign(e.target.value.toUpperCase())}
                     className="w-full bg-black border border-tactical-border p-3 pl-10 rounded text-sm text-tactical-green outline-none focus:border-tactical-green/50 font-display tracking-widest"
                   />
                 </div>
                 <button 
                   type="button" 
                   onClick={() => setCallsign(generateCallsign())}
                   className="p-3 border border-tactical-border rounded hover:bg-white/5"
                 >
                   <RefreshCcw className="w-4 h-4 opacity-60" />
                 </button>
               </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-tactical-red/10 border border-tactical-red/30 rounded flex items-center gap-3 text-tactical-red text-[10px] font-bold">
               <AlertCircle className="w-4 h-4 shrink-0" />
               {error}
            </div>
          )}

          <button 
            type="submit"
            disabled={isLoading}
            className="w-full bg-tactical-green text-black font-display py-3 rounded font-bold tracking-widest hover:brightness-110 transition-all active:scale-95 disabled:opacity-50 mt-4 uppercase border-b-2 border-black/40"
          >
            {isLoading ? 'SINCRONIZANDO...' : mode === 'login' ? 'Entrar na Rede' : 'Finalizar Registro'}
          </button>
        </form>
      </div>
    </motion.div>
  );
}

// Keeping those helpers
const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
const CALLSIGN_PREFIXES = ['NOMAD', 'SHADOW', 'PHANTOM', 'WATCHTOWER', 'VANGUARD', 'REAPER', 'SPECTRE', 'TITAN', 'GHOST', 'RAVEN'];
const generateCallsign = () => {
  const prefix = CALLSIGN_PREFIXES[Math.floor(Math.random() * CALLSIGN_PREFIXES.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${prefix}_${num}`;
};
