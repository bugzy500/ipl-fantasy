import { Component, inject, input, signal, computed, effect, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Player, PlayerRole, MatchStatus } from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';

type CaptainRole = 'captain' | 'vice-captain' | null;

const BUDGET = 100;
const TEAM_SIZE = 11;
const ROLE_LIMITS: Record<PlayerRole, [number, number]> = {
  WK: [1, 4], BAT: [3, 6], AR: [1, 4], BOWL: [3, 6],
};

@Component({
  selector: 'app-team-builder',
  standalone: true,
  imports: [
    MatButtonModule, MatIconModule, MatChipsModule,
    MatButtonToggleModule, MatProgressSpinnerModule,
    MatSnackBarModule, MatTooltipModule,
  ],
  template: `
    <div class="p-4 space-y-4">

      <!-- Budget & count bar -->
      <div class="bg-gradient-to-r from-violet-600 to-violet-800 rounded-xl p-4 text-white sticky top-0 z-10 shadow-lg">
        <div class="flex justify-between items-center mb-2">
          <div class="text-center">
            <div class="text-2xl font-bold">{{ selectedPlayers().length }}/{{ TEAM_SIZE }}</div>
            <div class="text-xs opacity-70">Players</div>
          </div>
          <div class="text-center">
            <div class="text-2xl font-bold" [class.text-red-300]="creditsUsed() > BUDGET">
              {{ creditsRemaining().toFixed(1) }}
            </div>
            <div class="text-xs opacity-70">Credits Left</div>
          </div>
          <div class="text-center">
            <div class="text-sm font-medium">{{ captain() ? captainName() : '—' }}</div>
            <div class="text-xs opacity-70">Captain (2x)</div>
          </div>
          <div class="text-center">
            <div class="text-sm font-medium">{{ viceCaptain() ? vcName() : '—' }}</div>
            <div class="text-xs opacity-70">VC (1.5x)</div>
          </div>
        </div>

        <!-- Role count indicators -->
        <div class="flex gap-2 justify-center mt-1">
          @for (r of roleKeys; track r) {
            <div class="text-center px-2">
              <div class="text-sm font-semibold">{{ roleCounts()[r] }}</div>
              <div class="text-xs opacity-60">{{ r }}</div>
            </div>
          }
        </div>

        @if (validationError()) {
          <p class="text-yellow-300 text-xs text-center mt-2">⚠ {{ validationError() }}</p>
        }
      </div>

      <!-- Role filter tabs -->
      <mat-button-toggle-group [(value)]="activeRoleFilter" class="w-full">
        <mat-button-toggle value="ALL" class="flex-1">All</mat-button-toggle>
        @for (r of roleKeys; track r) {
          <mat-button-toggle [value]="r" class="flex-1">{{ r }}</mat-button-toggle>
        }
      </mat-button-toggle-group>

      <!-- Player list -->
      <div class="space-y-2">
        @for (player of filteredPlayers(); track player._id) {
          @let selected = isSelected(player._id);
          @let isCap = captain() === player._id;
          @let isVC = viceCaptain() === player._id;

          <div class="flex items-center gap-3 p-3 rounded-xl border-2 transition-all"
               [class.border-violet-500]="selected"
               [class.bg-violet-50]="selected"
               [class.border-gray-200]="!selected"
               [class.opacity-50]="!selected && selectedPlayers().length >= TEAM_SIZE && !isDeadlinePassed()">

            <!-- Playing status dot -->
            <div class="w-2 h-2 rounded-full flex-shrink-0"
                 [class.bg-green-500]="player.playingStatus === 'playing'"
                 [class.bg-red-500]="player.playingStatus === 'not_playing'"
                 [class.bg-gray-300]="player.playingStatus === 'unknown'"
                 [matTooltip]="player.playingStatus === 'playing' ? 'Playing' : player.playingStatus === 'not_playing' ? 'Not Playing' : 'XI not announced'">
            </div>

            <!-- Player info -->
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm truncate">{{ player.name }}</div>
              <div class="text-xs text-gray-500">{{ player.franchise }} · {{ player.role }}</div>
            </div>

            <!-- Credits -->
            <div class="text-sm font-medium text-violet-600 w-10 text-center">
              {{ player.credits }}
            </div>

            <!-- C/VC buttons (only when player is selected) -->
            @if (selected && !isDeadlinePassed()) {
              <button mat-mini-fab [color]="isCap ? 'accent' : ''"
                      class="w-7 h-7 text-xs font-bold"
                      (click)="setCaptain(player._id, $event)"
                      matTooltip="Set as Captain">C</button>
              <button mat-mini-fab [color]="isVC ? 'accent' : ''"
                      class="w-7 h-7 text-xs font-bold"
                      (click)="setViceCaptain(player._id, $event)"
                      matTooltip="Set as Vice-Captain">V</button>
            }

            <!-- Add/Remove button -->
            <button mat-icon-button
                    [disabled]="isDeadlinePassed() || (!selected && selectedPlayers().length >= TEAM_SIZE)"
                    (click)="togglePlayer(player)">
              <mat-icon [class.text-violet-600]="selected">
                {{ selected ? 'remove_circle' : 'add_circle_outline' }}
              </mat-icon>
            </button>
          </div>
        }
      </div>

      <!-- Submit button -->
      <div class="sticky bottom-4 pt-2">
        <button mat-flat-button color="primary" class="w-full h-14 text-base font-bold"
                [disabled]="!canSubmit() || submitting() || isDeadlinePassed()"
                (click)="submitTeam()">
          @if (submitting()) {
            <mat-spinner diameter="24" class="inline-block mr-2" />
          }
          @if (isDeadlinePassed()) {
            🔒 Deadline Passed
          } @else {
            {{ existingTeam() ? 'Update Team' : 'Submit Team' }}
          }
        </button>
        @if (!canSubmit() && !isDeadlinePassed()) {
          <p class="text-center text-xs text-gray-500 mt-1">{{ validationError() || 'Select 11 players with a Captain and Vice-Captain' }}</p>
        }
      </div>
    </div>
  `,
})
export class TeamBuilderComponent implements OnInit {
  readonly matchId = input.required<string>();
  readonly players = input.required<Player[]>();
  readonly deadline = input.required<string>();
  readonly matchStatus = input.required<MatchStatus>();

