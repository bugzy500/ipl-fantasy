import { Component, inject, input, signal, resource, effect } from '@angular/core';
import { Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, FormArray, FormGroup } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { ApiService } from '../../../core/services/api.service';
import { Player, MatchSquadResponse } from '../../../core/models/api.models';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-admin-scores',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatCheckboxModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatExpansionModule,
  ],
  template: `
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <button mat-icon-button (click)="router.navigate(['/admin/matches'])">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h1 class="text-2xl font-bold text-gray-800">Enter Match Scores</h1>
      </div>

      @if (squad.isLoading()) {
        <div class="flex justify-center p-12"><mat-spinner diameter="56" /></div>
      }

      @if (squad.value()) {
        <div class="bg-violet-50 rounded-xl p-4 text-sm text-violet-700">
          <strong>{{ squad.value()!.match.team1 }} vs {{ squad.value()!.match.team2 }}</strong>
          — Enter stats for all players who participated. Leave blank for those who didn't play.
        </div>

        <form [formGroup]="scoresForm" (ngSubmit)="submitScores()">
          <div class="space-y-3" formArrayName="performances">
            @for (player of squad.value()!.players; track player._id; let i = $index) {
              <mat-expansion-panel>
                <mat-expansion-panel-header>
                  <mat-panel-title class="font-medium">
                    {{ player.name }}
                    <span class="text-xs text-gray-400 ml-2">{{ player.franchise }} · {{ player.role }}</span>
                  </mat-panel-title>
                </mat-expansion-panel-header>

                <div [formGroupName]="i" class="grid grid-cols-2 md:grid-cols-4 gap-3 py-3">
                  <!-- Batting -->
                  <div class="col-span-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Batting</div>
                  <mat-form-field appearance="outline">
                    <mat-label>Runs</mat-label>
                    <input matInput type="number" formControlName="runs" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Balls Faced</mat-label>
                    <input matInput type="number" formControlName="ballsFaced" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Fours</mat-label>
                    <input matInput type="number" formControlName="fours" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Sixes</mat-label>
                    <input matInput type="number" formControlName="sixes" min="0" />
                  </mat-form-field>
                  <div class="flex items-center gap-4 col-span-2">
                    <mat-checkbox formControlName="didBat">Did Bat?</mat-checkbox>
                    <mat-checkbox formControlName="isDismissed">Got Out?</mat-checkbox>
                  </div>

                  <!-- Bowling -->
                  <div class="col-span-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mt-2">Bowling</div>
                  <mat-form-field appearance="outline">
                    <mat-label>Overs</mat-label>
                    <input matInput type="number" formControlName="oversBowled" min="0" step="0.1" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Runs Given</mat-label>
                    <input matInput type="number" formControlName="runsConceded" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Wickets</mat-label>
                    <input matInput type="number" formControlName="wickets" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Maidens</mat-label>
                    <input matInput type="number" formControlName="maidens" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="col-span-2">
                    <mat-label>LBW/Bowled Wickets</mat-label>
                    <input matInput type="number" formControlName="lbwBowledWickets" min="0" />
                    <mat-hint>Wickets that were LBW or Bowled (bonus +8 each)</mat-hint>
                  </mat-form-field>
                  <mat-form-field appearance="outline" class="col-span-2">
                    <mat-label>Dot Balls</mat-label>
                    <input matInput type="number" formControlName="dotBalls" min="0" />
                    <mat-hint>Balls bowled where no runs scored (+2 pts each)</mat-hint>
                  </mat-form-field>

                  <!-- Fielding -->
                  <div class="col-span-4 text-xs font-semibold text-gray-500 uppercase tracking-wider mt-2">Fielding</div>
                  <mat-form-field appearance="outline">
                    <mat-label>Catches</mat-label>
                    <input matInput type="number" formControlName="catches" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Stumpings</mat-label>
                    <input matInput type="number" formControlName="stumpings" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Direct Run-outs</mat-label>
                    <input matInput type="number" formControlName="runOutDirect" min="0" />
                  </mat-form-field>
                  <mat-form-field appearance="outline">
                    <mat-label>Indirect Run-outs</mat-label>
                    <input matInput type="number" formControlName="runOutIndirect" min="0" />
                    <mat-hint>Non-direct throw or catch</mat-hint>
                  </mat-form-field>
                </div>
              </mat-expansion-panel>
            }
          </div>

          <div class="mt-6">
            <button mat-flat-button color="primary" type="submit"
                    [disabled]="submitting()" class="w-full h-14 text-base font-bold">
              @if (submitting()) {
                <mat-spinner diameter="24" class="inline-block mr-2" />
              }
              Submit All Scores & Calculate Points
            </button>
            <p class="text-center text-sm text-gray-500 mt-2">
              This marks the match as completed and updates all fantasy team totals.
            </p>
          </div>
        </form>
      }
    </div>
  `,
})
export class AdminScoresComponent {
  readonly matchId = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly fb = inject(FormBuilder);
  private readonly snackBar = inject(MatSnackBar);
  readonly router = inject(Router);

  readonly submitting = signal(false);

  readonly squad = resource({
    loader: (): Promise<MatchSquadResponse> => firstValueFrom(this.api.getMatchSquad(this.matchId())),
  });

  readonly scoresForm = this.fb.group({
    performances: this.fb.array([]),
  });

  constructor() {
    // When squad loads, build a form row for each player
    effect(() => {
      const data = this.squad.value();
      if (!data) return;
      const arr = this.scoresForm.get('performances') as FormArray;
      arr.clear();
      data.players.forEach((p: Player) => arr.push(this.buildPlayerFormGroup(p._id)));
    });
  }

  private buildPlayerFormGroup(playerId: string): FormGroup {
    return this.fb.group({
      playerId: [playerId],
      runs: [0], ballsFaced: [0], fours: [0], sixes: [0],
      didBat: [false], isDismissed: [false],
      oversBowled: [0], runsConceded: [0], wickets: [0],
      maidens: [0], lbwBowledWickets: [0], dotBalls: [0],
      catches: [0], stumpings: [0], runOutDirect: [0], runOutIndirect: [0],
    });
  }

  submitScores() {
    this.submitting.set(true);
    const perfs = (this.scoresForm.value.performances ?? []) as any[];

    this.api.submitScores(this.matchId(), perfs).subscribe({
      next: () => {
        this.snackBar.open('✅ Scores submitted! Fantasy points calculated.', 'OK', { duration: 3000 });
        this.router.navigate(['/admin/matches']);
      },
      error: (err) => {
        this.snackBar.open(err.error?.message ?? 'Submission failed', 'OK', { duration: 3000 });
        this.submitting.set(false);
      },
    });
  }
}
