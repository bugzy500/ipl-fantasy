import { Component, inject, input, signal, computed, OnInit } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatExpansionModule } from '@angular/material/expansion';
import { ApiService } from '../../../core/services/api.service';
import { AuthService } from '../../../core/services/auth.service';
import { FantasyTeam, Player } from '../../../core/models/api.models';

@Component({
  selector: 'app-all-teams-tab',
  standalone: true,
  imports: [MatProgressSpinnerModule, MatIconModule, MatChipsModule, MatExpansionModule],
  template: `
    <div class="p-4 space-y-4">
      <h3 class="font-semibold text-gray-700">All Teams</h3>

      @if (!deadlinePassed()) {
        <div class="text-center py-12 text-gray-400">
          <mat-icon class="text-5xl">lock</mat-icon>
          <p class="mt-2">Teams will be visible after the deadline passes.</p>
        </div>
      } @else {
        @if (loading()) {
          <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
        }
        @if (error()) {
          <p class="text-red-500 text-center">{{ error() }}</p>
        }

        @for (team of teams(); track team._id) {
          <mat-expansion-panel [expanded]="isMyTeam(team)">
            <mat-expansion-panel-header>
              <mat-panel-title class="font-medium flex items-center gap-2">
                <mat-icon class="text-gray-400 text-sm">person</mat-icon>
                {{ getOwnerName(team) }}
                @if (isMyTeam(team)) {
                  <mat-chip class="text-xs">You</mat-chip>
                }
              </mat-panel-title>
              <mat-panel-description class="font-bold text-violet-700">
                {{ team.totalPoints }} pts
              </mat-panel-description>
            </mat-expansion-panel-header>

            <div class="space-y-2 py-2">
              @for (player of asPlayers(team.players); track player._id) {
                <div class="flex items-center gap-3 px-2 py-1 rounded-lg"
                     [class.bg-yellow-50]="isCaptain(team, player)"
                     [class.bg-orange-50]="isVC(team, player)">
                  <div class="w-2 h-2 rounded-full flex-shrink-0"
                       [class.bg-blue-500]="player.role === 'BAT'"
                       [class.bg-green-500]="player.role === 'AR'"
                       [class.bg-red-500]="player.role === 'BOWL'"
                       [class.bg-yellow-500]="player.role === 'WK'">
                  </div>
                  <span class="flex-1 text-sm font-medium">{{ player.name }}</span>
                  <span class="text-xs text-gray-500">{{ player.franchise }} · {{ player.role }}</span>
                  @if (isCaptain(team, player)) {
                    <mat-chip class="text-xs bg-yellow-200">C</mat-chip>
                  }
                  @if (isVC(team, player)) {
                    <mat-chip class="text-xs bg-orange-200">VC</mat-chip>
                  }
                </div>
              }
            </div>
          </mat-expansion-panel>
        }

        @if (teams().length === 0 && !loading()) {
          <p class="text-center text-gray-400 py-8">No teams submitted for this match.</p>
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
