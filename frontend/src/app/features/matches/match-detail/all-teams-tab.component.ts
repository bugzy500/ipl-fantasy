import { Component, inject, input, signal, computed, OnInit } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { ApiService } from '../../../core/services/api.service';
import { AuthService } from '../../../core/services/auth.service';
import { FantasyTeam, Player } from '../../../core/models/api.models';

@Component({
  selector: 'app-all-teams-tab',
  standalone: true,
  imports: [MatProgressSpinnerModule, MatIconModule, MatExpansionModule],
  template: `
    <div class="p-4 space-y-4">
      <h3 class="text-display font-semibold" style="color: var(--color-text);">All Teams</h3>

      @if (!deadlinePassed()) {
        <div class="text-center py-12 card-surface">
          <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">
            lock
          </mat-icon>
          <p class="mt-3" style="color: var(--color-text-muted);">
            Teams will be visible after the deadline passes.
          </p>
        </div>
      } @else {
        @if (loading()) {
          <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
        }
        @if (error()) {
          <p class="text-center" style="color: var(--color-danger);">{{ error() }}</p>
        }

        @for (team of teams(); track team._id) {
          <mat-expansion-panel [expanded]="isMyTeam(team)" class="stagger-item fade-up">
            <mat-expansion-panel-header>
              <mat-panel-title>
                <div class="flex items-center gap-2 font-medium text-sm"
                     style="color: var(--color-text);">
                  <mat-icon style="font-size: 18px; width: 18px; height: 18px; color: var(--color-text-subtle);">
                    person
                  </mat-icon>
                  {{ getOwnerName(team) }}
                  @if (isMyTeam(team)) {
                    <span class="text-xs px-2 py-0.5 rounded-full"
                          style="background: var(--color-accent-muted); color: var(--color-accent);">
                      You
                    </span>
                  }
                </div>
              </mat-panel-title>
              <mat-panel-description>
                <span class="text-display font-bold" style="color: var(--color-accent-hover);">
                  {{ team.totalPoints }} pts
                </span>
              </mat-panel-description>
            </mat-expansion-panel-header>

            <div class="space-y-1.5 py-2">
              @for (player of asPlayers(team.players); track player._id) {
                @let isCap = isCaptain(team, player);
                @let isVc = isVC(team, player);
                <div class="flex items-center gap-3 px-3 py-2 rounded-lg"
                     [style.background]="isCap ? 'rgba(245, 158, 11, 0.1)' : isVc ? 'rgba(217, 119, 6, 0.06)' : 'transparent'">
                  <div class="w-2 h-2 rounded-full flex-shrink-0"
                       [style.background]="roleColor(player.role)">
                  </div>
                  <img [src]="player.imageUrl || 'assets/default-player.svg'"
                       class="w-6 h-6 rounded-full object-cover flex-shrink-0"
                       [alt]="player.name"
                       (error)="$any($event.target).src='assets/default-player.svg'" />
                  <span class="flex-1 text-sm font-medium" style="color: var(--color-text);">
                    {{ player.name }}
                  </span>
                  <span class="text-xs" style="color: var(--color-text-muted);">
                    {{ player.franchise }} · {{ player.role }}
                  </span>
                  @if (isCap) {
                    <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
                          style="background: var(--color-warning); color: var(--color-base);">C</span>
                  }
                  @if (isVc) {
                    <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
                          style="background: rgba(217, 119, 6, 0.7); color: white;">V</span>
                  }
                </div>
              }
            </div>
          </mat-expansion-panel>
        }

        @if (teams().length === 0 && !loading()) {
          <div class="text-center py-12 card-surface">
            <p style="color: var(--color-text-muted);">No teams submitted for this match.</p>
          </div>
        }
      }
    </div>
  `,
})
export class AllTeamsTabComponent implements OnInit {
  readonly matchId = input.required<string>();
  readonly deadline = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly teams = signal<FantasyTeam[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  readonly deadlinePassed = computed(() => new Date(this.deadline()) <= new Date());

  roleColor(role: string): string {
    const colors: Record<string, string> = {
      BAT: '#7C3AED',
      AR: '#22C55E',
      BOWL: '#E8534A',
      WK: '#F59E0B',
    };
    return colors[role] ?? 'var(--color-text-subtle)';
  }

  ngOnInit() {
    if (!this.deadlinePassed()) return;

    this.loading.set(true);
    this.api.getAllTeams(this.matchId()).subscribe({
      next: (data) => {
        this.teams.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'Failed to load teams');
        this.loading.set(false);
      },
    });
  }

  getOwnerName(team: FantasyTeam): string {
    if (typeof team.userId === 'string') return team.userId;
    return team.userId.name;
  }

  isMyTeam(team: FantasyTeam): boolean {
    const id = typeof team.userId === 'string' ? team.userId : team.userId.id;
    return id === this.auth.currentUser()?.id;
  }

  isCaptain(team: FantasyTeam, player: Player): boolean {
    const capId = typeof team.captain === 'string' ? team.captain : (team.captain as Player)._id;
    return capId === player._id;
  }

  isVC(team: FantasyTeam, player: Player): boolean {
    const vcId = typeof team.viceCaptain === 'string' ? team.viceCaptain : (team.viceCaptain as Player)._id;
    return vcId === player._id;
  }

  asPlayers(players: Player[]): Player[] {
    return players;
  }
}
