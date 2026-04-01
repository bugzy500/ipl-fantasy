import { Component, inject, signal, computed, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
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
    MatCardModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule,
    MatchCardComponent,
  ],
  template: `
    <div class="space-y-6">
      <!-- Welcome header -->
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">
            Welcome, {{ auth.currentUser()?.name }}! 🏏
          </h1>
          <p class="text-gray-500 text-sm mt-1">IPL 2026 Fantasy League</p>
        </div>
        @if (auth.isAdmin()) {
          <a mat-flat-button color="accent" routerLink="/admin">
            <mat-icon>admin_panel_settings</mat-icon> Admin Panel
          </a>
        }
      </div>

      <!-- Stats row -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <mat-card appearance="outlined" class="text-center p-4">
          <div class="text-3xl font-bold text-violet-600">{{ myRank() }}</div>
          <div class="text-sm text-gray-500 mt-1">Season Rank</div>
        </mat-card>
        <mat-card appearance="outlined" class="text-center p-4">
          <div class="text-3xl font-bold text-orange-600">{{ myPoints() }}</div>
          <div class="text-sm text-gray-500 mt-1">Total Points</div>
        </mat-card>
        <mat-card appearance="outlined" class="text-center p-4">
          <div class="text-3xl font-bold text-green-600">{{ upcomingCount() }}</div>
          <div class="text-sm text-gray-500 mt-1">Upcoming Matches</div>
        </mat-card>
        <mat-card appearance="outlined" class="text-center p-4">
          <div class="text-3xl font-bold text-blue-600">{{ leaderboard.value()?.length ?? 0 }}</div>
          <div class="text-sm text-gray-500 mt-1">Players in League</div>
        </mat-card>
      </div>

      <!-- Upcoming matches -->
      <div>
        <h2 class="text-lg font-semibold text-gray-700 mb-3">Upcoming Matches</h2>
        @if (matches.isLoading()) {
          <div class="flex justify-center p-8"><mat-spinner diameter="48" /></div>
        }
        @if (matches.error()) {
          <p class="text-red-500 text-center">Failed to load matches</p>
        }
        @if (upcomingMatches().length === 0 && !matches.isLoading()) {
          <p class="text-gray-400 text-center py-8">No upcoming matches scheduled yet.</p>
        }
        <div class="grid md:grid-cols-2 gap-4">
          @for (match of upcomingMatches(); track match._id) {
            <app-match-card [match]="match" />
          }
        </div>
      </div>

      <!-- Mini leaderboard -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-700">Season Leaderboard</h2>
          <a mat-button color="primary" routerLink="/leaderboard">View Full</a>
        </div>
        @if (leaderboard.isLoading()) {
          <div class="flex justify-center p-4"><mat-spinner diameter="32" /></div>
        }
        <mat-card appearance="outlined">
          <mat-card-content class="p-0">
            @for (entry of topLeaderboard(); track entry.userId; let i = $index) {
              <div class="flex items-center gap-3 px-4 py-3 border-b last:border-0"
                   [class.bg-violet-50]="entry.userId === auth.currentUser()?.id">
                <span class="w-6 text-center font-bold"
                      [class.text-yellow-500]="i === 0"
                      [class.text-gray-400]="i === 1"
                      [class.text-orange-600]="i === 2">
                  {{ i + 1 }}
                </span>
                <mat-icon class="text-gray-400">person</mat-icon>
                <span class="flex-1 font-medium">{{ entry.userName }}</span>
                <span class="font-bold text-violet-700">{{ entry.totalPoints }} pts</span>
              </div>
            }
            @if (topLeaderboard().length === 0 && !leaderboard.isLoading()) {
              <p class="text-gray-400 text-center py-6">No matches played yet.</p>
            }
          </mat-card-content>
        </mat-card>
      </div>
    </div>
  `,
})
export class DashboardComponent {
  readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  // resource() — Angular 19+ API for async data with loading/error states
  readonly matches = resource({
    loader: () => firstValueFrom(this.api.getMatches()),
  });

  readonly leaderboard = resource({
    loader: () => firstValueFrom(this.api.getSeasonLeaderboard()),
  });

  readonly upcomingMatches = computed<Match[]>(() => {
    const now = new Date().toISOString();
    const all = this.matches.value() ?? [];
    return all
      .filter((m) => (m.status === 'upcoming' || m.status === 'toss_done') && m.deadline > now)
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
    return idx === -1 ? '—' : `#${idx + 1}`;
  });

  readonly myPoints = computed(() => {
    const entries = this.leaderboard.value() ?? [];
    const myId = this.auth.currentUser()?.id;
    return entries.find((e) => e.userId === myId)?.totalPoints ?? 0;
  });
}
