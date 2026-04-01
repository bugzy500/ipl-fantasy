import { Component, inject, computed, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { MatchCardComponent } from '../../shared/components/match-card/match-card.component';
import { Match, LeaderboardEntry } from '../../core/models/api.models';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    RouterLink,
    MatButtonModule, MatIconModule, MatProgressSpinnerModule,
    MatchCardComponent,
  ],
  template: `
    <div class="space-y-8 fade-up">
      <!-- Welcome header -->
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">
            Welcome, {{ auth.currentUser()?.name }}
          </h1>
          <p class="text-sm mt-1" style="color: var(--color-text-muted);">
            IPL 2026 Fantasy League
          </p>
        </div>
        @if (auth.isAdmin()) {
          <a routerLink="/admin" class="btn-outline text-sm px-4 py-2">
            Admin Panel
          </a>
        }
      </div>

      <!-- Stats row -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="card-surface text-center">
          <div class="text-display text-2xl font-bold" style="color: var(--color-accent-hover);">
            {{ myRank() }}
          </div>
          <div class="text-label mt-2">Season Rank</div>
        </div>
        <div class="card-surface text-center">
          <div class="text-display text-2xl font-bold" style="color: var(--color-warning);">
            {{ myPoints() }}
          </div>
          <div class="text-label mt-2">Total Points</div>
        </div>
        <div class="card-surface text-center">
          <div class="text-display text-2xl font-bold" style="color: var(--color-success);">
            {{ upcomingCount() }}
          </div>
          <div class="text-label mt-2">Upcoming</div>
        </div>
        <div class="card-surface text-center">
          <div class="text-display text-2xl font-bold" style="color: var(--color-text);">
            {{ leaderboard.value()?.length ?? 0 }}
          </div>
          <div class="text-label mt-2">Players</div>
        </div>
      </div>

      <!-- Live matches -->
      @if (liveMatches().length > 0) {
        <div>
          <div class="flex items-center gap-2 mb-4">
            <span class="live-dot"></span>
            <h2 class="text-display text-lg font-semibold" style="color: var(--color-danger);">
              Live Now
            </h2>
          </div>
          <div class="grid md:grid-cols-2 gap-4">
            @for (match of liveMatches(); track match._id) {
              <app-match-card [match]="match" class="stagger-item fade-up" />
            }
          </div>
        </div>
      }

      <!-- Upcoming matches -->
      <div>
        <h2 class="text-display text-lg font-semibold mb-4" style="color: var(--color-text);">
          Upcoming Matches
        </h2>
        @if (matches.isLoading()) {
          <div class="flex justify-center p-8">
            <mat-spinner diameter="40" />
          </div>
        }
        @if (matches.error()) {
          <p class="text-center py-4" style="color: var(--color-danger);">Failed to load matches</p>
        }
        @if (upcomingMatches().length === 0 && !matches.isLoading()) {
          <div class="card-surface text-center py-12">
            <mat-icon class="text-4xl mb-2" style="color: var(--color-text-subtle); font-size: 48px; width: 48px; height: 48px;">
              sports_cricket
            </mat-icon>
            <p style="color: var(--color-text-muted);">No upcoming matches scheduled yet.</p>
          </div>
        }
        <div class="grid md:grid-cols-2 gap-4">
          @for (match of upcomingMatches(); track match._id) {
            <app-match-card [match]="match" class="stagger-item fade-up" />
          }
        </div>
      </div>

      <!-- Mini leaderboard -->
      <div>
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-display text-lg font-semibold" style="color: var(--color-text);">
            Season Leaderboard
          </h2>
          <a routerLink="/leaderboard" class="btn-ghost text-sm px-3 py-2"
             style="color: var(--color-accent-hover);">
            View Full
          </a>
        </div>
        @if (leaderboard.isLoading()) {
          <div class="flex justify-center p-4"><mat-spinner diameter="32" /></div>
        }
        <div class="card-surface p-0 overflow-hidden" style="border: 1px solid var(--color-border);">
          @for (entry of topLeaderboard(); track entry.userId; let i = $index) {
            <div class="flex items-center gap-3 px-5 py-3.5 stagger-item fade-up"
                 [style.border-bottom]="i < topLeaderboard().length - 1 ? '1px solid var(--color-border)' : 'none'"
                 [style.background]="entry.userId === auth.currentUser()?.id ? 'var(--color-accent-muted)' : 'transparent'">
              <span class="w-7 text-center text-display font-bold text-sm"
                    [style.color]="rankColor(i)">
                {{ i + 1 }}
              </span>
              <mat-icon style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                person
              </mat-icon>
              <span class="flex-1 font-medium text-sm" style="color: var(--color-text);">
                {{ entry.userName }}
                @if (entry.userId === auth.currentUser()?.id) {
                  <span class="text-xs ml-1" style="color: var(--color-accent);">(You)</span>
                }
              </span>
              <span class="text-display font-bold text-sm" style="color: var(--color-accent-hover);">
                {{ entry.totalPoints }} pts
              </span>
            </div>
          }
          @if (topLeaderboard().length === 0 && !leaderboard.isLoading()) {
            <div class="text-center py-8">
              <p style="color: var(--color-text-muted);">No matches played yet.</p>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class DashboardComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly matches = resource({
    loader: () => firstValueFrom(this.api.getMatches()),
  });

  readonly leaderboard = resource({
    loader: () => firstValueFrom(this.api.getSeasonLeaderboard()),
  });

  readonly liveMatches = computed<Match[]>(() =>
    (this.matches.value() ?? []).filter((m) => m.status === 'live')
  );

  readonly upcomingMatches = computed<Match[]>(() => {
    const now = new Date().toISOString();
    return (this.matches.value() ?? [])
      .filter((m) => (m.status === 'upcoming' || m.status === 'toss_done') && m.deadline > now)
      .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
      .slice(0, 4);
  });

  readonly upcomingCount = computed(() => this.upcomingMatches().length);

  readonly topLeaderboard = computed<LeaderboardEntry[]>(() =>
    (this.leaderboard.value() ?? []).slice(0, 5)
  );

  readonly myRank = computed(() => {
    const entries = this.leaderboard.value() ?? [];
    const myId = this.auth.currentUser()?.id;
    const idx = entries.findIndex((e) => e.userId === myId);
    return idx === -1 ? '--' : `#${idx + 1}`;
  });

  readonly myPoints = computed(() => {
    const entries = this.leaderboard.value() ?? [];
    const myId = this.auth.currentUser()?.id;
    return entries.find((e) => e.userId === myId)?.totalPoints ?? 0;
  });

  rankColor(index: number): string {
    if (index === 0) return '#F59E0B';
    if (index === 1) return '#94A3B8';
    if (index === 2) return '#D97706';
    return 'var(--color-text-muted)';
  }
}
