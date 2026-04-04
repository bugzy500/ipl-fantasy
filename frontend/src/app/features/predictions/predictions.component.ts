import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subscription, interval, switchMap, startWith } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { Match, ForecastResponse, ForecastEntry, Prediction, ScenariosResponse, Scenario } from '../../core/models/api.models';

@Component({
  selector: 'app-predictions',
  standalone: true,
  imports: [CommonModule, FormsModule, MatSelectModule, MatProgressBarModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    <div class="max-w-2xl mx-auto p-4 space-y-6">
      <h1 class="text-2xl font-bold" style="color: var(--color-text);">Predictions</h1>

      <!-- Match Selector -->
      <mat-form-field class="w-full" appearance="outline">
        <mat-label>Select Match</mat-label>
        <mat-select [(value)]="selectedMatchId" (selectionChange)="onMatchChange($event.value)">
          @for (m of relevantMatches(); track m._id) {
            <mat-option [value]="m._id">
              {{ m.team1 }} vs {{ m.team2 }}
              @if (m.status === 'live') { <span class="text-green-400 ml-2">LIVE</span> }
              @else if (m.status === 'completed') { <span class="text-gray-400 ml-2">Completed</span> }
              @else { <span class="text-yellow-400 ml-2">Upcoming</span> }
            </mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (loading()) {
        <div class="flex justify-center py-8">
          <mat-spinner [diameter]="40"></mat-spinner>
        </div>
      }

      @if (forecast()) {
        <!-- Match Progress -->
        <div class="rounded-xl p-4" style="background: var(--color-surface);">
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm font-medium" style="color: var(--color-text-muted);">
              {{ forecast()!.matchLabel }} &mdash; Innings {{ forecast()!.matchProgress.inning }}
            </span>
            <span class="text-sm font-semibold" [style.color]="confidenceColor(forecast()!.forecast[0]?.confidence || 0)">
              {{ forecast()!.forecast[0]?.confidence || 0 }}% confidence
            </span>
          </div>
          <mat-progress-bar
            mode="determinate"
            [value]="(forecast()!.matchProgress.oversCompleted / forecast()!.matchProgress.totalOvers) * 100"
            color="primary">
          </mat-progress-bar>
          <div class="flex justify-between mt-1 text-xs" style="color: var(--color-text-muted);">
            <span>{{ forecast()!.matchProgress.oversCompleted }} overs</span>
            <span>{{ forecast()!.matchProgress.totalOvers }} total</span>
          </div>
        </div>

        <!-- Win Predictions -->
        @if (winPredictions().length > 0) {
          <div class="rounded-xl p-4 space-y-3" style="background: var(--color-surface); border: 1px solid var(--color-border);">
            <div class="flex items-center gap-2">
              <mat-icon style="color: var(--color-warning); font-size: 20px; width: 20px; height: 20px;">psychology</mat-icon>
              <span class="font-semibold text-sm" style="color: var(--color-text);">Win Predictions</span>
            </div>

            <!-- Prediction Stats -->
            <div class="flex gap-3 text-center">
              <div class="flex-1 rounded-lg p-2" style="background: var(--color-surface-alt, #222);">
                <div class="text-lg font-bold" style="color: var(--color-accent-hover);">{{ predictionStats().team1Count }}</div>
                <div class="text-xs" style="color: var(--color-text-muted);">{{ predictionStats().team1 }}</div>
              </div>
              <div class="flex-1 rounded-lg p-2" style="background: var(--color-surface-alt, #222);">
                <div class="text-lg font-bold" style="color: var(--color-warning);">{{ predictionStats().team2Count }}</div>
                <div class="text-xs" style="color: var(--color-text-muted);">{{ predictionStats().team2 }}</div>
              </div>
              <div class="flex-1 rounded-lg p-2" style="background: var(--color-surface-alt, #222);">
                <div class="text-lg font-bold" style="color: var(--color-danger);">{{ predictionStats().superoverCount }}</div>
                <div class="text-xs" style="color: var(--color-text-muted);">Superover</div>
              </div>
            </div>

            <!-- Individual Predictions -->
            <div class="space-y-1">
              @for (p of winPredictions(); track p._id) {
                <div class="flex items-center justify-between py-1.5 px-2 rounded-lg text-sm"
                     [style.background]="p.userId === currentUserId() ? 'var(--color-accent-muted)' : 'transparent'">
                  <span style="color: var(--color-text);">{{ getPredictionUserName(p) }}</span>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded-full text-xs font-semibold"
                          [style.background]="p.predictionType === 'superover' ? 'var(--color-warning)' : 'var(--color-accent)'"
                          style="color: #000;">
                      {{ p.predictionType === 'superover' ? 'Superover' : p.predictedWinner }}
                    </span>
                    @if (p.isCorrect === true) {
                      <mat-icon class="text-green-400" style="font-size: 16px; width: 16px; height: 16px;">check_circle</mat-icon>
                    } @else if (p.isCorrect === false) {
                      <mat-icon class="text-red-400" style="font-size: 16px; width: 16px; height: 16px;">cancel</mat-icon>
                    }
                    @if (p.bonusPoints > 0) {
                      <span class="text-xs font-bold text-green-400">+{{ p.bonusPoints }}</span>
                    }
                  </div>
                </div>
              }
            </div>

            @if (noPredictionUsers().length > 0) {
              <div class="text-xs" style="color: var(--color-text-muted);">
                No prediction: {{ noPredictionUsers().join(', ') }}
              </div>
            }
          </div>
        }

        <!-- Match Predictor -->
        <div>
          <h2 class="text-lg font-semibold mb-3" style="color: var(--color-text);">Match Leaderboard Forecast</h2>
          <div class="space-y-2">
            @for (entry of matchRanked(); track entry.userId) {
              <div class="rounded-xl p-3 flex items-center gap-3"
                   [style.background]="entry.userId === currentUserId() ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
                   [style.border]="entry.projectedMatchRank <= 3 ? '1px solid ' + rankColor(entry.projectedMatchRank) : '1px solid transparent'">
                <!-- Rank -->
                <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                     [style.background]="rankColor(entry.projectedMatchRank)"
                     style="color: #000;">
                  {{ entry.projectedMatchRank }}
                </div>
                <!-- Name & Points -->
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-sm truncate" style="color: var(--color-text);">{{ entry.userName }}</div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs" style="color: var(--color-text-muted);">
                      Live: {{ entry.livePoints }}
                    </span>
                    <span class="text-xs font-semibold" style="color: var(--color-accent);">
                      Proj: {{ entry.projectedMatchPoints }}
                    </span>
                    <span class="text-xs" style="color: var(--color-text-muted);">
                      ({{ entry.pointRange.min }} - {{ entry.pointRange.max }})
                    </span>
                  </div>
                </div>
                <!-- Confidence Bar -->
                <div class="w-16 shrink-0">
                  <div class="h-2 rounded-full overflow-hidden" style="background: var(--color-surface-alt, #333);">
                    <div class="h-full rounded-full transition-all duration-500"
                         [style.width.%]="entry.confidence"
                         [style.background]="confidenceColor(entry.confidence)">
                    </div>
                  </div>
                </div>
              </div>
            }
          </div>
        </div>

        <!-- Season Projector -->
        <div>
          <h2 class="text-lg font-semibold mb-3" style="color: var(--color-text);">Season Standings Projection</h2>
          <div class="space-y-2">
            @for (entry of seasonRanked(); track entry.userId) {
              <div class="rounded-xl p-3 flex items-center gap-3"
                   [style.background]="entry.userId === currentUserId() ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
                   [style.border]="entry.projectedRank <= 3 ? '1px solid ' + rankColor(entry.projectedRank) : '1px solid transparent'">
                <!-- Rank -->
                <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                     [style.background]="rankColor(entry.projectedRank)"
                     style="color: #000;">
                  {{ entry.projectedRank }}
                </div>
                <!-- Name & Points -->
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-sm truncate" style="color: var(--color-text);">{{ entry.userName }}</div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-xs" style="color: var(--color-text-muted);">
                      Season: {{ entry.currentPoints }}
                    </span>
                    <span class="text-xs" style="color: var(--color-text-muted);">+</span>
                    <span class="text-xs" style="color: var(--color-accent);">
                      {{ entry.projectedMatchPoints }}
                    </span>
                    <span class="text-xs" style="color: var(--color-text-muted);">=</span>
                    <span class="text-sm font-bold" style="color: var(--color-text);">
                      {{ entry.projectedSeasonTotal }}
                    </span>
                  </div>
                </div>
                <!-- Rank Movement -->
                <div class="shrink-0 flex items-center gap-1">
                  @if (entry.currentSeasonRank > entry.projectedRank) {
                    <mat-icon class="text-green-400" style="font-size: 18px; width: 18px; height: 18px;">arrow_upward</mat-icon>
                    <span class="text-xs text-green-400">{{ entry.currentSeasonRank - entry.projectedRank }}</span>
                  } @else if (entry.currentSeasonRank < entry.projectedRank) {
                    <mat-icon class="text-red-400" style="font-size: 18px; width: 18px; height: 18px;">arrow_downward</mat-icon>
                    <span class="text-xs text-red-400">{{ entry.projectedRank - entry.currentSeasonRank }}</span>
                  } @else {
                    <span class="text-xs" style="color: var(--color-text-muted);">&mdash;</span>
                  }
                </div>
              </div>
            }
          </div>
        </div>

        <!-- What-If Scenarios -->
        @if (scenariosData()) {
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h2 class="text-lg font-semibold" style="color: var(--color-text);">What If...?</h2>
              <span class="text-xs px-2 py-0.5 rounded-full" style="background: var(--color-surface-alt, #333); color: var(--color-text-muted);">
                {{ scenariosData()!.totalEvaluated }} events analyzed
              </span>
            </div>

            <!-- Filters -->
            <div class="flex gap-2 flex-wrap">
              <button class="px-3 py-1 rounded-full text-xs font-medium transition-all"
                      [style.background]="scenarioFilter() === 'all' ? 'var(--color-accent)' : 'var(--color-surface)'"
                      [style.color]="scenarioFilter() === 'all' ? '#000' : 'var(--color-text-muted)'"
                      (click)="scenarioFilter.set('all')">All</button>
              <button class="px-3 py-1 rounded-full text-xs font-medium transition-all"
                      [style.background]="scenarioFilter() === 'batting' ? 'var(--color-accent)' : 'var(--color-surface)'"
                      [style.color]="scenarioFilter() === 'batting' ? '#000' : 'var(--color-text-muted)'"
                      (click)="scenarioFilter.set('batting')">Batting</button>
              <button class="px-3 py-1 rounded-full text-xs font-medium transition-all"
                      [style.background]="scenarioFilter() === 'bowling' ? 'var(--color-accent)' : 'var(--color-surface)'"
                      [style.color]="scenarioFilter() === 'bowling' ? '#000' : 'var(--color-text-muted)'"
                      (click)="scenarioFilter.set('bowling')">Bowling</button>
              <button class="px-3 py-1 rounded-full text-xs font-medium transition-all"
                      [style.background]="scenarioFilter() === 'fielding' ? 'var(--color-accent)' : 'var(--color-surface)'"
                      [style.color]="scenarioFilter() === 'fielding' ? '#000' : 'var(--color-text-muted)'"
                      (click)="scenarioFilter.set('fielding')">Fielding</button>
              <button class="px-3 py-1 rounded-full text-xs font-medium transition-all"
                      [style.background]="scenarioFilter() === 'me' ? 'var(--color-accent)' : 'var(--color-surface)'"
                      [style.color]="scenarioFilter() === 'me' ? '#000' : 'var(--color-text-muted)'"
                      (click)="scenarioFilter.set('me')">Affects Me</button>
            </div>

            <!-- Search -->
            <input type="text" placeholder="Search player, user, or event..."
                   class="w-full px-3 py-2 rounded-lg text-sm"
                   style="background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text);"
                   [value]="scenarioSearch()"
                   (input)="scenarioSearch.set($any($event.target).value)" />

            <!-- Scenario Cards -->
            <div class="space-y-2">
              @for (s of filteredScenarios(); track s.event) {
                <div class="rounded-xl p-3 space-y-2" style="background: var(--color-surface); border: 1px solid var(--color-border);">
                  <!-- Event -->
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex items-center gap-2">
                      <mat-icon style="font-size: 16px; width: 16px; height: 16px; color: var(--color-warning);">
                        {{ getScenarioIcon(s) }}
                      </mat-icon>
                      <span class="text-sm font-medium" style="color: var(--color-text);">{{ s.event }}</span>
                    </div>
                    <span class="text-xs px-2 py-0.5 rounded-full shrink-0"
                          [style.background]="s.impact >= 4 ? 'var(--color-danger)' : s.impact >= 2 ? 'var(--color-warning)' : 'var(--color-accent)'"
                          style="color: #000;">
                      {{ s.impact }} pos shift{{ s.impact > 1 ? 's' : '' }}
                    </span>
                  </div>

                  <!-- Owners -->
                  <div class="text-xs" style="color: var(--color-text-muted);">
                    Picked by: {{ s.owners.map(o => o.userName + ' ' + o.multiplier).join(', ') }}
                  </div>

                  <!-- Position Changes -->
                  <div class="flex flex-wrap gap-2">
                    @for (sw of s.swaps; track sw.userId) {
                      <div class="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs"
                           [style.background]="sw.direction === 'up' ? '#22C55E22' : '#EF444422'"
                           [style.color]="sw.direction === 'up' ? '#22C55E' : '#EF4444'">
                        <mat-icon style="font-size: 12px; width: 12px; height: 12px;">
                          {{ sw.direction === 'up' ? 'arrow_upward' : 'arrow_downward' }}
                        </mat-icon>
                        {{ sw.userName }}: #{{ sw.oldRank }} → #{{ sw.newRank }}
                      </div>
                    }
                  </div>
                </div>
              }
            </div>

            @if (filteredScenarios().length === 0) {
              <p class="text-sm text-center py-4" style="color: var(--color-text-muted);">
                No scenarios match this filter
              </p>
            }
          </div>
        }

        <p class="text-xs text-center" style="color: var(--color-text-muted);">
          Updated {{ forecast()!.generatedAt | date:'shortTime' }} &bull; Refreshes every 30s during live matches
        </p>
      }

      @if (error()) {
        <div class="rounded-xl p-4 text-center" style="background: var(--color-danger-muted, #3a1a1a); color: var(--color-danger);">
          {{ error() }}
        </div>
      }
    </div>
  `,
})
export class PredictionsComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private pollSub?: Subscription;

  selectedMatchId = '';
  readonly matches = signal<Match[]>([]);
  readonly forecast = signal<ForecastResponse | null>(null);
  readonly winPredictions = signal<Prediction[]>([]);
  readonly scenariosData = signal<ScenariosResponse | null>(null);
  readonly scenarioFilter = signal<string>('all');
  readonly scenarioSearch = signal('');
  readonly loading = signal(false);
  readonly error = signal('');

  readonly currentUserId = computed(() => this.auth.currentUser()?.id || '');

  readonly relevantMatches = computed(() =>
    this.matches().filter((m) => ['live', 'completed', 'upcoming', 'toss_done'].includes(m.status))
      .sort((a, b) => {
        // Live first, then upcoming, then completed
        const order: Record<string, number> = { live: 0, toss_done: 1, upcoming: 2, completed: 3 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      })
  );

  readonly predictionStats = computed(() => {
    const preds = this.winPredictions();
    const f = this.forecast();
    const label = f?.matchLabel?.split(' vs ') || ['Team 1', 'Team 2'];
    return {
      team1: label[0],
      team2: label[1],
      team1Count: preds.filter((p) => p.predictionType === 'winner' && p.predictedWinner === label[0]).length,
      team2Count: preds.filter((p) => p.predictionType === 'winner' && p.predictedWinner === label[1]).length,
      superoverCount: preds.filter((p) => p.predictionType === 'superover').length,
    };
  });

  readonly noPredictionUsers = computed(() => {
    const f = this.forecast();
    const preds = this.winPredictions();
    if (!f || preds.length === 0) return [];
    const predictedUserIds = new Set(preds.map((p) => typeof p.userId === 'string' ? p.userId : (p.userId as any)?.id || (p.userId as any)?._id));
    return f.forecast
      .filter((entry) => !predictedUserIds.has(entry.userId))
      .map((entry) => entry.userName);
  });

  readonly filteredScenarios = computed(() => {
    const data = this.scenariosData();
    if (!data) return [];
    const filter = this.scenarioFilter();
    const search = this.scenarioSearch().toLowerCase().trim();
    const userId = this.currentUserId();

    return data.scenarios.filter((s) => {
      // Type filter
      if (filter === 'batting' && !s.event.match(/scores|gets out|reaches|century/i)) return false;
      if (filter === 'bowling' && !s.event.match(/wicket|maiden|concedes/i)) return false;
      if (filter === 'fielding' && !s.event.match(/catch/i)) return false;
      if (filter === 'me' && !s.swaps.some((sw) => sw.userId === userId)) return false;

      // Search filter — match player name, owner name, or affected user name
      if (search) {
        const matchesPlayer = s.playerName.toLowerCase().includes(search);
        const matchesOwner = s.owners.some((o) => o.userName.toLowerCase().includes(search));
        const matchesAffected = s.swaps.some((sw) => sw.userName.toLowerCase().includes(search));
        if (!matchesPlayer && !matchesOwner && !matchesAffected) return false;
      }

      return true;
    });
  });

  readonly matchRanked = computed(() => {
    const f = this.forecast();
    if (!f) return [];
    return [...f.forecast].sort((a, b) => a.projectedMatchRank - b.projectedMatchRank);
  });

  readonly seasonRanked = computed(() => {
    const f = this.forecast();
    if (!f) return [];
    return [...f.forecast].sort((a, b) => a.projectedRank - b.projectedRank);
  });

  async ngOnInit() {
    const allMatches = await firstValueFrom(this.api.getMatches());
    this.matches.set(allMatches);

    // Auto-select first live match, or first upcoming, or first completed
    const live = allMatches.find((m) => m.status === 'live');
    const upcoming = allMatches.find((m) => m.status === 'upcoming' || m.status === 'toss_done');
    const completed = allMatches.find((m) => m.status === 'completed');
    const autoSelect = live || upcoming || completed;

    if (autoSelect) {
      this.selectedMatchId = autoSelect._id;
      this.startPolling(autoSelect._id, autoSelect.status);
    }
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
  }

  onMatchChange(matchId: string) {
    const match = this.matches().find((m) => m._id === matchId);
    this.startPolling(matchId, match?.status || 'upcoming');
  }

  private startPolling(matchId: string, status: string) {
    this.pollSub?.unsubscribe();
    this.forecast.set(null);
    this.winPredictions.set([]);
    this.scenariosData.set(null);
    this.scenarioFilter.set('all');
    this.scenarioSearch.set('');
    this.error.set('');
    this.loading.set(true);

    // Fetch win predictions (only visible after deadline)
    this.api.getMatchPredictions(matchId).subscribe({
      next: (preds) => this.winPredictions.set(preds),
      error: () => this.winPredictions.set([]),
    });

    // Fetch scenarios
    this.api.getScenarios(matchId).subscribe({
      next: (data) => this.scenariosData.set(data),
      error: () => this.scenariosData.set(null),
    });

    if (status === 'live') {
      this.pollSub = interval(30_000).pipe(
        startWith(0),
        switchMap(() => this.api.getLeaderboardForecast(matchId)),
      ).subscribe({
        next: (data) => {
          this.forecast.set(data); this.loading.set(false);
          // Refresh scenarios on each poll
          this.api.getScenarios(matchId).subscribe({
            next: (s) => this.scenariosData.set(s),
            error: () => {},
          });
        },
        error: (err) => { this.error.set(err.error?.message ?? 'Failed to load forecast'); this.loading.set(false); },
      });
    } else {
      this.api.getLeaderboardForecast(matchId).subscribe({
        next: (data) => { this.forecast.set(data); this.loading.set(false); },
        error: (err) => { this.error.set(err.error?.message ?? 'Failed to load forecast'); this.loading.set(false); },
      });
    }
  }

  getPredictionUserName(p: Prediction): string {
    if (typeof p.userId === 'string') return p.userId;
    return (p.userId as any)?.name || 'Unknown';
  }

  getScenarioIcon(s: Scenario): string {
    if (s.event.match(/scores|reaches|century/i)) return 'sports_cricket';
    if (s.event.match(/gets out/i)) return 'close';
    if (s.event.match(/wicket/i)) return 'whatshot';
    if (s.event.match(/maiden/i)) return 'shield';
    if (s.event.match(/concedes/i)) return 'trending_down';
    if (s.event.match(/catch/i)) return 'pan_tool';
    return 'bolt';
  }

  rankColor(rank: number): string {
    if (rank === 1) return '#FFD700';
    if (rank === 2) return '#C0C0C0';
    if (rank === 3) return '#CD7F32';
    return 'var(--color-surface-alt, #444)';
  }

  confidenceColor(c: number): string {
    if (c < 33) return '#EF4444';
    if (c < 66) return '#F59E0B';
    return '#22C55E';
  }
}
