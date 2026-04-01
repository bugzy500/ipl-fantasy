import { Component, inject, signal, computed, resource, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService } from '../../../core/services/api.service';
import { AuthService } from '../../../core/services/auth.service';
import { Player, PlayerRole, MatchSquadResponse, FantasyTeam } from '../../../core/models/api.models';
import { firstValueFrom } from 'rxjs';
import { TeamBuilderComponent } from './team-builder.component';
import { LeaderboardTabComponent } from './leaderboard-tab.component';
import { AllTeamsTabComponent } from './all-teams-tab.component';

@Component({
  selector: 'app-match-detail',
  standalone: true,
  imports: [
    RouterLink,
    MatTabsModule, MatProgressSpinnerModule, MatButtonModule,
    MatIconModule, MatSnackBarModule,
    TeamBuilderComponent, LeaderboardTabComponent, AllTeamsTabComponent,
  ],
  template: `
    @if (squadData.isLoading()) {
      <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
    }
    @if (squadData.error()) {
      <div class="text-center py-12">
        <p style="color: var(--color-danger);">Failed to load match.</p>
        <a routerLink="/matches" class="btn-ghost mt-4 inline-block">Back to Matches</a>
      </div>
    }
    @if (squadData.value(); as data) {
      <div class="space-y-6 fade-up">
        <!-- Match header -->
        <div class="card-elevated p-6 rounded-xl" style="border: 1px solid var(--color-border);">
          <div class="flex justify-between items-center text-sm mb-4">
            <span style="color: var(--color-text-muted);">{{ formattedDate() }}</span>
            <span [class]="statusBadgeClass()"
                  class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider">
              @if (data.match.status === 'live') {
                <span class="live-dot"></span>
              }
              {{ data.match.status }}
            </span>
          </div>

          <div class="flex items-center justify-between text-center py-2">
            <div class="flex-1">
              <div class="text-display text-3xl md:text-4xl font-bold" style="color: var(--color-accent-hover);">
                {{ data.match.team1 }}
              </div>
            </div>
            <div class="px-4">
              <span class="text-sm font-medium" style="color: var(--color-text-subtle);">VS</span>
            </div>
            <div class="flex-1">
              <div class="text-display text-3xl md:text-4xl font-bold" style="color: var(--color-warning);">
                {{ data.match.team2 }}
              </div>
            </div>
          </div>

          <!-- Deadline bar -->
          <div class="mt-4 flex items-center justify-center gap-2 text-sm py-2 rounded-lg"
               [style]="deadlineBarStyle()">
            <mat-icon style="font-size: 16px; width: 16px; height: 16px;">
              {{ deadlinePassed() ? 'lock' : 'schedule' }}
            </mat-icon>
            <span>Deadline: {{ formattedDeadline() }}</span>
            @if (!deadlinePassed()) {
              <span class="font-semibold ml-1">{{ countdown() }}</span>
            }
          </div>
        </div>

        <!-- Tabs -->
        <mat-tab-group animationDuration="200ms">
          <mat-tab label="Build Team">
            @defer (on immediate) {
              <app-team-builder
                [matchId]="id()"
                [players]="data.players"
                [deadline]="data.match.deadline"
                [matchStatus]="data.match.status"
              />
            } @placeholder {
              <div class="flex justify-center p-8"><mat-spinner /></div>
            }
          </mat-tab>

          <mat-tab label="All Teams">
            @defer (on viewport) {
              <app-all-teams-tab [matchId]="id()" [deadline]="data.match.deadline" />
            } @placeholder {
              <div class="flex justify-center p-8"><mat-spinner /></div>
            }
          </mat-tab>

          <mat-tab label="Leaderboard">
            @defer (on viewport) {
              <app-leaderboard-tab [matchId]="id()" [matchStatus]="data.match.status" />
            } @placeholder {
              <div class="flex justify-center p-8"><mat-spinner /></div>
            }
          </mat-tab>
        </mat-tab-group>
      </div>
    }
  `,
})
export class MatchDetailComponent {
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);

  readonly squadData = resource({
    loader: (): Promise<MatchSquadResponse> => firstValueFrom(this.api.getMatchSquad(this.id())),
  });

  readonly formattedDate = computed(() => {
    const d = this.squadData.value();
    if (!d) return '';
    return new Date(d.match.deadline).toLocaleString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    });
  });

  readonly formattedDeadline = computed(() => {
    const d = this.squadData.value();
    if (!d) return '';
    return new Date(d.match.deadline).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }) + ' IST';
  });

  readonly deadlinePassed = computed(() => {
    const d = this.squadData.value();
    if (!d) return false;
    return new Date(d.match.deadline) <= new Date();
  });

  private readonly _countdownTick = signal(Date.now());
  private _timer = setInterval(() => this._countdownTick.set(Date.now()), 1000);

  readonly countdown = computed(() => {
    this._countdownTick();
    const d = this.squadData.value();
    if (!d) return '';
    const ms = new Date(d.match.deadline).getTime() - Date.now();
    if (ms <= 0) return 'Deadline passed';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${s}s left` : `${s}s left`;
  });

  readonly deadlineBarStyle = computed(() => {
    const d = this.squadData.value();
    if (!d) return '';
    const ms = new Date(d.match.deadline).getTime() - Date.now();
    if (ms <= 0) return 'background: rgba(232, 83, 74, 0.1); color: var(--color-danger);';
    if (ms < 30 * 60 * 1000) return 'background: rgba(232, 83, 74, 0.1); color: var(--color-danger); font-weight: 600;';
    if (ms < 2 * 60 * 60 * 1000) return 'background: rgba(245, 158, 11, 0.1); color: var(--color-warning);';
    return 'background: rgba(34, 197, 94, 0.08); color: var(--color-success);';
  });

  readonly statusBadgeClass = computed(() => {
    const status = this.squadData.value()?.match.status;
    if (status === 'live') return 'status-live';
    if (status === 'completed') return 'status-completed';
    if (status === 'toss_done') return 'status-upcoming';
    return 'status-upcoming';
  });

  ngOnDestroy() {
    clearInterval(this._timer);
  }
}
