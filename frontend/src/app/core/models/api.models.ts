// ──────────────────────────────────────────────────────────────────────────────
// TypeScript interfaces that mirror the Mongoose schemas in the backend.
// Keep these in sync when schema changes are made.
// ──────────────────────────────────────────────────────────────────────────────

export type PlayerRole = 'WK' | 'BAT' | 'AR' | 'BOWL';
export type Franchise = 'CSK' | 'MI' | 'RCB' | 'KKR' | 'SRH' | 'RR' | 'PBKS' | 'DC' | 'GT' | 'LSG';
export type MatchStatus = 'upcoming' | 'toss_done' | 'live' | 'completed' | 'abandoned';
export type PlayingStatus = 'playing' | 'not_playing' | 'unknown';

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: 'admin' | 'user';
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface Player {
  _id: string;
  name: string;
  franchise: Franchise;
  role: PlayerRole;
  credits: number;
  imageUrl: string;
  isActive: boolean;
  // Added by the /matches/:id/squad endpoint
  playingStatus?: PlayingStatus;
}

export interface Match {
  _id: string;
  team1: Franchise;
  team2: Franchise;
  venue: string;
  scheduledAt: string; // ISO date string
  deadline: string;    // ISO date string (scheduledAt + 30 min)
  status: MatchStatus;
  playingXI: { team1: Player[]; team2: Player[] };
  result: string;
  // CricAPI integration
  cricApiMatchId?: string;
  lastPolledAt?: string;
  pollingEnabled?: boolean;
}

export interface FantasyTeam {
  _id: string;
  userId: string | User;
  matchId: string;
  players: Player[];
  captain: string | Player;
  viceCaptain: string | Player;
  totalPoints: number;
  isLocked: boolean;
}

export interface PlayerPerformance {
  _id: string;
  playerId: Player;
  matchId: string;
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  isDismissed: boolean;
  didBat: boolean;
  oversBowled: number;
  runsConceded: number;
  wickets: number;
  maidens: number;
  lbwBowledWickets: number;
  catches: number;
  stumpings: number;
  runOutDirect: number;
  runOutIndirect: number;
  fantasyPoints: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  userName: string;
  totalPoints: number;
  matchesPlayed?: number;
  teamId?: string;
}

export type AwardType = 'top_scorer' | 'best_captain' | 'perfect_xi' | 'underdog_win';

export interface Award {
  _id: string;
  matchId: string | Pick<Match, '_id' | 'team1' | 'team2' | 'scheduledAt'>;
  type: AwardType;
  userId: string | Pick<User, 'id' | 'name'>;
  value: string;
  description: string;
  createdAt: string;
}

export interface MatchSquadResponse {
  match: Pick<Match, '_id' | 'team1' | 'team2' | 'deadline' | 'status'>;
  players: Player[];
}

export interface Prediction {
  _id: string;
  userId: string | Pick<User, 'id' | 'name'>;
  matchId: string;
  predictedWinner: Franchise;
  isCorrect: boolean | null;
  bonusPoints: number;
}

export interface SeasonInsight {
  type: string;
  icon: string;
  userId: string;
  userName: string;
  value: number;
  label: string;
}

export interface MoneyEntry {
  userId: string;
  userName: string;
  invested: number;
  won: number;
  net: number;
}

export interface SeasonInsightsResponse {
  insights: SeasonInsight[];
  money: MoneyEntry[];
}
