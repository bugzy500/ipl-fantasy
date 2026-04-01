import { Component, inject, signal, computed, resource, input, effect } from '@angular/core';
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
  // Route param is bound as input via withComponentInputBinding()
  template: `
    @if (squadData.isLoading()) {
      <div class="flex justify-center p-12"><mat-spinner diameter="56" /></div>
    }
    @if (squadData.error()) {
      <div class="text-center py-12">
        <p class="text-red-500">Failed to load match.</p>
        <a mat-button routerLink="/matches">Back to Matches</a>
      </div>
    }
    @if (squadData.value(); as data) {
      <div class="space-y-4">
        <!-- Match header -->
        <div class="bg-gradient-to-r from-violet-700 to-orange-600 rounded-2xl p-6 text-white">
          <div class="flex justify-between items-center text-sm opacity-80 mb-3">
            <span>{{ formattedDate() }}</span>
            <span class="font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full text-xs"
                  [class]="statusBadgeClass()">
              {{ data.match.status }}
            </span>
          </div>
          <div class="flex items-center justify-between text-center">
            <div class="flex-1">
              <div class="text-4xl font-black">{{ data.match.team1 }}</div>
            </div>
            <div class="text-2xl font-light opacity-60">VS</div>
            <div class="flex-1">
              <div class="text-4xl font-black">{{ data.match.team2 }}</div>
            </div>
          </div>
          <p class="text-center text-sm opacity-70 mt-3">
            🔒 Deadline: {{ formattedDeadline() }}
            @if (!deadlinePassed()) {
              <span class="ml-2 text-yellow-300">({{ countdown() }})</span>
            }
          </p>
        </div>

        <!-- Tabs -->
        <mat-tab-group animationDuration="200ms" class="rounded-xl overflow-hidden">
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
  // Route param injected as signal via withComponentInputBinding()
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

  // Live countdown updated every second
  private readonly _countdownTick = signal(Date.now());
  private _timer = setInterval(() => this._countdownTick.set(Date.now()), 1000);

  readonly countdown = computed(() => {
    this._countdownTick(); // reactive dependency
    const d = this.squadData.value();
    if (!d) return '';
    const ms = new Date(d.match.deadline).getTime() - Date.now();
    if (ms <= 0) return 'Deadline passed';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${s}s left` : `${s}s left`;
  });

  readonly statusBadgeClass = computed(() => {
    const status = this.squadData.value()?.match.status;
    if (status === 'live') return 'bg-red-500';
    if (status === 'completed') return 'bg-green-500';
    if (status === 'toss_done') return 'bg-yellow-500';
    return 'bg-white/20';
  });

  ngOnDestroy() {
    clearInterval(this._timer);
  }
}
