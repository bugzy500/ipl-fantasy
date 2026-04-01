import { Component, inject, input, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { interval, Subscription, startWith, switchMap } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { PlayerPerformance, MatchStatus } from '../../../core/models/api.models';

const POLL_INTERVAL_MS = 30_000;

@Component({
  selector: 'app-player-scores-tab',
  standalone: true,
  imports: [MatProgressSpinnerModule, MatIconModule],
  template: `
    <div class="p-4 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-display font-semibold" style="color: var(--color-text);">
          Player Scores
        </h3>
        @if (isLive()) {
          <span class="inline-flex items-center gap-1.5 status-live">
            <span class="live-dot"></span>
            updates every 30s
          </span>
        }
      </div>

      <!-- Role filter -->
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

      <!-- Player cards -->
      @for (perf of filtered(); track perf._id; let i = $index) {
        <div class="player-score-card stagger-item fade-up"
             (click)="toggleExpand(perf._id)">
          <!-- Summary row -->
          <div class="flex items-center gap-3">
            <span class="rank-num text-display font-bold"
                  style="color: var(--color-text-subtle); width: 24px; text-align: center;">
              {{ i + 1 }}
            </span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm truncate" style="color: var(--color-text);">
                  {{ perf.playerId.name }}
                </span>
                <span class="role-badge role-badge--{{ perf.playerId.role.toLowerCase() }}">
                  {{ perf.playerId.role }}
                </span>
              </div>
              <span class="text-xs" style="color: var(--color-text-muted);">
                {{ perf.playerId.franchise }}
              </span>
            </div>
            <span class="text-display font-bold text-lg"
                  [style.color]="perf.fantasyPoints > 0 ? 'var(--color-accent-hover)' : perf.fantasyPoints < 0 ? 'var(--color-danger)' : 'var(--color-text-muted)'">
              {{ perf.fantasyPoints }}
            </span>
            <mat-icon class="expand-icon"
                      [class.expand-icon--open]="expanded() === perf._id"
                      style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
              expand_more
            </mat-icon>
          </div>

          <!-- Expanded breakdown -->
          @if (expanded() === perf._id) {
            <div class="breakdown-grid mt-4 pt-4" style="border-top: 1px solid var(--color-border);">
              <!-- Batting -->
              @if (perf.didBat) {
                <div class="breakdown-section">
                  <span class="text-label">Batting</span>
                  <div class="stat-row">
                    <span>{{ perf.runs }} runs ({{ perf.ballsFaced }}b)</span>
                    <span>{{ perf.fours }}x4 {{ perf.sixes }}x6</span>
                  </div>
                  @if (perf.ballsFaced >= 10) {
                    <div class="stat-row">
                      <span>SR {{ strikeRate(perf) }}</span>
                    </div>
                  }
                </div>
              }

              <!-- Bowling -->
              @if (perf.oversBowled > 0) {
                <div class="breakdown-section">
                  <span class="text-label">Bowling</span>
                  <div class="stat-row">
                    <span>{{ perf.wickets }}/{{ perf.runsConceded }} ({{ perf.oversBowled }} ov)</span>
                    <span>Econ {{ economy(perf) }}</span>
                  </div>
                  @if (perf.maidens > 0) {
                    <div class="stat-row">
                      <span>{{ perf.maidens }} maiden{{ perf.maidens > 1 ? 's' : '' }}</span>
                    </div>
                  }
                </div>
              }

              <!-- Fielding -->
              @if (hasFieldingStats(perf)) {
                <div class="breakdown-section">
                  <span class="text-label">Fielding</span>
                  <div class="stat-row">
                    @if (perf.catches > 0) { <span>{{ perf.catches }} catch{{ perf.catches > 1 ? 'es' : '' }}</span> }
                    @if (perf.stumpings > 0) { <span>{{ perf.stumpings }} stumping{{ perf.stumpings > 1 ? 's' : '' }}</span> }
                    @if (perf.runOutDirect > 0) { <span>{{ perf.runOutDirect }} direct RO</span> }
                    @if (perf.runOutIndirect > 0) { <span>{{ perf.runOutIndirect }} indirect RO</span> }
                  </div>
                </div>
              }

              @if (!perf.didBat && perf.oversBowled === 0 && !hasFieldingStats(perf)) {
                <p class="text-xs" style="color: var(--color-text-muted);">Did not bat or bowl.</p>
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

    .breakdown-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .breakdown-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .stat-row {
      display: flex;
      gap: 16px;
      font-size: 13px;
      color: var(--color-text-muted);
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

  strikeRate(p: PlayerPerformance): string {
    if (!p.ballsFaced) return '0.00';
    return ((p.runs / p.ballsFaced) * 100).toFixed(1);
  }

  economy(p: PlayerPerformance): string {
    if (!p.oversBowled) return '0.00';
    return (p.runsConceded / p.oversBowled).toFixed(1);
  }

  hasFieldingStats(p: PlayerPerformance): boolean {
    return (p.catches > 0 || p.stumpings > 0 || p.runOutDirect > 0 || p.runOutIndirect > 0);
  }

  toggleExpand(id: string) {
    this.expanded.set(this.expanded() === id ? null : id);
  }

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
}
