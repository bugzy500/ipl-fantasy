import { Component, inject, signal, resource } from '@angular/core';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { LeaderboardEntry, Award, SeasonInsight, MoneyEntry, SeasonInsightsResponse } from '../../core/models/api.models';
import { firstValueFrom } from 'rxjs';
import { PointBreakdownDialogComponent } from '../../shared/components/point-breakdown-dialog/point-breakdown-dialog.component';

@Component({
  selector: 'app-leaderboard',
  standalone: true,
  imports: [MatTabsModule, MatProgressSpinnerModule, MatIconModule, MatSelectModule, FormsModule, MatDialogModule],
  template: `
    <div class="space-y-6 fade-up">
      <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">
        Leaderboard
      </h1>

      <mat-tab-group animationDuration="200ms">
        <!-- Season Leaderboard -->
        <mat-tab label="Season Overall">
          @defer (on immediate) {
            @if (seasonLeaderboard.isLoading()) {
              <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
            }
            <div class="mt-6 space-y-3">
              @for (entry of seasonLeaderboard.value() ?? []; track entry.userId; let i = $index) {
                <div class="flex items-center gap-4 p-4 rounded-xl transition-all stagger-item fade-up cursor-pointer hover:brightness-110"
                     (click)="openBreakdown(entry.userId, entry.userName)"
                     [style.background]="entry.userId === auth.currentUser()?.id ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
                     [style.border]="i < 3 ? '1px solid ' + rankBorderColor(i) : '1px solid var(--color-border)'">
                  <div class="w-10 h-10 flex items-center justify-center rounded-full text-display font-bold"
                       [style.background]="rankBgColor(i)"
                       [style.color]="rankColor(i)">
                    {{ i + 1 }}
                  </div>
                  <mat-icon style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                    person
                  </mat-icon>
                  <div class="flex-1">
                    <div class="font-medium" style="color: var(--color-text);">
                      {{ entry.userName }}
                      @if (entry.userId === auth.currentUser()?.id) {
                        <span class="text-xs ml-1" style="color: var(--color-accent);">(You)</span>
                      }
                    </div>
                    <div class="text-xs" style="color: var(--color-text-muted);">
                      {{ entry.matchesPlayed }} matches played
                    </div>
                  </div>
                  <div class="text-display text-xl font-bold" style="color: var(--color-accent-hover);">
                    {{ entry.totalPoints }}
                  </div>
                </div>
              }
              @if ((seasonLeaderboard.value()?.length ?? 0) === 0 && !seasonLeaderboard.isLoading()) {
                <div class="text-center py-16 card-surface">
                  <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">
                    emoji_events
                  </mat-icon>
                  <p class="mt-3" style="color: var(--color-text-muted);">
                    No completed matches yet. Be ready!
                  </p>
                </div>
              }
            </div>
          } @placeholder {
            <div class="flex justify-center p-8"><mat-spinner /></div>
          }
        </mat-tab>

        <!-- Match Leaderboard -->
        <mat-tab label="Match">
          <div class="mt-6 space-y-4">
            <mat-select [value]="selectedMatchId()" (selectionChange)="selectedMatchId.set($event.value)" placeholder="Select a completed match">
              @for (match of completedMatches.value() ?? []; track match._id) {
                <mat-option [value]="match._id">
                  {{ match.team1 }} vs {{ match.team2 }} - {{ formatDate(match.scheduledAt) }}
                </mat-option>
              }
            </mat-select>

            @if (matchLeaderboard.isLoading()) {
              <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
            }
            @for (entry of matchLeaderboard.value() ?? []; track entry.userId; let i = $index) {
              <div class="flex items-center gap-3 p-4 rounded-xl stagger-item fade-up cursor-pointer hover:brightness-110"
                   (click)="openBreakdown(entry.userId, entry.userName, selectedMatchId())"
                   [style.background]="entry.userId === auth.currentUser()?.id ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
                   style="border: 1px solid var(--color-border);">
                <span class="w-8 text-center text-display font-bold"
                      [style.color]="rankColor(i)">
                  {{ i + 1 }}
                </span>
                <mat-icon style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                  person
                </mat-icon>
                <span class="flex-1 font-medium text-sm" style="color: var(--color-text);">
                  {{ entry.userName }}
                </span>
                <span class="text-display font-bold" style="color: var(--color-accent-hover);">
                  {{ entry.totalPoints }}
                </span>
              </div>
            }
            @if (!selectedMatchId()) {
              <div class="text-center py-12 card-surface">
                <p style="color: var(--color-text-muted);">Select a match above to see results.</p>
              </div>
            }
          </div>
        </mat-tab>
        <!-- Awards -->
        <!-- <mat-tab label="Awards">
          @defer (on immediate) {
            @if (seasonAwards.isLoading()) {
              <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
            }
            <div class="mt-6 space-y-3">
              @for (award of seasonAwards.value() ?? []; track award._id; let i = $index) {
                <div class="flex items-center gap-4 p-4 rounded-xl stagger-item fade-up"
                     style="background: var(--color-surface); border: 1px solid var(--color-border);">
                  <div class="w-10 h-10 flex items-center justify-center rounded-full"
                       [style.background]="awardBgColor(award.type)"
                       [style.color]="awardIconColor(award.type)">
                    <mat-icon style="font-size: 20px; width: 20px; height: 20px;">
                      {{ awardIcon(award.type) }}
                    </mat-icon>
                  </div>
                  <div class="flex-1">
                    <div class="font-medium text-sm" style="color: var(--color-text);">
                      {{ awardLabel(award.type) }}
                    </div>
                    <div class="text-xs" style="color: var(--color-text-muted);">
                      {{ awardUserName(award) }} — {{ award.value }}
                    </div>
                  </div>
                  <div class="text-xs text-right" style="color: var(--color-text-subtle);">
                    {{ awardMatchLabel(award) }}
                  </div>
                </div>
              }
              @if ((seasonAwards.value()?.length ?? 0) === 0 && !seasonAwards.isLoading()) {
                <div class="text-center py-16 card-surface">
                  <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">
                    military_tech
                  </mat-icon>
                  <p class="mt-3" style="color: var(--color-text-muted);">
                    No awards yet. Play some matches!
                  </p>
                </div>
              }
            </div>
          } @placeholder {
            <div class="flex justify-center p-8"><mat-spinner /></div>
          }
        </mat-tab> -->

        <!-- Season Awards -->
        <mat-tab label="Season Awards">
          @defer (on immediate) {
            @if (seasonEndAwards.isLoading()) {
              <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
            }
            <div class="mt-6 space-y-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-display text-lg font-semibold" style="color: var(--color-text);">End-of-Season Awards</h3>
                <span class="text-xs px-2 py-1 rounded-full" style="background: var(--color-accent-muted); color: var(--color-accent);">
                  {{ seasonEndAwards.value()?.matchesPlayed ?? 0 }} matches
                </span>
              </div>
              @for (award of seasonEndAwards.value()?.awards ?? []; track award.type) {
                <div class="flex items-center gap-4 p-4 rounded-xl stagger-item fade-up"
                     style="background: var(--color-surface); border: 1px solid var(--color-border);">
                  <div class="w-10 h-10 flex items-center justify-center rounded-full"
                       [style.background]="seasonAwardBg(award.type)">
                    <mat-icon style="font-size: 20px; width: 20px; height: 20px;"
                              [style.color]="seasonAwardColor(award.type)">
                      {{ award.icon }}
                    </mat-icon>
                  </div>
                  <div class="flex-1">
                    <div class="font-medium text-sm" style="color: var(--color-text);">
                      {{ award.title }}
                    </div>
                    <div class="text-xs" style="color: var(--color-text-muted);">
                      {{ award.winner }}
                    </div>
                  </div>
                  <div class="text-display font-semibold text-sm" style="color: var(--color-accent-hover);">
                    {{ award.value }}
                  </div>
                </div>
              }
              @if ((seasonEndAwards.value()?.awards?.length ?? 0) === 0 && !seasonEndAwards.isLoading()) {
                <div class="text-center py-16 card-surface">
                  <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">military_tech</mat-icon>
                  <p class="mt-3" style="color: var(--color-text-muted);">No completed matches yet. Awards will appear here!</p>
                </div>
              }
            </div>
          } @placeholder {
            <div class="flex justify-center p-8"><mat-spinner /></div>
          }
        </mat-tab>

        <!-- Money -->
        <mat-tab label="Money">
          @defer (on immediate) {
            @if (seasonInsights.isLoading()) {
              <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
            }
            <div class="mt-6 space-y-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-display text-lg font-semibold" style="color: var(--color-text);">Hisaab Kitaab</h3>
                <div class="text-right">
                  <span class="text-xs" style="color: var(--color-text-muted);">₹60/match · Top 6 win</span>
                  @if ((seasonInsights.value()?.awardPool ?? 0) > 0) {
                    <div class="text-xs font-medium" style="color: var(--color-warning);">
                      Award Pool: ₹{{ seasonInsights.value()?.awardPool }}
                    </div>
                  }
                </div>
              </div>
              @for (entry of seasonInsights.value()?.money ?? []; track entry.userId; let i = $index) {
                <div class="rounded-xl stagger-item fade-up overflow-hidden"
                     [style.background]="entry.userId === auth.currentUser()?.id ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
                     style="border: 1px solid var(--color-border);">
                  <div class="flex items-center gap-3 p-4 cursor-pointer" (click)="toggleMoneyExpand(entry.userId)">
                    <span class="w-8 text-center text-display font-bold"
                          [style.color]="rankColor(i)">
                      {{ i + 1 }}
                    </span>
                    <mat-icon style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                      account_balance_wallet
                    </mat-icon>
                    <div class="flex-1">
                      <div class="font-medium text-sm" style="color: var(--color-text);">
                        {{ entry.userName }}
                        @if (entry.userId === auth.currentUser()?.id) {
                          <span class="text-xs ml-1" style="color: var(--color-accent);">(You)</span>
                        }
                      </div>
                      <div class="text-xs" style="color: var(--color-text-muted);">
                        Invested: {{ entry.invested }} · Won: {{ entry.won }}
                      </div>
                    </div>
                    <div class="text-right flex items-center gap-2">
                      <div>
                        <div class="text-display font-bold text-lg"
                             [style.color]="entry.net > 0 ? 'var(--color-success)' : entry.net < 0 ? 'var(--color-danger)' : 'var(--color-text-muted)'">
                          {{ entry.net > 0 ? '+' : '' }}{{ entry.net }}
                        </div>
                        <div class="text-xs" style="color: var(--color-text-muted);">net</div>
                      </div>
                      <mat-icon style="color: var(--color-text-subtle); font-size: 18px; width: 18px; height: 18px; transition: transform 200ms ease-out;"
                                [style.transform]="expandedMoneyUser() === entry.userId ? 'rotate(180deg)' : 'rotate(0)'">
                        expand_more
                      </mat-icon>
                    </div>
                  </div>
                  @if (expandedMoneyUser() === entry.userId && entry.matches?.length) {
                    <div class="px-4 pb-3 space-y-1" style="border-top: 1px solid var(--color-border);">
                      <div class="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 py-1.5 text-xs font-medium" style="color: var(--color-text-subtle);">
                        <span>Match</span>
                        <span class="text-center w-8">#</span>
                        <span class="text-right w-12">Won</span>
                        <span class="text-right w-12">Net</span>
                      </div>
                      @for (m of entry.matches; track m.matchLabel) {
                        <div class="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 py-1.5 text-xs" style="border-top: 1px solid var(--color-border-subtle, rgba(255,255,255,0.05));">
                          <span style="color: var(--color-text-muted);">{{ m.matchLabel }}</span>
                          <span class="text-center w-8 font-medium" [style.color]="m.rank <= 3 ? rankColor(m.rank - 1) : 'var(--color-text-muted)'">{{ m.rank }}</span>
                          <span class="text-right w-12" style="color: var(--color-text);">₹{{ m.won }}</span>
                          <span class="text-right w-12 font-medium"
                                [style.color]="m.net > 0 ? 'var(--color-success)' : m.net < 0 ? 'var(--color-danger)' : 'var(--color-text-muted)'">
                            {{ m.net > 0 ? '+' : '' }}{{ m.net }}
                          </span>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
              @if ((seasonInsights.value()?.money?.length ?? 0) === 0 && !seasonInsights.isLoading()) {
                <div class="text-center py-16 card-surface">
                  <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">payments</mat-icon>
                  <p class="mt-3" style="color: var(--color-text-muted);">No completed matches yet.</p>
                </div>
              }
            </div>
          } @placeholder {
            <div class="flex justify-center p-8"><mat-spinner /></div>
          }
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
})
export class LeaderboardComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);

  openBreakdown(userId: string, userName: string, matchId?: string) {
    this.dialog.open(PointBreakdownDialogComponent, {
      data: { userId, userName, matchId: matchId || null },
      width: '100%',
      maxWidth: '500px',
      panelClass: 'bottom-sheet-dialog'
    });
  }

  readonly selectedMatchId = signal<string>('');
  readonly expandedMoneyUser = signal<string>('');

  toggleMoneyExpand(userId: string): void {
    this.expandedMoneyUser.set(this.expandedMoneyUser() === userId ? '' : userId);
  }

  readonly seasonLeaderboard = resource({
    loader: () => firstValueFrom(this.api.getSeasonLeaderboard()),
  });

  readonly completedMatches = resource({
    loader: async () => {
      const matches = await firstValueFrom(this.api.getMatches());
      return matches.filter((m) => m.status === 'completed');
    },
  });

  readonly seasonAwards = resource({
    loader: () => firstValueFrom(this.api.getSeasonAwards()),
  });

  readonly seasonInsights = resource({
    loader: () => firstValueFrom(this.api.getSeasonInsights()),
  });

  readonly seasonEndAwards = resource({
    loader: () => firstValueFrom(this.api.getSeasonEndAwards()),
  });

  readonly matchLeaderboard = resource({
    params: () => this.selectedMatchId(),
    loader: ({ params: id }): Promise<LeaderboardEntry[]> => {
      return id ? firstValueFrom(this.api.getMatchLeaderboard(id)) : Promise.resolve([]);
    },
  });

  rankColor(index: number): string {
    if (index === 0) return '#F59E0B';
    if (index === 1) return '#94A3B8';
    if (index === 2) return '#D97706';
    return 'var(--color-text-muted)';
  }

  rankBgColor(index: number): string {
    if (index === 0) return 'rgba(245, 158, 11, 0.15)';
    if (index === 1) return 'rgba(148, 163, 184, 0.12)';
    if (index === 2) return 'rgba(217, 119, 6, 0.12)';
    return 'var(--color-surface-elevated)';
  }

  rankBorderColor(index: number): string {
    if (index === 0) return 'rgba(245, 158, 11, 0.3)';
    if (index === 1) return 'rgba(148, 163, 184, 0.2)';
    if (index === 2) return 'rgba(217, 119, 6, 0.25)';
    return 'var(--color-border)';
  }

  formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  awardIcon(type: string): string {
    const map: Record<string, string> = {
      top_scorer: 'emoji_events', best_captain: 'stars',
      perfect_xi: 'verified', underdog_win: 'whatshot',
    };
    return map[type] ?? 'military_tech';
  }

  awardLabel(type: string): string {
    const map: Record<string, string> = {
      top_scorer: 'Top Scorer', best_captain: 'Best Captain Pick',
      perfect_xi: 'Perfect XI', underdog_win: 'Underdog Win',
    };
    return map[type] ?? type;
  }

  awardBgColor(type: string): string {
    const map: Record<string, string> = {
      top_scorer: 'rgba(245, 158, 11, 0.15)', best_captain: 'rgba(124, 58, 237, 0.15)',
      perfect_xi: 'rgba(34, 197, 94, 0.15)', underdog_win: 'rgba(239, 68, 68, 0.15)',
    };
    return map[type] ?? 'var(--color-surface-elevated)';
  }

  awardIconColor(type: string): string {
    const map: Record<string, string> = {
      top_scorer: '#F59E0B', best_captain: '#7C3AED',
      perfect_xi: '#22C55E', underdog_win: '#EF4444',
    };
    return map[type] ?? 'var(--color-text-muted)';
  }

  awardUserName(award: Award): string {
    return typeof award.userId === 'object' ? (award.userId as any).name : 'Unknown';
  }

  awardMatchLabel(award: Award): string {
    if (typeof award.matchId === 'object') {
      const m = award.matchId as any;
      return `${m.team1} vs ${m.team2}`;
    }
    return '';
  }

  insightTitle(type: string): string {
    const map: Record<string, string> = {
      best_captain: 'Best Captain Picker',
      most_consistent: 'Most Consistent',
      biggest_gainer: 'Highest Single Match',
      best_predictor: 'Best Predictor',
    };
    return map[type] ?? type;
  }

  seasonAwardBg(type: string): string {
    const gold = ['max_single_match', 'top3_finishes', 'highest_total', 'best_captain', 'best_vc', 'best_predictor'];
    const purple = ['the_batsman', 'the_bowler', 'the_allrounder', 'position_lover', 'jack_of_all'];
    const red = ['lowest_total', 'worst_captain', 'worst_vc', 'pity_award', 'worst_predictor', 'lowest_top7', 'lowest_bowling', 'lowest_batting', 'lowest_allrounder'];
    if (gold.includes(type)) return 'rgba(245, 158, 11, 0.15)';
    if (purple.includes(type)) return 'rgba(124, 58, 237, 0.15)';
    if (red.includes(type)) return 'rgba(239, 68, 68, 0.1)';
    return 'var(--color-surface-elevated)';
  }

  seasonAwardColor(type: string): string {
    const gold = ['max_single_match', 'top3_finishes', 'highest_total', 'best_captain', 'best_vc', 'best_predictor'];
    const purple = ['the_batsman', 'the_bowler', 'the_allrounder', 'position_lover', 'jack_of_all'];
    const red = ['lowest_total', 'worst_captain', 'worst_vc', 'pity_award', 'worst_predictor', 'lowest_top7', 'lowest_bowling', 'lowest_batting', 'lowest_allrounder'];
    if (gold.includes(type)) return '#F59E0B';
    if (purple.includes(type)) return '#7C3AED';
    if (red.includes(type)) return '#EF4444';
    return 'var(--color-text-muted)';
  }
}
