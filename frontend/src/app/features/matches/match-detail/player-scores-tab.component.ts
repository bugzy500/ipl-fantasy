import { Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { MatchStatus, PlayerPerformance, ScoreBreakdownSection } from '../../../core/models/api.models';

const POLL_INTERVAL_MS = 30_000;

@Component({
  selector: 'app-player-scores-tab',
  standalone: true,
  imports: [MatProgressSpinnerModule, MatIconModule],
  template: `
    <div class="p-4 space-y-4">
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-display font-semibold" style="color: var(--color-text);">
            Player Scorecards
          </h3>
          @if (isLive()) {
            <span class="inline-flex items-center gap-1.5 status-live">
              <span class="live-dot"></span>
              updates every 30s
            </span>
          }
        </div>
        <p class="text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
          Tap a player to see the exact batting, bowling, and fielding line-items behind the final fantasy total.
        </p>
      </div>

      <div class="flex gap-2 flex-wrap">
        @for (role of roles; track role.key) {
          <button class="filter-chip"
                  [class.filter-chip--active]="activeRole() === role.key"
                  (click)="activeRole.set(role.key)">
            {{ role.label }}
          </button>
        }
      </div>

      @if (loading()) {
        <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
      }
      @if (error()) {
        <p class="text-center" style="color: var(--color-danger);">{{ error() }}</p>
      }

      @if (filtered().length === 0 && !loading() && !error()) {
        <div class="text-center py-12 card-surface rounded-xl">
          <mat-icon style="font-size: 40px; width: 40px; height: 40px; color: var(--color-text-subtle);">
            scoreboard
          </mat-icon>
          <p class="mt-3" style="color: var(--color-text-muted);">No player scores available yet.</p>
        </div>
      }

      @for (perf of filtered(); track perf._id; let i = $index) {
        <div class="player-score-card stagger-item fade-up"
             (click)="toggleExpand(perf._id)">
          <div class="flex items-center gap-3">
            <span class="rank-num text-display font-bold"
                  style="color: var(--color-text-subtle); width: 24px; text-align: center;">
              {{ i + 1 }}
            </span>
            <div class="flex-1 min-w-0 space-y-1">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm truncate" style="color: var(--color-text);">
                  {{ perf.playerId.name }}
                </span>
                <span class="role-badge role-badge--{{ perf.playerId.role.toLowerCase() }}">
                  {{ perf.playerId.role }}
                </span>
              </div>
              <div class="flex flex-wrap gap-1.5">
                @for (summary of summaryPills(perf); track summary) {
                  <span class="summary-pill">{{ summary }}</span>
                }
              </div>
            </div>
            <span class="text-display font-bold text-lg" [style.color]="pointColor(perf.fantasyPoints)">
              {{ formatPoints(perf.fantasyPoints) }}
            </span>
            <mat-icon class="expand-icon"
                      [class.expand-icon--open]="expanded() === perf._id"
                      style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
              expand_more
            </mat-icon>
          </div>

          @if (expanded() === perf._id) {
            <div class="breakdown-grid mt-4 pt-4" style="border-top: 1px solid var(--color-border);">
              @for (section of breakdownSections(perf); track section.key) {
                <div class="breakdown-section">
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-label">{{ section.label }}</span>
                    <span class="section-total" [style.color]="pointColor(section.subtotal)">
                      {{ formatPoints(section.subtotal) }}
                    </span>
                  </div>
                  <div class="space-y-2">
                    @for (item of section.items; track item.label + item.detail) {
                      <div class="breakdown-item">
                        <div class="min-w-0">
                          <div class="text-sm font-medium truncate" style="color: var(--color-text);">
                            {{ item.label }}
                          </div>
                          <div class="text-xs" style="color: var(--color-text-muted);">
                            {{ item.detail }}
                          </div>
                        </div>
                        <span class="points-chip" [style]="pointsChipStyle(item.points)">
                          {{ formatPoints(item.points) }}
                        </span>
                      </div>
                    }
                  </div>
                </div>
              }

              @if (breakdownSections(perf).length === 0) {
                <p class="text-xs" style="color: var(--color-text-muted);">No scoring events recorded yet.</p>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .player-score-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      cursor: pointer;
      transition: background 200ms var(--ease-out), border-color 200ms var(--ease-out);
    }
    .player-score-card:hover {
      background: var(--color-surface-elevated);
      border-color: var(--color-border-hover);
    }
    .player-score-card:active {
      transform: scale(0.995);
    }

    .expand-icon {
      transition: transform 200ms var(--ease-out);
    }
    .expand-icon--open {
      transform: rotate(180deg);
    }

    .filter-chip {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 20px;
      color: var(--color-text-muted);
      font-size: 12px;
      font-weight: 500;
      padding: 6px 16px;
      cursor: pointer;
      transition: all 160ms var(--ease-out);
      min-height: 32px;
    }
    .filter-chip:hover {
      border-color: var(--color-accent);
      color: var(--color-text);
    }
    .filter-chip:active {
      transform: scale(0.97);
    }
    .filter-chip--active {
      background: var(--color-accent-muted);
      border-color: var(--color-accent);
      color: var(--color-accent-hover);
    }

    .role-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .role-badge--wk  { background: rgba(245, 158, 11, 0.15); color: #F59E0B; }
    .role-badge--bat { background: rgba(59, 130, 246, 0.15); color: #3B82F6; }
    .role-badge--ar  { background: rgba(34, 197, 94, 0.15); color: #22C55E; }
    .role-badge--bowl { background: rgba(232, 83, 74, 0.15); color: #E8534A; }

    .summary-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--color-text-subtle);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 999px;
      padding: 3px 8px;
    }

    .breakdown-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .breakdown-section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-elevated);
    }
    .text-label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--color-text-subtle);
    }
    .section-total {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 14px;
    }
    .breakdown-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .points-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--font-display);
      white-space: nowrap;
    }
  `],
})
export class PlayerScoresTabComponent implements OnInit, OnDestroy {
  readonly matchId = input.required<string>();
  readonly matchStatus = input.required<MatchStatus>();