  private readonly api = inject(ApiService);
  private readonly snackBar = inject(MatSnackBar);

  readonly TEAM_SIZE = TEAM_SIZE;
  readonly BUDGET = BUDGET;
  readonly roleKeys: PlayerRole[] = ['WK', 'BAT', 'AR', 'BOWL'];

  readonly activeRoleFilter = signal<PlayerRole | 'ALL'>('ALL');
  readonly selectedPlayers = signal<string[]>([]);
  readonly captain = signal<string | null>(null);
  readonly viceCaptain = signal<string | null>(null);
  readonly existingTeam = signal<boolean>(false);
  readonly submitting = signal(false);

  readonly isDeadlinePassed = computed(() => new Date(this.deadline()) <= new Date());

  readonly filteredPlayers = computed(() => {
    const filter = this.activeRoleFilter();
    const list = filter === 'ALL' ? this.players() : this.players().filter((p) => p.role === filter);
    return [...list].sort((a, b) => b.credits - a.credits);
  });

  readonly creditsUsed = computed(() => {
    const selected = this.selectedPlayers();
    return this.players()
      .filter((p) => selected.includes(p._id))
      .reduce((sum, p) => sum + p.credits, 0);
  });

  readonly creditsRemaining = computed(() => BUDGET - this.creditsUsed());

  readonly roleCounts = computed<Record<PlayerRole, number>>(() => {
    const counts: Record<PlayerRole, number> = { WK: 0, BAT: 0, AR: 0, BOWL: 0 };
    const selected = this.selectedPlayers();
    this.players()
      .filter((p) => selected.includes(p._id))
      .forEach((p) => counts[p.role]++);
    return counts;
  });

