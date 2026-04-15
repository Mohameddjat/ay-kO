export interface Gear {
  id: string;
  x: number;
  y: number;
  teeth: number;
  type: 'input' | 'output' | 'intermediate';
}

export interface PlayerState {
  id: string;
  x: number;
  y: number;
  angle: number;
  gearRatio: number;
  temp: number;
  brakeTemp: number;
  progress: number;
  isExploded: boolean;
}

export interface GameRoom {
  players: Record<string, PlayerState>;
}
