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
  const [isConnected, setIsConnected] = useState(false);
  const [isAccelerating, setIsAccelerating] = useState(false);
  const [isAutoDrive, setIsAutoDrive] = useState(true);
  const [isBraking, setIsBraking] = useState(false);
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
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === ' ') setIsAccelerating(true);
      if (e.key === 'ArrowLeft' || e.key === 'a') setIsBraking(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === ' ') setIsAccelerating(false);
      if (e.key === 'ArrowLeft' || e.key === 'a') setIsBraking(false);
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

  // Physics Engine Setup
  useEffect(() => {
    if (gameState !== 'racing') return;

    const engine = Matter.Engine.create();
    engineRef.current = engine;
    const render = Matter.Render.create({
      element: canvasRef.current!,
      engine: engine,
      options: {
        width: canvasSize.width,
        height: canvasSize.height,
        wireframes: false,
        background: 'transparent',
      },
    });

    // Terrain Generation (Flat Road with Obstacles)
    const terrain: Matter.Body[] = [];
    const roadWidth = 10000;
    
    // Base Road
    const ground = Matter.Bodies.rectangle(roadWidth / 2, 400, roadWidth, 100, { 
      isStatic: true, 
      friction: 0.8,
      render: { 
        fillStyle: '#111',
        strokeStyle: '#e11d48',
        lineWidth: 2
      }
    });
    terrain.push(ground);

    // Obstacles (Crates, Bumps, Ramps)
    for (let x = 800; x < roadWidth; x += 600 + Math.random() * 400) {
      const type = Math.random();
      if (type > 0.7) {
        // Ramp
        const ramp = Matter.Bodies.fromVertices(x, 360, [
          [{ x: -60, y: 40 }, { x: 60, y: 40 }, { x: 60, y: -20 }]
        ], { isStatic: true, friction: 0.5, render: { fillStyle: '#222', strokeStyle: '#e11d48', lineWidth: 1 } });
        terrain.push(ramp);
      } else if (type > 0.4) {
        // Speed Bump
        const bump = Matter.Bodies.circle(x, 360, 20, { isStatic: true, render: { fillStyle: '#e11d48' } });
        terrain.push(bump);
      } else {
        // Crate
        const crate = Matter.Bodies.rectangle(x, 330, 40, 40, { 
          friction: 0.5, 
          density: 0.001,
          render: { fillStyle: '#78350f', strokeStyle: '#92400e', lineWidth: 2 } 
        });
        terrain.push(crate);
      }
    }

    // Vehicle
    const chassis = Matter.Bodies.fromVertices(150, 250, [
      [
        { x: -40, y: 10 }, { x: -35, y: -5 }, { x: -10, y: -15 }, 
        { x: 20, y: -15 }, { x: 40, y: 0 }, { x: 40, y: 10 }
      ]
    ], { 
      collisionFilter: { group: -1 },
      mass: 5,
      render: { 
        fillStyle: '#e11d48',
        strokeStyle: '#fb7185',
        lineWidth: 3
      }
    });

    // Add a cockpit/spoiler as sub-parts or just stylized render
    const wheelA = Matter.Bodies.circle(120, 280, 18, { 
      friction: 1.0,
      density: 0.01,
      render: { 
        fillStyle: '#111',
        strokeStyle: '#e11d48',
        lineWidth: 4
      }
    });
    const wheelB = Matter.Bodies.circle(180, 280, 18, { 
      friction: 1.0,
      density: 0.01,
      render: { 
        fillStyle: '#111',
        strokeStyle: '#e11d48',
        lineWidth: 4
      }
    });

    const axelA = Matter.Constraint.create({
      bodyA: chassis,
      pointA: { x: -30, y: 15 },
      bodyB: wheelA,
      stiffness: 0.1, // Softer suspension
      damping: 0.1,
      length: 10,
      render: { visible: false }
    });
    const axelB = Matter.Constraint.create({
      bodyA: chassis,
      pointA: { x: 30, y: 15 },
      bodyB: wheelB,
      stiffness: 0.1, // Softer suspension
      damping: 0.1,
      length: 10,
      render: { visible: false }
    });

    playerBodyRef.current = chassis;
    wheelARef.current = wheelA;
    wheelBRef.current = wheelB;

    Matter.Composite.add(engine.world, [...terrain, chassis, wheelA, wheelB, axelA, axelB]);
    Matter.Render.run(render);

    // Custom drawing for Neon Glow and Particles
    Matter.Events.on(render, 'afterRender', () => {
      const ctx = render.context;
      const bodies = Matter.Composite.allBodies(engine.world);

      ctx.save();
      
      // Draw Particles
      particlesRef.current.forEach((p, i) => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
        if (p.life <= 0) {
          particlesRef.current.splice(i, 1);
          return;
        }
        ctx.beginPath();
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.arc(p.x, p.y, 2 + (1 - p.life) * 4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      bodies.forEach(body => {
        if (body.isStatic) {
          // Terrain glow
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(225, 29, 72, 0.3)';
          ctx.lineWidth = 10;
          ctx.shadowBlur = 15;
          ctx.shadowColor = '#e11d48';
          const vertices = body.vertices;
          ctx.moveTo(vertices[0].x, vertices[0].y);
          ctx.lineTo(vertices[1].x, vertices[1].y);
          ctx.stroke();
        } else if (body === chassis || body === wheelA || body === wheelB) {
          // Car/Wheel glow
          ctx.beginPath();
          ctx.shadowBlur = 20;
          ctx.shadowColor = body === chassis ? '#e11d48' : '#fb7185';
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(255,255,255,0.2)';
          const vertices = body.vertices;
          ctx.moveTo(vertices[0].x, vertices[0].y);
          for (let i = 1; i < vertices.length; i++) {
            ctx.lineTo(vertices[i].x, vertices[i].y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      });
      ctx.restore();
    });

    const runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);

    const otherBodies: Record<string, Matter.Body> = {};
    let frameCount = 0;
    let localEngineTemp = 20;
    let localBrakeTemp = 20;
    let localBoostTime = 0;
    const obstacles = terrain.filter(b => !b.isStatic || b.label === 'obstacle'); // Labeling helps but here we check all non-ground
    const groundBody = ground;

    // Optimized Game Loop using Matter.js events
    Matter.Events.on(engine, 'beforeUpdate', () => {
      if (!playerBodyRef.current || !socket) return;
      frameCount++;

      if (localBoostTime > 0) {
        localBoostTime -= 1/60;
        if (localBoostTime <= 0) {
          setBoostTime(0);
          setLastBoostType(null);
        }
      }

      // Proximity Detection for Boost
      const pos = playerBodyRef.current.position;
      terrain.forEach(obj => {
        if (obj === groundBody) return;
        
        const dist = Matter.Vector.magnitude(Matter.Vector.sub(pos, obj.position));
        // Meter scale in our game: ~100px = 10m (roughly based on car size 80px)
        // 10m = 100px, 5m = 50px, 1m = 10px
        if (dist < 150 && obj.position.x > pos.x) { // Only obstacles ahead
          const relativeDist = dist - 40; // Subtract car half-width
          let boostDuration = 0;
          let type = "";

          if (relativeDist < 10) { boostDuration = 6; type = "EXTREME"; }
          else if (relativeDist < 50) { boostDuration = 4; type = "GREAT"; }
          else if (relativeDist < 100) { boostDuration = 2; type = "NEAR MISS"; }

          if (boostDuration > localBoostTime) {
            localBoostTime = boostDuration;
            setBoostTime(boostDuration);
            setLastBoostType(type);
          }
        }
      });

      // Update other players' ghosts
      (Object.values(otherPlayers) as PlayerState[]).forEach(p => {
        if (!otherBodies[p.id]) {
          otherBodies[p.id] = Matter.Bodies.rectangle(p.x, p.y, 80, 20, {
            isStatic: true,
            collisionFilter: { group: -1, mask: 0 },
            render: { fillStyle: 'rgba(59, 130, 246, 0.5)' }
          });
          Matter.Composite.add(engine.world, otherBodies[p.id]);
        } else {
          Matter.Body.setPosition(otherBodies[p.id], { x: p.x, y: p.y });
          Matter.Body.setAngle(otherBodies[p.id], p.angle);
        }
      });

      const angle = playerBodyRef.current.angle;
      const { isAccelerating: acc, isAutoDrive: auto, isBraking: brake, connectedGears: conn } = controlsRef.current;
      
      const activeAcceleration = acc || auto;
      const efficiency = hasUpgrade('titanium_gears') ? 1 : Math.max(0.5, 1 - (conn.length * 0.02));
      const boostMultiplier = localBoostTime > 0 ? 2.5 : 1;
      const baseTorque = hasUpgrade('nitro_system') ? 31.25 : 25;
      const torque = (isConnected && activeAcceleration) ? (baseTorque * gearRatio * efficiency * boostMultiplier) : 0;
      const speed = Matter.Vector.magnitude(playerBodyRef.current.velocity);
      
      // Air Control
      const isGrounded = Matter.Query.collides(wheelA, terrain).length > 0 || Matter.Query.collides(wheelB, terrain).length > 0;
      if (!isGrounded && gameState === 'racing') {
        if (acc || auto) {
          Matter.Body.setAngularVelocity(playerBodyRef.current, 0.02);
        } else if (brake) {
          Matter.Body.setAngularVelocity(playerBodyRef.current, -0.02);
        }
      }

      // Particle Logic (Ref based, no React state)
      if (gameState === 'racing') {
        if (localBoostTime > 0) {
          particlesRef.current.push({
            x: pos.x - 40,
            y: pos.y + (Math.random() - 0.5) * 20,
            vx: -5 - Math.random() * 5,
            vy: (Math.random() - 0.5) * 2,
            life: 0.8,
            color: '#f43f5e'
          });
        }
        if (localEngineTemp > 60 && Math.random() > 0.8) {
          particlesRef.current.push({
            x: pos.x - 40,
            y: pos.y - 10,
            vx: -1 - Math.random() * 2,
            vy: -2 - Math.random() * 2,
            life: 1.0,
            color: localEngineTemp > 80 ? '#ef4444' : '#9ca3af'
          });
        }
        if (speed > 2 && Math.random() > 0.9) {
          particlesRef.current.push({
            x: wheelB.position.x,
            y: wheelB.position.y + 15,
            vx: -2 - Math.random() * 2,
            vy: -1 - Math.random() * 1,
            life: 0.8,
            color: '#78350f'
          });
        }
      }

      // Thermal Logic (Local variables for performance)
      const stallFactor = (activeAcceleration && isConnected && speed < 0.5) ? 1.2 : 1;
      const torqueLoad = Math.abs(torque) * 0.0005; 
      const baseLoad = isConnected ? 0.02 : 0.005;
      const coolingFactor = hasUpgrade('super_cooler') ? 0.6 : 1;
      const load = activeAcceleration ? (torqueLoad + baseLoad) * stallFactor * coolingFactor : 0;
      const airCooling = speed * 0.005;
      const cooling = (activeAcceleration ? 0.01 : 0.05) + airCooling;
      
      localEngineTemp = Math.max(20, localEngineTemp + load - cooling);
      if (localEngineTemp > 90) setGameState('exploded');

      if (brake) {
        Matter.Body.setAngularVelocity(wheelA, wheelA.angularVelocity * 0.8);
        Matter.Body.setAngularVelocity(wheelB, wheelB.angularVelocity * 0.8);
        localBrakeTemp = Math.min(100, localBrakeTemp + 1.5);
      } else if (speed > 5 && angle > 0.1) {
        const gearStress = gearRatio < 1 ? (1 / gearRatio) : 1;
        localBrakeTemp = Math.min(100, localBrakeTemp + 0.1 * gearStress);
      } else {
        localBrakeTemp = Math.max(20, localBrakeTemp - 0.2);
      }

      // Throttle React state updates (every 10 frames)
      if (frameCount % 10 === 0) {
        setEngineTemp(localEngineTemp);
        setBrakeTemp(localBrakeTemp);
      }

      // Apply force to wheels
      if (isConnected && gameState === 'racing' && activeAcceleration) {
        Matter.Body.setAngularVelocity(wheelA, torque * 0.02);
        Matter.Body.setAngularVelocity(wheelB, torque * 0.02);
      }

      // Camera Follow (Runner Style)
      if (render.canvas) {
        Matter.Render.lookAt(render, {
          min: { x: pos.x - 200, y: pos.y - 400 },
          max: { x: pos.x + 800, y: pos.y + 100 }
        });
      }

      // Throttle Socket Sync (every 3 frames ~ 20fps)
      if (frameCount % 3 === 0) {
        socket.emit('update-state', {
          roomId,
          state: {
            x: pos.x,
            y: pos.y,
            angle: angle,
            temp: localEngineTemp,
            brakeTemp: localBrakeTemp,
            progress: pos.x / 5000,
          }
        });
      }

      if (pos.x > 4800) {
        setGameState('finished');
        // Award credits based on performance
        const earned = Math.floor(pos.x / 100);
        setCredits(prev => prev + earned);
      }
    });

    return () => {
      Matter.Events.off(engine, 'beforeUpdate');
      Matter.Events.off(render, 'afterRender');
      Matter.Engine.clear(engine);
      Matter.Render.stop(render);
      render.canvas.remove();
    };
  }, [gameState, isConnected, gearRatio, socket, roomId]);

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
      <header className="p-6 border-b border-white/10 flex justify-between items-center bg-[#111111]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-rose-600 rounded-lg shadow-lg shadow-rose-600/20">
            <Settings className="w-6 h-6 text-white animate-spin-slow" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">GEAR RACE</h1>
            <p className="text-xs text-white/40 font-mono uppercase tracking-widest">Hill Climb Multiplayer</p>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 px-4 py-2 bg-rose-600/20 border border-rose-600/30 rounded-full">
            <Coins className="w-4 h-4 text-rose-400" />
            <span className="text-sm font-mono font-bold text-rose-400">{credits} CR</span>
          </div>
          <button 
            onClick={() => setGameState(gameState === 'shop' ? 'setup' : 'shop')}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold transition-all border ${
              gameState === 'shop' 
                ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' 
                : 'bg-white/5 border-white/10 hover:bg-white/10'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            SHOP
          </button>
          <button 
            onClick={() => setShowInstructions(true)}
            className="text-white/40 hover:text-white text-xs font-bold uppercase tracking-widest"
          >
            How to play?
          </button>
          <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
            <Users className="w-4 h-4 text-rose-400" />
            <span className="text-sm font-medium">{Object.keys(otherPlayers).length + 1} Players</span>
          </div>
          <button 
            onClick={() => setIsGarageOpen(!isGarageOpen)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold transition-all border ${
              isGarageOpen 
                ? 'bg-rose-600 border-rose-400 shadow-lg shadow-rose-600/20' 
                : 'bg-white/5 border-white/10 hover:bg-white/10'
            }`}
          >
            <Settings className={`w-4 h-4 ${isGarageOpen ? 'animate-spin-slow' : ''}`} />
            GARAGE
          </button>
          <button 
            onClick={() => setIsAutoDrive(!isAutoDrive)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold transition-all border ${
              isAutoDrive 
                ? 'bg-blue-600 border-blue-400 shadow-lg shadow-blue-600/20' 
                : 'bg-white/5 border-white/10 hover:bg-white/10'
            }`}
          >
            <Zap className={`w-4 h-4 ${isAutoDrive ? 'animate-pulse' : ''}`} />
            AUTO
          </button>
          <button 
            onClick={() => setGameState(gameState === 'setup' ? 'racing' : 'setup')}
            className={`flex items-center gap-2 px-6 py-2 rounded-full font-bold transition-all ${
              gameState === 'setup' 
                ? 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-600/20' 
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            {gameState === 'setup' ? <Play className="w-4 h-4 fill-current" /> : <RotateCcw className="w-4 h-4" />}
            {gameState === 'setup' ? 'START RACE' : 'RESET'}
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
              className="bg-[#111111] border border-white/10 rounded-3xl p-8 max-w-4xl w-full shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-3xl font-black text-rose-500 mb-1 uppercase italic tracking-tighter">Performance Shop</h2>
                  <p className="text-white/40 font-mono text-xs uppercase tracking-widest">Upgrade your mechanical assembly</p>
                </div>
                <div className="flex items-center gap-3 bg-white/5 p-4 rounded-2xl border border-white/10">
                  <Coins className="w-8 h-8 text-rose-500" />
                  <div>
                    <p className="text-[10px] text-white/40 uppercase font-bold">Available Credits</p>
                    <p className="text-2xl font-mono font-black text-white">{credits}</p>
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
                      <p className="text-sm text-white/60 leading-relaxed">Press <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">SPACE</span> or <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">→</span> to accelerate. Use <span className="bg-white/10 px-1.5 py-0.5 rounded text-white">←</span> to brake.</p>
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

      <main className="max-w-7xl mx-auto p-4 md:p-8 flex flex-col gap-8">
        {/* Top: Race View */}
        <div className="w-full space-y-6 transition-all duration-500">
          <div className="bg-[#111111] rounded-2xl border border-white/10 p-4 md:p-6 shadow-2xl relative overflow-hidden h-[500px] md:h-[650px] flex flex-col">
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

                {/* Parallax Background Grid Layers */}
                <div className="absolute inset-0 pointer-events-none opacity-[0.05]" 
                  style={{ 
                    backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
                    backgroundSize: '80px 80px',
                    transform: `translateX(${-(playerBodyRef.current?.position.x || 0) * 0.1}px)`
                  }} 
                />
                <div className="absolute inset-0 pointer-events-none opacity-10" 
                  style={{ 
                    backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
                    backgroundSize: '40px 40px',
                    transform: `translateX(${-(playerBodyRef.current?.position.x || 0) * 0.2}px)`
                  }} 
                />
                {/* Scanline & Vignette */}
                <div className="absolute inset-0 pointer-events-none z-20 scanline opacity-[0.03]" />
                <div className="absolute inset-0 pointer-events-none z-20 shadow-[inset_0_0_150px_rgba(0,0,0,0.7)]" />
              </div>

              {/* Mini Map */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-64 h-12 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden pointer-events-none">
                <div className="absolute inset-0 flex items-center px-2">
                  <div className="w-full h-[2px] bg-white/10 relative">
                    {/* Finish Line */}
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-yellow-500" />
                    {/* Player Dot */}
                    <motion.div 
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-rose-500 rounded-full shadow-[0_0_10px_rgba(244,63,94,0.8)] border-2 border-white"
                      animate={{ left: `${(playerBodyRef.current?.position.x || 0) / 5000 * 100}%` }}
                    />
                  </div>
                </div>
                <div className="absolute bottom-1 left-2 text-[6px] font-black text-white/40 uppercase tracking-widest">Mini Map</div>
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
                    {/* Left: Brake / Rotate CCW */}
                    <button
                      onMouseDown={() => setIsBraking(true)}
                      onMouseUp={() => setIsBraking(false)}
                      onTouchStart={() => setIsBraking(true)}
                      onTouchEnd={() => setIsBraking(false)}
                      className="pointer-events-auto w-20 h-20 bg-black/60 backdrop-blur-md border-2 border-white/20 rounded-2xl flex flex-col items-center justify-center active:scale-95 active:bg-red-500/40 transition-all group"
                    >
                      <RotateCcw className="w-8 h-8 text-white group-active:rotate-[-90deg] transition-transform" />
                      <span className="text-[8px] font-bold mt-1 opacity-50">BRAKE / TILT</span>
                    </button>

                    {/* Right: Gas / Rotate CW */}
                    <button
                      onMouseDown={() => setIsAccelerating(true)}
                      onMouseUp={() => setIsAccelerating(false)}
                      onTouchStart={() => setIsAccelerating(true)}
                      onTouchEnd={() => setIsAccelerating(false)}
                      className="pointer-events-auto w-24 h-24 bg-rose-600/60 backdrop-blur-md border-2 border-rose-400/40 rounded-3xl flex flex-col items-center justify-center active:scale-95 active:bg-rose-500 transition-all group shadow-xl shadow-rose-600/20"
                    >
                      <Play className="w-10 h-10 text-white group-active:scale-110 transition-transform" />
                      <span className="text-[10px] font-black mt-1">GAS / TILT</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Dashboard Overlay */}
              <div className="absolute bottom-2 md:bottom-4 left-2 md:left-4 right-2 md:right-4 flex justify-between items-end pointer-events-none">
                <div className="bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-2 md:p-4 flex gap-3 md:gap-6 shadow-[0_0_30px_rgba(0,0,0,0.5)]">
                  <div className="text-center">
                    <p className="text-[8px] md:text-[10px] text-white/40 uppercase font-black tracking-widest mb-1">Speed</p>
                    <p className="text-xl md:text-3xl font-mono font-black text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.3)]">
                      {playerBodyRef.current ? (Matter.Vector.magnitude(playerBodyRef.current.velocity) * 5).toFixed(0) : 0}
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
                  animate={{ width: `${(playerState?.progress || 0) * 100}%` }}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[#111111] rounded-2xl border border-white/10 p-6 shadow-xl">
              <h3 className="text-sm font-bold text-white/40 uppercase tracking-widest mb-4">Thermal Status</h3>
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

            <div className="bg-[#111111] rounded-2xl border border-white/10 p-6 shadow-xl">
              <h3 className="text-sm font-bold text-white/40 uppercase tracking-widest mb-4">Competitors</h3>
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
                  
                  <div className="flex-1 w-full overflow-x-auto pb-4">
                    <div 
                      className="grid gap-1 bg-[#1a1a1a] p-2 rounded-xl border border-white/5 min-h-[150px] gear-grid-bg relative min-w-[600px]"
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
