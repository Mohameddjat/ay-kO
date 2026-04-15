import React, { useEffect, useRef, useState, useMemo } from 'react';
import Matter from 'matter-js';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, 
  Play, 
  RotateCcw, 
  Thermometer, 
  Zap, 
  AlertTriangle, 
  Users, 
  Trophy,
  ShoppingCart,
  Coins,
  Flame,
  Wind,
  Check
} from 'lucide-react';
import { Gear, PlayerState, GameRoom } from './types';

const GRID_COLS = 12;
const GRID_ROWS = 3;
const CELL_SIZE = 40;
const GEAR_TYPES = [8, 16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 256];

const GearIcon = ({ teeth, color, className, rotation = 0 }: { teeth: number, color: string, className?: string, rotation?: number }) => {
  const points = [];
  const innerRadius = 30;
  const outerRadius = 45;
  const toothCount = teeth;
  
  for (let i = 0; i < toothCount * 2; i++) {
    const angle = (i * Math.PI) / toothCount;
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    points.push(`${Math.cos(angle) * r},${Math.sin(angle) * r}`);
  }
  
  return (
    <svg viewBox="-50 -50 100 100" className={className} style={{ transform: `rotate(${rotation}deg)` }}>
      <defs>
        <radialGradient id="gearGradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.2)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.2)" />
        </radialGradient>
      </defs>
      <polygon
        points={points.join(' ')}
        fill={color}
        stroke="currentColor"
        strokeWidth="2"
        className="transition-all duration-300"
      />
      <circle cx="0" cy="0" r="15" fill="url(#gearGradient)" />
      <circle cx="0" cy="0" r="5" fill="white" />
      {/* Mechanical details */}
      <circle cx="0" cy="0" r="25" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" strokeDasharray="2 4" />
    </svg>
  );
};