  readonly franchiseCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    const selected = this.selectedPlayers();
    this.players()
      .filter((p) => selected.includes(p._id))
      .forEach((p) => { counts[p.franchise] = (counts[p.franchise] ?? 0) + 1; });
    return counts;
  });

  readonly validationError = computed<string>(() => {
    const sel = this.selectedPlayers();
    if (sel.length < TEAM_SIZE) return `Select ${TEAM_SIZE - sel.length} more player(s)`;
    if (this.creditsUsed() > BUDGET) return `Over budget by ${(this.creditsUsed() - BUDGET).toFixed(1)} credits`;

    const rc = this.roleCounts();
    if (rc.WK < 1 || rc.WK > 4) return 'Need 1–4 Wicket-Keepers';
    const batTotal = rc.WK + rc.BAT; // WK counts as a batsman
    if (batTotal < 3 || batTotal > 6) return 'Need 3–6 Batters (WK included)';
    if (rc.AR < 1 || rc.AR > 4) return 'Need 1–4 All-Rounders';
    if (rc.BOWL < 3 || rc.BOWL > 6) return 'Need 3–6 Bowlers';

    const maxFranchise = Math.max(...Object.values(this.franchiseCounts()));
    if (maxFranchise > 7) return 'Max 7 players from one franchise';

    if (!this.captain()) return 'Pick a Captain';
    if (!this.viceCaptain()) return 'Pick a Vice-Captain';

    return '';
  });

  readonly canSubmit = computed(() => this.validationError() === '' && !this.isDeadlinePassed());

  readonly captainName = computed(() =>
    this.players().find((p) => p._id === this.captain())?.name ?? ''
  );
  readonly vcName = computed(() =>
    this.players().find((p) => p._id === this.viceCaptain())?.name ?? ''
  );

  ngOnInit() {
    // Load existing team if user already submitted one
    this.api.getMyTeam(this.matchId()).subscribe({
      next: (team) => {
        this.existingTeam.set(true);
        this.selectedPlayers.set(team.players.map((p: any) => p._id ?? p));
        this.captain.set(typeof team.captain === 'string' ? team.captain : (team.captain as any)._id);
        this.viceCaptain.set(typeof team.viceCaptain === 'string' ? team.viceCaptain : (team.viceCaptain as any)._id);
      },
      error: () => {}, // 404 = no team yet, that's fine
    });
  }

  isSelected(playerId: string) {
    return this.selectedPlayers().includes(playerId);
  }

  togglePlayer(player: Player) {
    if (this.isDeadlinePassed()) return;

    const current = this.selectedPlayers();
    if (current.includes(player._id)) {
      // Remove player and clear C/VC if needed
      this.selectedPlayers.set(current.filter((id) => id !== player._id));
      if (this.captain() === player._id) this.captain.set(null);
      if (this.viceCaptain() === player._id) this.viceCaptain.set(null);
    } else {
      // Add player — check credits + franchise limit
      const newTotal = this.creditsUsed() + player.credits;
      if (newTotal > BUDGET) {
        this.snackBar.open(`Not enough credits (need ${player.credits}, have ${this.creditsRemaining().toFixed(1)})`, 'OK', { duration: 2500 });
        return;
      }
      const franchiseCount = this.franchiseCounts()[player.franchise] ?? 0;
      if (franchiseCount >= 7) {
        this.snackBar.open(`Max 7 players from ${player.franchise}`, 'OK', { duration: 2500 });
        return;
      }
      if (current.length < TEAM_SIZE) {
        this.selectedPlayers.set([...current, player._id]);
      }
    }
  }

  setCaptain(playerId: string, event: Event) {
    event.stopPropagation();
    if (this.viceCaptain() === playerId) this.viceCaptain.set(null);
    this.captain.set(this.captain() === playerId ? null : playerId);
  }

  setViceCaptain(playerId: string, event: Event) {
    event.stopPropagation();
    if (this.captain() === playerId) this.captain.set(null);
    this.viceCaptain.set(this.viceCaptain() === playerId ? null : playerId);
  }

  submitTeam() {
    if (!this.canSubmit()) return;
    this.submitting.set(true);

    this.api.upsertTeam({
      matchId: this.matchId(),
      players: this.selectedPlayers(),
      captain: this.captain()!,
      viceCaptain: this.viceCaptain()!,
    }).subscribe({
      next: () => {
        this.existingTeam.set(true);
        this.snackBar.open('✅ Team saved successfully!', 'OK', { duration: 3000 });
        this.submitting.set(false);
      },
      error: (err) => {
        this.snackBar.open(err.error?.message ?? 'Failed to save team', 'OK', { duration: 3000 });
        this.submitting.set(false);
      },
    });
  }
}