  private readonly api = inject(ApiService);

  readonly performances = signal<PlayerPerformance[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly activeRole = signal<string>('ALL');
  readonly expanded = signal<string | null>(null);
  readonly isLive = computed(() => this.matchStatus() === 'live');

  readonly roles = [
    { key: 'ALL', label: 'All' },
    { key: 'BAT', label: 'Batters' },
    { key: 'BOWL', label: 'Bowlers' },
    { key: 'AR', label: 'All-rounders' },
    { key: 'WK', label: 'Wicketkeepers' },
  ];

  readonly filtered = computed(() => {
    const role = this.activeRole();
    const perfs = this.performances();
    const list = role === 'ALL' ? perfs : perfs.filter((p) => p.playerId?.role === role);
    return [...list].sort((a, b) => b.fantasyPoints - a.fantasyPoints);
  });

  private subscription?: Subscription;

  ngOnInit() {
    const source$ = this.isLive()
      ? interval(POLL_INTERVAL_MS).pipe(startWith(0), switchMap(() => this.api.getScores(this.matchId())))
      : this.api.getScores(this.matchId());

    this.subscription = source$.subscribe({
      next: (data) => {
        this.performances.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'Failed to load player scores');
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }

  toggleExpand(id: string) {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  strikeRate(p: PlayerPerformance): string {
    if (!p.ballsFaced) return '0.00';
    return ((p.runs / p.ballsFaced) * 100).toFixed(2);
  }

  economy(p: PlayerPerformance): string {
    if (!p.oversBowled) return '0.00';
    return (p.runsConceded / p.oversBowled).toFixed(2);
  }

  summaryPills(perf: PlayerPerformance): string[] {
    const pills: string[] = [];
    if (perf.didBat) {
      pills.push(`${perf.runs} (${perf.ballsFaced}b)`);
      if (perf.ballsFaced >= 10) pills.push(`SR ${this.strikeRate(perf)}`);
    }
    if (perf.oversBowled > 0) {
      pills.push(`${perf.wickets}/${perf.runsConceded} in ${perf.oversBowled} ov`);
      if (perf.oversBowled >= 2) pills.push(`Econ ${this.economy(perf)}`);
    }
    if (perf.catches > 0) pills.push(`${perf.catches} catch${perf.catches === 1 ? '' : 'es'}`);
    if (perf.stumpings > 0) pills.push(`${perf.stumpings} stumping${perf.stumpings === 1 ? '' : 's'}`);
    if (perf.runOutDirect > 0) pills.push(`${perf.runOutDirect} direct RO`);
    if (perf.runOutIndirect > 0) pills.push(`${perf.runOutIndirect} assist RO`);
    return pills.length > 0 ? pills : ['No scoring events yet'];
  }

  breakdownSections(perf: PlayerPerformance): ScoreBreakdownSection[] {
    return perf.scoreBreakdown?.sections ?? [];
  }

  formatPoints(points: number): string {
    return points > 0 ? `+${points}` : `${points}`;
  }

  pointColor(points: number): string {
    if (points > 0) return 'var(--color-accent-hover)';
    if (points < 0) return 'var(--color-danger)';
    return 'var(--color-text-muted)';
  }

  pointsChipStyle(points: number): string {
    if (points > 0) {
      return 'background: rgba(34, 197, 94, 0.14); color: var(--color-success); border: 1px solid rgba(34, 197, 94, 0.25);';
    }
    if (points < 0) {
      return 'background: rgba(232, 83, 74, 0.14); color: var(--color-danger); border: 1px solid rgba(232, 83, 74, 0.25);';
    }
    return 'background: rgba(148, 163, 184, 0.12); color: var(--color-text-subtle); border: 1px solid rgba(148, 163, 184, 0.2);';
  }
}