const EngineVisual = ({ className }: { className?: string }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-[#1a1a1a] p-4 rounded-2xl border border-blue-500/30 shadow-lg shadow-blue-500/10">
        <Zap className="w-8 h-8 text-blue-400" />
      </div>
    </div>
    <span className="text-[10px] font-black text-blue-400/60 uppercase tracking-tighter">V8 ENGINE</span>
  </div>
);

const WheelVisual = ({ className }: { className?: string }) => (
  <div className={`flex flex-col items-center gap-2 ${className}`}>
    <div className="relative">
      <div className="absolute -inset-4 bg-green-500/20 blur-xl rounded-full animate-pulse" />
      <div className="relative bg-[#1a1a1a] p-4 rounded-2xl border border-green-500/30 shadow-lg shadow-green-500/10">
        <RotateCcw className="w-8 h-8 text-green-400" />
      </div>
    </div>
    <span className="text-[10px] font-black text-green-400/60 uppercase tracking-tighter">DRIVE WHEEL</span>
  </div>
);

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomId, setRoomId] = useState('main-race');
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [otherPlayers, setOtherPlayers] = useState<Record<string, PlayerState>>({});
  const [gears, setGears] = useState<Gear[]>([
    { id: '0-1', x: 0, y: 1, teeth: 16, type: 'intermediate' },
    { id: '1-1', x: 1, y: 1, teeth: 16, type: 'intermediate' },
    { id: '2-1', x: 2, y: 1, teeth: 32, type: 'intermediate' },
    { id: '3-1', x: 3, y: 1, teeth: 32, type: 'intermediate' },
    { id: '4-1', x: 4, y: 1, teeth: 48, type: 'intermediate' },
    { id: '5-1', x: 5, y: 1, teeth: 48, type: 'intermediate' },
    { id: '6-1', x: 6, y: 1, teeth: 64, type: 'intermediate' },
    { id: '7-1', x: 7, y: 1, teeth: 64, type: 'intermediate' },
    { id: '8-1', x: 8, y: 1, teeth: 80, type: 'intermediate' },
    { id: '9-1', x: 9, y: 1, teeth: 96, type: 'intermediate' },
    { id: '10-1', x: 10, y: 1, teeth: 128, type: 'intermediate' },
    { id: '11-1', x: 11, y: 1, teeth: 128, type: 'intermediate' },
  ]);
  const [gameState, setGameState] = useState<'setup' | 'racing' | 'exploded' | 'finished'>('setup');
  const [isGarageOpen, setIsGarageOpen] = useState(true);
  const [gearRatio, setGearRatio] = useState(1);
  const [engineTemp, setEngineTemp] = useState(20);
  const [brakeTemp, setBrakeTemp] = useState(20);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [isAccelerating, setIsAccelerating] = useState(false);
  const [isAutoDrive, setIsAutoDrive] = useState(true);
  const [isBraking, setIsBraking] = useState(false);
  const [playerLane, setPlayerLane] = useState(0); // -1, 0, 1
  const [targetLane, setTargetLane] = useState(0);
  const [obstacles, setObstacles] = useState<{ id: string, lane: number, z: number, type: string }[]>([]);
  const [distance, setDistance] = useState(0);
  const [showInstructions, setShowInstructions] = useState(true);
  const [connectedGears, setConnectedGears] = useState<string[]>([]);
  const [selectedGearId, setSelectedGearId] = useState<string | null>(null);
  const [presets, setPresets] = useState<{ name: string, gears: Gear[] }[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 400 });
  const [credits, setCredits] = useState(() => {
    const saved = localStorage.getItem('gear_race_credits');
    return saved ? parseInt(saved) : 0;
  });
  const [upgrades, setUpgrades] = useState<{ id: string, level: number }[]>(() => {
    const saved = localStorage.getItem('gear_race_upgrades');
    return saved ? JSON.parse(saved) : [];
  });

  const [boostTime, setBoostTime] = useState(0);
  const [lastBoostType, setLastBoostType] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const playerBodyRef = useRef<Matter.Body | null>(null);
  const wheelARef = useRef<Matter.Body | null>(null);
  const wheelBRef = useRef<Matter.Body | null>(null);
  const particlesRef = useRef<{ x: number, y: number, vx: number, vy: number, life: number, color: string }[]>([]);
  
  const controlsRef = useRef({
    isAccelerating: false,
    isAutoDrive: true,
    isBraking: false,
    connectedGears: [] as string[]
  });

  useEffect(() => {
    controlsRef.current.isAccelerating = isAccelerating;
    controlsRef.current.isAutoDrive = isAutoDrive;
    controlsRef.current.isBraking = isBraking;
    controlsRef.current.connectedGears = connectedGears;
  }, [isAccelerating, isAutoDrive, isBraking, connectedGears]);

  useEffect(() => {
    localStorage.setItem('gear_race_credits', credits.toString());
  }, [credits]);

  useEffect(() => {
    localStorage.setItem('gear_race_upgrades', JSON.stringify(upgrades));
  }, [upgrades]);

  const SHOP_ITEMS = [
    { id: 'titanium_gears', name: 'Titanium Gears', description: 'Removes efficiency penalty from gear chains.', price: 500, icon: <Settings className="w-5 h-5" /> },
    { id: 'super_cooler', name: 'Super Cooler', description: 'Reduces engine heat generation by 40%.', price: 300, icon: <Zap className="w-5 h-5" /> },
    { id: 'nitro_system', name: 'Nitro System', description: 'Increases base torque by 25%.', price: 450, icon: <Flame className="w-5 h-5" /> },
    { id: 'aero_chassis', name: 'Aero Chassis', description: 'Reduces air resistance at high speeds.', price: 600, icon: <Wind className="w-5 h-5" /> },
  ];

  const hasUpgrade = (id: string) => upgrades.some(u => u.id === id);

  const buyItem = (item: typeof SHOP_ITEMS[0]) => {
    if (credits >= item.price && !hasUpgrade(item.id)) {
      setCredits(prev => prev - item.price);
      setUpgrades(prev => [...prev, { id: item.id, level: 1 }]);
    }
  };

  // Keyboard Controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') setIsAccelerating(true);
      if (e.key === 'ArrowDown' || e.key === 's') setIsBraking(true);
      
      if (gameState === 'racing') {
        if (e.key === 'ArrowLeft' || e.key === 'a') setTargetLane(prev => Math.max(-1, prev - 1));
        if (e.key === 'ArrowRight' || e.key === 'd') setTargetLane(prev => Math.min(1, prev + 1));
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ') setIsAccelerating(false);
      if (e.key === 'ArrowDown' || e.key === 's') setIsBraking(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Initialize Socket
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('connect', () => {
      newSocket.emit('join-room', roomId);
    });

    newSocket.on('room-state', (room: GameRoom) => {
      const myState = room.players[newSocket.id!];
      if (myState) setPlayerState(myState);
      
      const others = { ...room.players };
      delete others[newSocket.id!];
      setOtherPlayers(others);
    });

    newSocket.on('player-updated', (player: PlayerState) => {
      setOtherPlayers(prev => ({ ...prev, [player.id]: player }));
    });

    newSocket.on('player-left', (id: string) => {
      setOtherPlayers(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    return () => {
      newSocket.disconnect();
    };
  }, [roomId]);

  // Gear Connectivity Logic (BFS)
  useEffect(() => {
    if (gears.length === 0) {
      setGearRatio(0);
      setIsConnected(false);
      setConnectedGears([]);
      return;
    }

    const gearMap = new Map<string, Gear>(gears.map(g => [g.id, g]));
    const visited = new Set<string>();
    const queue: string[] = [];

    // Start with gears in column 0
    gears.filter(g => g.x === 0).forEach(g => {
      queue.push(g.id);
      visited.add(g.id);
    });

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = gearMap.get(currentId) as Gear;
      if (!current) continue;

      // Check neighbors (8 directions)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = current.x + dx;
          const ny = current.y + dy;
          const neighborId = `${nx}-${ny}`;
          
          if (gearMap.has(neighborId) && !visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
      }
    }

    const connectedList = Array.from(visited);
    setConnectedGears(connectedList);

    const reachableEndGears = gears.filter(g => g.x === GRID_COLS - 1 && visited.has(g.id));
    const startGears = gears.filter(g => g.x === 0 && visited.has(g.id));

    if (reachableEndGears.length > 0) {
      // Calculate ratio: Average end teeth / Average start teeth
      const avgEnd = reachableEndGears.reduce((acc, g) => acc + g.teeth, 0) / reachableEndGears.length;
      const avgStart = startGears.reduce((acc, g) => acc + g.teeth, 0) / startGears.length;
      
      // We want: Small start + Large end = High Speed (High Ratio)
      // Large start + Small end = High Torque (Low Ratio)
      setGearRatio(avgEnd / avgStart);
      setIsConnected(true);
    } else {
      setGearRatio(0);
      setIsConnected(false);
    }
  }, [gears]);

  // Responsive Canvas
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
      }
    });
    
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  // Pseudo-3D Racing Logic
  useEffect(() => {
    if (gameState !== 'racing') return;

    let animFrame: number;
    let lastTime = performance.now();
    let localDistance = 0;
    let localSpeed = 0;
    let localObstacles: { id: string, lane: number, z: number, type: string }[] = [];
    let localEngineTemp = 20;
    let screenShake = 0;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvasRef.current?.appendChild(canvas);

    const update = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;

      const { isAccelerating: acc, isAutoDrive: auto, isBraking: brake } = controlsRef.current;
      const activeAcceleration = acc || auto;
      
      // Realistic Speed calculation
      const efficiency = hasUpgrade('titanium_gears') ? 1 : Math.max(0.5, 1 - (connectedGears.length * 0.02));
      const topSpeed = 200 + (gearRatio * 300 * efficiency); // Top speed depends on gear ratio
      const acceleration = 150 * efficiency;
      const drag = 0.5; // Air resistance
      const friction = 20; // Ground friction

      if (activeAcceleration) {
        localSpeed = Math.min(topSpeed, localSpeed + acceleration * dt);
      } else if (brake) {
        localSpeed = Math.max(0, localSpeed - 600 * dt);
      } else {
        // Natural deceleration
        localSpeed = Math.max(0, localSpeed - (friction + localSpeed * drag * 0.01) * dt);
      }
      
      localDistance += localSpeed * dt;
      setDistance(localDistance);
      setCurrentSpeed(localSpeed);

      // Lane interpolation
      setPlayerLane(prev => {
        const diff = targetLane - prev;
        if (Math.abs(diff) < 0.1) return targetLane;
        return prev + diff * 10 * dt;
      });

      // Heat management
      if (activeAcceleration) {
        const heatGen = (gearRatio * 0.5 + localSpeed * 0.01) * (hasUpgrade('super_cooler') ? 0.6 : 1);
        localEngineTemp = Math.min(100, localEngineTemp + heatGen * dt);
      } else {
        localEngineTemp = Math.max(20, localEngineTemp - 5 * dt);
      }
      setEngineTemp(localEngineTemp);

      if (brake) {
        setBrakeTemp(prev => Math.min(100, prev + 20 * dt));
      } else {
        setBrakeTemp(prev => Math.max(20, prev - 10 * dt));
      }

      if (localEngineTemp >= 90) {
        setGameState('exploded');
        return;
      }

      // Obstacle generation
      if (Math.random() < 0.02) {
        localObstacles.push({
          id: Math.random().toString(36).substr(2, 9),
          lane: Math.floor(Math.random() * 3) - 1,
          z: localDistance + 2000,
          type: Math.random() > 0.5 ? 'crate' : 'bump'
        });
      }

      // Filter and collision
      localObstacles = localObstacles.filter(obs => {
        const relativeZ = obs.z - localDistance;
        
        // Collision detection
        if (relativeZ < 50 && relativeZ > -50 && Math.abs(obs.lane - targetLane) < 0.5) {
          localEngineTemp += 15;
          localSpeed *= 0.4; // Significant speed penalty
          screenShake = 20; // Trigger screen shake
          return false;
        }
        
        return relativeZ > -100;
      });
      setObstacles([...localObstacles]);

      // Rendering
      const w = canvasSize.width;
      const h = canvasSize.height;
      canvas.width = w;
      canvas.height = h;

      ctx.save();
      if (screenShake > 0) {
        ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
        screenShake *= 0.9;
        if (screenShake < 1) screenShake = 0;
      }

      ctx.clearRect(0, 0, w, h);

      // Draw Road
      const horizon = h * 0.4;
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(w * 0.45, horizon);
      ctx.lineTo(w * 0.55, horizon);
      ctx.lineTo(w * 1.2, h);
      ctx.lineTo(-w * 0.2, h);
      ctx.fill();

      // Lane Lines
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2;
      ctx.setLineDash([20, 20]);
      ctx.lineDashOffset = -localDistance % 40;
      
      for (let i = -1.5; i <= 1.5; i += 1) {
        ctx.beginPath();
        ctx.moveTo(w/2 + (i * 20), horizon);
        ctx.lineTo(w/2 + (i * 600), h);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Draw Obstacles
      localObstacles.forEach(obs => {
        const relZ = obs.z - localDistance;
        if (relZ < 0 || relZ > 2000) return;

        const scale = 400 / (relZ + 400);
        const x = w/2 + (obs.lane * 200 * scale);
        const y = horizon + (h - horizon) * scale;
        const size = 60 * scale;

        ctx.fillStyle = obs.type === 'crate' ? '#78350f' : '#e11d48';
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x - size/2, y - size, size, size);
        ctx.shadowBlur = 0;
      });

      // Draw Other Players
      Object.values(otherPlayers).forEach((p: any) => {
        const relZ = p.y - localDistance;
        if (relZ < -100 || relZ > 2000) return;

        const scale = 400 / (relZ + 400);
        const x = w/2 + (p.x * 200 * scale);
        const y = horizon + (h - horizon) * scale;
        const size = 60 * scale;

        ctx.fillStyle = 'rgba(59, 130, 246, 0.6)';
        ctx.fillRect(x - size/2, y - size, size, size);
      });

      // Draw Player Car (Simple 3D-ish box)
      const carX = w/2 + (playerLane * 200 * 0.8);
      const carY = h - 60;
      ctx.fillStyle = '#e11d48';
      ctx.fillRect(carX - 40, carY - 20, 80, 40);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(carX - 35, carY - 35, 70, 20); // Roof
      
      ctx.restore();

      // Emit state to socket
      if (socket) {
        socket.emit('update-state', {
          roomId,
          state: {
            x: playerLane,
            y: localDistance,
            progress: localDistance / 10000
          }
        });
      }

      if (localDistance >= 10000) {
        setGameState('finished');
        return;
      }

      animFrame = requestAnimationFrame(update);
    };

    animFrame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animFrame);
      canvas.remove();
    };
  }, [gameState, canvasSize, gearRatio]);

  const addGear = (x: number, y: number) => {
    const id = `${x}-${y}`;
    const existingGear = gears.find(g => g.id === id);
    if (existingGear) {
      // If clicking an existing gear, open the selection menu
      setSelectedGearId(selectedGearId === id ? null : id);
    } else {
      setGears([...gears, { id, x, y, teeth: 16, type: 'intermediate' }]);
      setSelectedGearId(id); // Open menu for the new gear
    }
  };

  const setTeeth = (id: string, teeth: number) => {
    setGears(gears.map(g => g.id === id ? { ...g, teeth } : g));
    setSelectedGearId(null);
  };

  const removeGear = (id: string) => {
    setGears(gears.filter(g => g.id !== id));
    setSelectedGearId(null);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-rose-500/30">
      {/* Header */}
      <header className="p-4 md:p-6 border-b border-white/10 flex flex-col sm:flex-row justify-between items-center bg-[#111111]/80 backdrop-blur-md sticky top-0 z-50 gap-4">
        <div className="flex items-center gap-3 self-start sm:self-center">
          <div className="p-2 bg-rose-600 rounded-lg shadow-lg shadow-rose-600/20">
            <Settings className="w-6 h-6 text-white animate-spin-slow" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">GEAR RACE</h1>
            <p className="text-xs text-white/40 font-mono uppercase tracking-widest">3D Drag Race</p>
          </div>
        </div>
        
        <div className="flex flex-wrap items-center justify-center sm:justify-end gap-3 md:gap-6 w-full sm:w-auto">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-rose-600/20 border border-rose-600/30 rounded-full">
            <Coins className="w-4 h-4 text-rose-400" />
            <span className="text-sm font-mono font-bold text-rose-400">{credits} CR</span>
          </div>
          <button 
            onClick={() => setGameState(gameState === 'shop' ? 'setup' : 'shop')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-bold transition-all border text-xs md:text-sm ${
              gameState === 'shop' 
                ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' 
                : 'bg-white/5 border-white/10 hover:bg-white/10'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            SHOP
          </button>
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 hidden md:flex">
            <Users className="w-4 h-4 text-rose-400" />
            <span className="text-sm font-medium">{Object.keys(otherPlayers).length + 1} Players</span>
          </div>
          <button 
            onClick={() => setIsGarageOpen(!isGarageOpen)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full font-bold transition-all border text-xs md:text-sm ${
              isGarageOpen 
                ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' 
                : 'bg-white/5 border-white/10 hover:bg-white/10'
            }`}
          >
            <Settings className={`w-4 h-4 ${isGarageOpen ? 'animate-spin-slow' : ''}`} />
            GARAGE
          </button>
          <button 
            onClick={() => setGameState(gameState === 'setup' ? 'racing' : 'setup')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-bold transition-all text-xs md:text-sm ${
              gameState === 'setup' 
                ? 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-600/20' 
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            {gameState === 'setup' ? <Play className="w-4 h-4 fill-current" /> : <RotateCcw className="w-4 h-4" />}
            {gameState === 'setup' ? 'START' : 'RESET'}
          </button>
        </div>
      </header>

      <AnimatePresence>
        {gameState === 'shop' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ y: 20 }}
              animate={{ y: 0 }}
              className="bg-[#111111] border border-white/10 rounded-3xl p-4 md:p-8 max-w-4xl w-full shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                <div>
                  <h2 className="text-2xl md:text-3xl font-black text-rose-500 mb-1 uppercase italic tracking-tighter">Performance Shop</h2>
                  <p className="text-white/40 font-mono text-[10px] md:text-xs uppercase tracking-widest">Upgrade your mechanical assembly</p>
                </div>
                <div className="flex items-center gap-3 bg-white/5 p-3 md:p-4 rounded-2xl border border-white/10 w-full sm:w-auto">
                  <Coins className="w-6 h-6 md:w-8 md:h-8 text-rose-500" />
                  <div>
                    <p className="text-[8px] md:text-[10px] text-white/40 uppercase font-bold">Available Credits</p>
                    <p className="text-xl md:text-2xl font-mono font-black text-white">{credits}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {SHOP_ITEMS.map(item => (
                  <div 
                    key={item.id}
                    className={`relative group p-6 rounded-2xl border transition-all ${
                      hasUpgrade(item.id) 
                        ? 'bg-rose-600/10 border-rose-600/50' 
                        : 'bg-[#1a1a1a] border-white/10 hover:border-rose-600/30'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-3 rounded-xl ${hasUpgrade(item.id) ? 'bg-rose-600 text-white' : 'bg-white/5 text-white/60'}`}>
                        {item.icon}
                      </div>
                      {!hasUpgrade(item.id) && (
                        <div className="flex items-center gap-1 bg-white/5 px-3 py-1 rounded-full border border-white/10">
                          <Coins className="w-3 h-3 text-rose-500" />
                          <span className="text-sm font-mono font-bold text-white">{item.price}</span>
                        </div>
                      )}
                    </div>
                    
                    <h3 className="text-xl font-bold text-white mb-1 uppercase tracking-tight">{item.name}</h3>
                    <p className="text-sm text-white/40 mb-6 leading-relaxed">{item.description}</p>
                    
                    <button
                      onClick={() => buyItem(item)}
                      disabled={hasUpgrade(item.id) || credits < item.price}
                      className={`w-full py-3 rounded-xl font-black uppercase tracking-widest transition-all ${
                        hasUpgrade(item.id)
                          ? 'bg-green-500/20 text-green-400 cursor-default border border-green-500/30'
                          : credits >= item.price
                            ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/20'
                            : 'bg-white/5 text-white/20 cursor-not-allowed border border-white/5'
                      }`}
                    >
                      {hasUpgrade(item.id) ? 'Installed' : credits >= item.price ? 'Purchase Upgrade' : 'Insufficient Credits'}
                    </button>

                    {hasUpgrade(item.id) && (
                      <div className="absolute top-4 right-4">
                        <div className="flex items-center gap-1 text-[10px] font-black text-green-400 uppercase bg-green-400/10 px-2 py-1 rounded border border-green-400/20">
                          <Check className="w-3 h-3" />
                          Active
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-8 flex justify-center">
                <button 
                  onClick={() => setGameState('setup')}
                  className="px-8 py-3 bg-white text-black font-black uppercase tracking-widest rounded-full hover:bg-gray-200 transition-all"
                >
                  Return to Garage
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {showInstructions && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#111111] border border-white/10 rounded-3xl p-8 max-w-2xl w-full shadow-2xl"
            >
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h2 className="text-3xl font-black text-rose-500 mb-2">ENDLESS RUNNER MODE</h2>
                  <p className="text-white/40 font-mono text-sm uppercase">Speed & Reflexes Guide</p>
                </div>
                <button 
                  onClick={() => setShowInstructions(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <RotateCcw className="w-6 h-6 rotate-45" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center shrink-0">
                      <Settings className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">1. High Speed Gears</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Use small start gears and large end gears for maximum top speed on the straight road.</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center shrink-0">
                      <Zap className="w-5 h-5 text-rose-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">2. Avoid Obstacles</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Watch out for crates, bumps, and ramps. Hitting obstacles at high speed will damage your engine!</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-yellow-500/20 flex items-center justify-center shrink-0">
                      <Play className="w-5 h-5 text-yellow-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">3. Race & Control</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Use <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">A / D</span> or <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">← / →</span> to switch lanes. Hold <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">SPACE</span> to boost acceleration.</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center shrink-0">
                      <Thermometer className="w-5 h-5 text-red-400" />
                    </div>
                    <div>
                      <h3 className="font-bold mb-1">4. Watch the Heat</h3>
                      <p className="text-sm text-white/60 leading-relaxed">Don't let the engine exceed 90°C or it will explode! Balance speed and load.</p>
                    </div>
                  </div>
                </div>
              </div>

              <button 
                onClick={() => setShowInstructions(false)}
                className="w-full mt-10 bg-rose-600 hover:bg-rose-500 py-4 rounded-2xl font-black text-lg shadow-xl shadow-rose-600/20 transition-all active:scale-95"
              >
                GOT IT, LET'S RACE!
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-7xl mx-auto p-4 md:p-8 flex flex-col gap-6 md:gap-8">
        {/* Top: Race View */}
        <div className="w-full space-y-6 transition-all duration-500">
          <div className="bg-[#111111] rounded-2xl border border-white/10 p-3 md:p-6 shadow-2xl relative overflow-hidden h-[400px] md:h-[650px] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Trophy className="w-5 h-5 text-yellow-500" />
                Live Race
              </h2>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <Thermometer className={`w-4 h-4 ${engineTemp > 70 ? 'text-red-500 animate-pulse' : 'text-blue-400'}`} />
                  <span className="text-sm font-mono">{engineTemp.toFixed(1)}°C</span>
                </div>
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  <span className="text-sm font-mono">{(gearRatio * 10).toFixed(0)} Nm</span>
                </div>
              </div>
            </div>

            <div className="flex-1 relative rounded-xl overflow-hidden border border-white/5 bg-[#1a1a1a] min-h-[250px]">
              <div ref={canvasRef} className="w-full h-full relative">
                {/* Boost Notification */}
                <AnimatePresence>
                  {boostTime > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, x: -20, scale: 0.8 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.2 }}
                      className="absolute top-10 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
                    >
                      <div className="bg-rose-600 text-white px-6 py-2 rounded-full font-black italic text-2xl shadow-[0_0_30px_rgba(244,63,94,0.6)] border-2 border-white/20 flex items-center gap-3">
                        <Flame className="w-8 h-8 animate-pulse" />
                        {lastBoostType} BOOST!
                        <span className="text-sm font-mono ml-2 opacity-60">{boostTime.toFixed(1)}s</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Scanline & Vignette */}
                <div className="absolute inset-0 pointer-events-none z-20 scanline opacity-[0.03]" />
                <div className="absolute inset-0 pointer-events-none z-20 shadow-[inset_0_0_150px_rgba(0,0,0,0.7)]" />
              </div>

              {/* Progress Bar */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-64 h-12 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden pointer-events-none">
                <div className="absolute inset-0 flex items-center px-2">
                  <div className="w-full h-[2px] bg-white/10 relative">
                    {/* Finish Line */}
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-yellow-500" />
                    {/* Player Dot */}
                    <motion.div 
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-rose-500 rounded-full shadow-[0_0_10px_rgba(244,63,94,0.8)] border-2 border-white"
                      animate={{ left: `${(distance / 10000) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="absolute bottom-1 left-2 text-[6px] font-black text-white/40 uppercase tracking-widest">Progress</div>
              </div>

              {/* On-Screen Controls */}
              {gameState === 'racing' && (
                <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-6">
                  <div className="flex justify-center">
                    <div className="bg-black/40 backdrop-blur-sm px-4 py-2 rounded-full border border-white/10">
                      <p className="text-[10px] font-bold text-white/60 uppercase tracking-widest">
                        {isAutoDrive ? 'Auto-Drive Active' : 'Manual Control'}
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-between items-end">
                    {/* Left: Lane Switch / Brake */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTargetLane(prev => Math.max(-1, prev - 1))}
                        className="pointer-events-auto w-16 h-16 bg-black/60 backdrop-blur-md border-2 border-white/20 rounded-2xl flex items-center justify-center active:scale-95 transition-all"
                      >
                        <Wind className="w-8 h-8 text-white rotate-180" />
                      </button>
                      <button
                        onMouseDown={() => setIsBraking(true)}
                        onMouseUp={() => setIsBraking(false)}
                        onTouchStart={() => setIsBraking(true)}
                        onTouchEnd={() => setIsBraking(false)}
                        className="pointer-events-auto w-16 h-16 bg-black/60 backdrop-blur-md border-2 border-white/20 rounded-2xl flex flex-col items-center justify-center active:scale-95 active:bg-red-500/40 transition-all group"
                      >
                        <RotateCcw className="w-6 h-6 text-white" />
                      </button>
                    </div>

                    {/* Right: Lane Switch / Gas */}
                    <div className="flex gap-2">
                      <button
                        onMouseDown={() => setIsAccelerating(true)}
                        onMouseUp={() => setIsAccelerating(false)}
                        onTouchStart={() => setIsAccelerating(true)}
                        onTouchEnd={() => setIsAccelerating(false)}
                        className="pointer-events-auto w-20 h-20 bg-rose-600/60 backdrop-blur-md border-2 border-rose-400/40 rounded-3xl flex flex-col items-center justify-center active:scale-95 active:bg-rose-500 transition-all group shadow-xl shadow-rose-600/20"
                      >
                        <Play className="w-8 h-8 text-white" />
                      </button>
                      <button
                        onClick={() => setTargetLane(prev => Math.min(1, prev + 1))}
                        className="pointer-events-auto w-16 h-16 bg-black/60 backdrop-blur-md border-2 border-white/20 rounded-2xl flex items-center justify-center active:scale-95 transition-all"
                      >
                        <Wind className="w-8 h-8 text-white" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Dashboard Overlay */}
              <div className="absolute bottom-2 md:bottom-4 left-2 md:left-4 right-2 md:right-4 flex justify-between items-end pointer-events-none">
                <div className="bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-2 md:p-4 flex gap-3 md:gap-6 shadow-[0_0_30px_rgba(0,0,0,0.5)]">
                  <div className="text-center">
                    <p className="text-[8px] md:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Speed</p>
                    <p className="text-xl md:text-3xl font-mono font-black text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]">
                      {(currentSpeed / 10).toFixed(0)}
                      <span className="text-[10px] md:text-sm ml-1 opacity-40">km/h</span>
                    </p>
                  </div>
                  <div className="w-[1px] bg-white/10" />
                  <div className="text-center">
                    <p className="text-[8px] md:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Efficiency</p>
                    <p className="text-xl md:text-3xl font-mono font-black text-green-400 drop-shadow-[0_0_10px_rgba(74,222,128,0.3)]">
                      {(Math.max(0.5, 1 - (connectedGears.length * 0.02)) * 100).toFixed(0)}%
                    </p>
                  </div>
                </div>

                <div className="bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-2 md:p-4 shadow-[0_0_30px_rgba(0,0,0,0.5)] hidden sm:block">
                  <p className="text-[10px] text-white/40 uppercase font-black tracking-widest mb-2">Engine Load</p>
                  <div className="w-24 md:w-40 h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      className="h-full bg-gradient-to-r from-blue-600 to-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
                      animate={{ width: `${Math.min(100, (gearRatio * 5))}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-[10px] font-mono text-white/40 uppercase tracking-widest">
                <span>Start</span>
                <span>Finish</span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden border border-white/10">
                <motion.div 
                  className="h-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]"
                  initial={{ width: 0 }}
                  animate={{ width: `${(distance / 10000) * 100}%` }}
                />
                {(Object.values(otherPlayers) as PlayerState[]).map(p => (
                  <motion.div 
                    key={p.id}
                    className="absolute top-0 h-full w-1 bg-blue-400"
                    style={{ left: `${p.progress * 100}%` }}
                  />
                ))}
              </div>
            </div>

            <AnimatePresence>
              {gameState === 'exploded' && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="absolute inset-0 bg-red-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center z-50"
                >
                  <div className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center mb-6 animate-bounce">
                    <AlertTriangle className="w-10 h-10 text-white" />
                  </div>
                  <h3 className="text-3xl font-black mb-2">ENGINE OVERHEATED!</h3>
                  <p className="text-red-200/60 mb-8 max-w-xs">Your gear ratio was too aggressive for the terrain. The engine reached 90°C and exploded.</p>
                  <button 
                    onClick={() => {
                      setGameState('setup');
                      setEngineTemp(20);
                    }}
                    className="bg-white text-red-950 px-8 py-3 rounded-full font-bold hover:bg-red-100 transition-colors"
                  >
                    REBUILD MACHINE
                  </button>
                </motion.div>
              )}

              {gameState === 'finished' && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute inset-0 bg-green-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center z-50"
                >
                  <Trophy className="w-20 h-20 text-yellow-500 mb-6" />
                  <h3 className="text-3xl font-black mb-2">VICTORY!</h3>
                  <p className="text-green-200/60 mb-8">You conquered the terrain with precision engineering.</p>
                  <button 
                    onClick={() => setGameState('setup')}
                    className="bg-white text-green-950 px-8 py-3 rounded-full font-bold hover:bg-green-100 transition-colors"
                  >
                    RACE AGAIN
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Leaderboard / Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
            <div className="bg-[#111111] rounded-2xl border border-white/10 p-4 md:p-6 shadow-xl">
              <h3 className="text-[10px] md:text-sm font-bold text-white/40 uppercase tracking-widest mb-4">Thermal Status</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>Engine Core</span>
                    <span className={engineTemp > 70 ? 'text-red-400' : 'text-white/60'}>{engineTemp.toFixed(0)}°C</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${engineTemp > 70 ? 'bg-red-500' : 'bg-blue-500'}`}
                      style={{ width: `${(engineTemp / 90) * 100}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>Brake Friction</span>
                    <span className={brakeTemp > 70 ? 'text-orange-400' : 'text-white/60'}>{brakeTemp.toFixed(0)}°C</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${brakeTemp > 70 ? 'bg-orange-500' : 'bg-yellow-500'}`}
                      style={{ width: `${brakeTemp}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#111111] rounded-2xl border border-white/10 p-4 md:p-6 shadow-xl">
              <h3 className="text-[10px] md:text-sm font-bold text-white/40 uppercase tracking-widest mb-4">Competitors</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-rose-500" />
                    <span className="text-sm font-medium">You</span>
                  </div>
                  <span className="text-xs font-mono text-white/40">{((playerState?.progress || 0) * 100).toFixed(0)}%</span>
                </div>
                {(Object.values(otherPlayers) as PlayerState[]).map(p => (
                  <div key={p.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400" />
                      <span className="text-sm font-medium text-white/60">Player {p.id.slice(0, 4)}</span>
                    </div>
                    <span className="text-xs font-mono text-white/40">{(p.progress * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom: Gear Assembly */}
        <AnimatePresence>
          {isGarageOpen && (
            <motion.div 
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 50 }}
              className="w-full space-y-6"
            >
              <div className="bg-[#111111] rounded-2xl border border-white/10 p-6 shadow-2xl relative">
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Settings className="w-5 h-5 text-rose-500" />
                    Gear Assembly
                  </h2>
                  <div className="text-xs font-mono text-white/40 bg-white/5 px-2 py-1 rounded">12x3 GRID</div>
                </div>

                <div className="relative flex flex-col md:flex-row items-center gap-4">
                  <EngineVisual className="shrink-0 md:block hidden" />
                  
                  <div className="flex-1 w-full overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-white/10">
                    <div 
                      className="grid gap-1 bg-[#1a1a1a] p-2 rounded-xl border border-white/5 min-h-[150px] gear-grid-bg relative min-w-[500px] md:min-w-[600px]"
                      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}
                    >
                      <div className="absolute inset-0 scanline pointer-events-none rounded-xl overflow-hidden" />
                    {Array.from({ length: GRID_COLS * GRID_ROWS }).map((_, i) => {
                      const x = i % GRID_COLS;
                      const y = Math.floor(i / GRID_COLS);
                      const gear = gears.find(g => g.x === x && g.y === y);
                      const isEngine = x === 0;
                      const isWheel = x === GRID_COLS - 1;

                      return (
                        <div key={i} className="relative">
                          <button
                            onClick={() => addGear(x, y)}
                            className={`w-full aspect-square min-h-[30px] rounded-md transition-all flex items-center justify-center relative group overflow-hidden border border-white/5 ${
                              gear 
                                ? connectedGears.includes(gear.id) 
                                  ? 'bg-rose-600 shadow-lg shadow-rose-600/40 scale-95 ring-2 ring-rose-400/50' 
                                  : 'bg-neutral-700 opacity-60'
                                : 'bg-white/10 hover:bg-white/20'
                            } ${isEngine ? 'border-l-2 border-blue-500/50' : ''} ${isWheel ? 'border-r-2 border-green-500/50' : ''}`}
                          >
                            {gear && (
                              <motion.div 
                                animate={{ rotate: isConnected && (isAccelerating || isAutoDrive) ? 360 : 0 }}
                                transition={{ duration: 2 / (gear.teeth / 16), repeat: Infinity, ease: "linear" }}
                                className="relative flex items-center justify-center w-full h-full p-1"
                              >
                                <GearIcon 
                                  teeth={Math.min(gear.teeth, 32)} 
                                  color={connectedGears.includes(gear.id) ? '#fff' : 'rgba(255,255,255,0.2)'} 
                                  className="w-full h-full"
                                />
                                <span className="absolute text-[8px] font-black text-white bg-black/50 px-1 rounded">{gear.teeth}</span>
                              </motion.div>
                            )}
                            {!gear && (isEngine || isWheel) && (
                              <div className={`w-1 h-1 rounded-full ${isEngine ? 'bg-blue-500' : 'bg-green-500'} opacity-30`} />
                            )}
                          </button>

                          {/* Gear Selection Dropdown */}
                          <AnimatePresence>
                            {selectedGearId === gear?.id && (
                              <motion.div 
                                initial={{ opacity: 0, scale: 0.8, y: y === 0 ? 10 : -10 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.8, y: y === 0 ? 10 : -10 }}
                                className={`absolute z-[100] ${y === 0 ? 'top-full mt-2' : 'bottom-full mb-2'} left-1/2 -translate-x-1/2 bg-[#1a1a1a] border border-white/20 rounded-xl p-2 shadow-2xl min-w-[140px]`}
                              >
                                <p className="text-[10px] font-bold text-white/40 uppercase mb-2 px-2">Select Teeth</p>
                                <div className="grid grid-cols-3 gap-1">
                                  {GEAR_TYPES.map(t => (
                                    <button
                                      key={t}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setTeeth(gear.id, t);
                                      }}
                                      className={`px-2 py-1.5 rounded-md text-xs font-bold transition-colors ${
                                        gear.teeth === t ? 'bg-rose-600 text-white' : 'hover:bg-white/10 text-white/60'
                                      }`}
                                    >
                                      {t}T
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-2 pt-2 border-t border-white/10">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeGear(gear.id);
                                    }}
                                    className="w-full px-2 py-1.5 rounded-md text-[10px] font-bold text-red-400 hover:bg-red-500/10 transition-colors uppercase"
                                  >
                                    Remove Gear
                                  </button>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                    </div>
                  </div>

                  <WheelVisual className="shrink-0 md:block hidden" />
                </div>

                <div className="mt-6 grid grid-cols-2 gap-4">
                  <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                    <p className="text-xs text-white/40 uppercase font-bold mb-1">Gear Ratio</p>
                    <p className="text-2xl font-mono font-bold text-rose-400">{gearRatio.toFixed(2)}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                    <p className="text-xs text-white/40 uppercase font-bold mb-1">Efficiency</p>
                    <p className="text-2xl font-mono font-bold text-green-400">{(Math.max(0.5, 1 - (connectedGears.length * 0.02)) * 100).toFixed(0)}%</p>
                  </div>
                </div>

                <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
                  <button 
                    onClick={() => {
                      const name = prompt('Enter preset name:');
                      if (name) setPresets([...presets, { name, gears: [...gears] }]);
                    }}
                    className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[10px] font-bold uppercase shrink-0 transition-colors"
                  >
                    Save Preset
                  </button>
                  {presets.map((p, idx) => (
                    <button 
                      key={idx}
                      onClick={() => setGears(p.gears)}
                      className="px-3 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-600/30 rounded-lg text-[10px] font-bold uppercase shrink-0 transition-colors text-rose-400"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex gap-3 items-start">
                <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
                <div className="space-y-2">
                  <p className="text-sm text-rose-200/80 leading-relaxed">
                    Connect gears from the <span className="text-blue-400 font-bold">Engine (Left)</span> to the <span className="text-green-400 font-bold">Wheel (Right)</span>. 
                  </p>
                  <p className="text-xs text-rose-200/60 leading-relaxed italic">
                    Tip: Use <span className="font-bold text-rose-400">Large Gears</span> on the right (Wheel) for more climbing power (Torque). Use <span className="font-bold text-blue-400">Small Gears</span> on the right for more speed.
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin-slow {
          animation: spin-slow 8s linear infinite;
        }
      `}</style>
    </div>
  );
}
