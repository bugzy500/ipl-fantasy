import { Component, inject, input, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { interval, Subscription, startWith, switchMap } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { AuthService } from '../../../core/services/auth.service';
import { LeaderboardEntry, MatchStatus } from '../../../core/models/api.models';

const POLL_INTERVAL_MS = 30_000;

@Component({
  selector: 'app-leaderboard-tab',
  standalone: true,
  imports: [MatProgressSpinnerModule, MatIconModule],
  template: `
    <div class="p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-display font-semibold" style="color: var(--color-text);">
          Match Leaderboard
        </h3>
        @if (isLive()) {
          <span class="inline-flex items-center gap-1.5 status-live">
            <span class="live-dot"></span>
            updates every 30s
          </span>
        }
      </div>

      @if (loading()) {
        <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
      }
      @if (error()) {
        <p class="text-center" style="color: var(--color-danger);">{{ error() }}</p>
      }

      @for (entry of leaderboard(); track entry.userId; let i = $index) {
        <div class="flex items-center gap-3 p-4 rounded-xl transition-all stagger-item fade-up"
             [style.background]="entry.userId === myUserId() ? 'var(--color-accent-muted)' : 'var(--color-surface)'"
             [style.border]="entry.userId === myUserId() ? '1px solid var(--color-accent)' : '1px solid var(--color-border)'">
          <span class="w-8 text-center text-display font-bold text-lg"
                [style.color]="rankColor(i)">
            {{ i + 1 }}
          </span>
          <mat-icon style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
            person
          </mat-icon>
          <span class="flex-1 font-medium text-sm" style="color: var(--color-text);">
            {{ entry.userName }}
            @if (entry.userId === myUserId()) {
              <span class="text-xs ml-1" style="color: var(--color-accent);">(You)</span>
            }
          </span>
          <span class="text-display font-bold text-lg" style="color: var(--color-accent-hover);">
            {{ entry.totalPoints }}
          </span>
        </div>
      }

      @if (leaderboard().length === 0 && !loading()) {
        <div class="text-center py-12 card-surface">
          <p style="color: var(--color-text-muted);">No teams submitted for this match yet.</p>
        </div>
      }
    </div>
  `,
})
export class LeaderboardTabComponent implements OnInit, OnDestroy {
  readonly matchId = input.required<string>();
  readonly matchStatus = input.required<MatchStatus>();

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly leaderboard = signal<LeaderboardEntry[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly isLive = computed(() => this.matchStatus() === 'live');
  readonly myUserId = computed(() => this.auth.currentUser()?.id ?? '');

  private subscription?: Subscription;

  rankColor(index: number): string {
    if (index === 0) return '#F59E0B';
    if (index === 1) return '#94A3B8';
    if (index === 2) return '#D97706';
    return 'var(--color-text-muted)';
  }

  ngOnInit() {
    const source$ = this.isLive()
      ? interval(POLL_INTERVAL_MS).pipe(startWith(0), switchMap(() => this.api.getMatchLeaderboard(this.matchId())))
      : this.api.getMatchLeaderboard(this.matchId());

    this.subscription = source$.subscribe({
      next: (data) => {
        this.leaderboard.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'Failed to load leaderboard');
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }
}
