import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  Player,
  Match,
  FantasyTeam,
  LeaderboardEntry,
  PlayerPerformance,
  MatchSquadResponse,
  Award,
  Prediction,
  SeasonInsightsResponse,
  ScoringRulesResponse,
  ForecastResponse,
  ScenariosResponse,
} from '../models/api.models';

/**
 * Central API service — thin wrapper around HttpClient.
 * All methods return typed Observables.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  // ── Players ────────────────────────────────────────────────────────────────
  getPlayers(filters: { role?: string; franchise?: string; search?: string } = {}) {
    let params = new HttpParams();
    if (filters.role) params = params.set('role', filters.role);
    if (filters.franchise) params = params.set('franchise', filters.franchise);
    if (filters.search) params = params.set('search', filters.search);
    return this.http.get<Player[]>(`${this.base}/players`, { params });
  }

  createPlayer(data: Partial<Player>) {
    return this.http.post<Player>(`${this.base}/players`, data);
  }

  updatePlayer(id: string, data: Partial<Player>) {
    return this.http.put<Player>(`${this.base}/players/${id}`, data);
  }

  deletePlayer(id: string) {
    return this.http.delete(`${this.base}/players/${id}`);
  }

  // ── Matches ────────────────────────────────────────────────────────────────
  getMatches() {
    return this.http.get<Match[]>(`${this.base}/matches`);
  }

  getMatch(id: string) {
    return this.http.get<Match>(`${this.base}/matches/${id}`);
  }

  getMatchSquad(id: string) {
    return this.http.get<MatchSquadResponse>(`${this.base}/matches/${id}/squad`);
  }

  createMatch(data: Partial<Match>) {
    return this.http.post<Match>(`${this.base}/matches`, data);
  }

  updateMatch(id: string, data: Partial<Match> & { playingXI?: any }) {
    return this.http.patch<Match>(`${this.base}/matches/${id}`, data);
  }

  // ── Fantasy Teams ──────────────────────────────────────────────────────────
  upsertTeam(payload: { matchId: string; players: string[]; captain: string; viceCaptain: string }) {
    return this.http.post<FantasyTeam>(`${this.base}/teams`, payload);
  }

  getMyTeam(matchId: string) {
    return this.http.get<FantasyTeam>(`${this.base}/teams/my/${matchId}`);
  }

  getAllTeams(matchId: string) {
    return this.http.get<FantasyTeam[]>(`${this.base}/teams/all/${matchId}`);
  }

  // ── Scores ─────────────────────────────────────────────────────────────────
  getScores(matchId: string) {
    return this.http.get<PlayerPerformance[]>(`${this.base}/scores/${matchId}`);
  }

  getScoringRules() {
    return this.http.get<ScoringRulesResponse>(`${this.base}/scores/rules`);
  }

  submitScores(matchId: string, performances: Partial<PlayerPerformance>[], result = '') {
    return this.http.post(`${this.base}/scores/${matchId}`, { performances, result });
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────
  getMatchLeaderboard(matchId: string) {
    return this.http.get<LeaderboardEntry[]>(`${this.base}/leaderboard/match/${matchId}`);
  }

  getSeasonLeaderboard() {
    return this.http.get<LeaderboardEntry[]>(`${this.base}/leaderboard/season`);
  }

  getUserBreakdown(userId: string) {
    return this.http.get<import('../models/api.models').UserBreakdownTeam[]>(`${this.base}/leaderboard/breakdown/${userId}`);
  }

  // ── Awards ──────────────────────────────────────────────────────────────────
  getMatchAwards(matchId: string) {
    return this.http.get<Award[]>(`${this.base}/awards/match/${matchId}`);
  }

  getSeasonAwards() {
    return this.http.get<Award[]>(`${this.base}/awards/season`);
  }

  // ── CricAPI (admin) ────────────────────────────────────────────────────────
  linkCricApiMatch(matchId: string, cricApiMatchId: string) {
    return this.http.post(`${this.base}/cricapi/link/${matchId}`, { cricApiMatchId });
  }

  startPolling(matchId: string) {
    return this.http.post(`${this.base}/cricapi/poll/${matchId}/start`, {});
  }

  stopPolling(matchId: string) {
    return this.http.post(`${this.base}/cricapi/poll/${matchId}/stop`, {});
  }

  getPollingStatus() {
    return this.http.get<{ activePollers: any[]; apiCallsToday: number; dailyLimit: number }>(`${this.base}/cricapi/poll/status`);
  }

  syncOnce(matchId: string) {
    return this.http.post(`${this.base}/cricapi/sync-once/${matchId}`, {});
  }

  previewScorecard(matchId: string) {
    return this.http.get<any>(`${this.base}/cricapi/preview/${matchId}`);
  }

  syncPlayerImages() {
    return this.http.post(`${this.base}/cricapi/sync-images`, {});
  }

  autoLinkCricApiMatches() {
    return this.http.post<{ linked: number; results: any[] }>(`${this.base}/cricapi/auto-link`, {});
  }

  // ── Predictions ────────────────────────────────────────────────────────────
  upsertPrediction(payload: { matchId: string; predictedWinner: string; predictionType?: 'winner' | 'superover' }) {
    return this.http.post<Prediction>(`${this.base}/predictions`, payload);
  }

  getMatchPredictions(matchId: string) {
    return this.http.get<Prediction[]>(`${this.base}/predictions/match/${matchId}`);
  }

  getMyPrediction(matchId: string) {
    return this.http.get<Prediction | null>(`${this.base}/predictions/my/${matchId}`);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  getSeasonInsights() {
    return this.http.get<SeasonInsightsResponse>(`${this.base}/stats/season-insights`);
  }

  getSeasonEndAwards() {
    return this.http.get<any>(`${this.base}/stats/season-awards`);
  }

  // ── Forecast ──────────────────────────────────────────────────────────────
  getLeaderboardForecast(matchId: string) {
    return this.http.get<ForecastResponse>(`${this.base}/forecast/${matchId}`);
  }

  getScenarios(matchId: string) {
    return this.http.get<ScenariosResponse>(`${this.base}/forecast/${matchId}/scenarios`);
  }
}
