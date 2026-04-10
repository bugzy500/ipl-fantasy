import { Component, inject, signal, resource, computed, OnInit, effect } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { ApiService } from '../../../core/services/api.service';
import { UserBreakdownTeam, UserBreakdownTeamPlayer } from '../../../core/models/api.models';
import { DatePipe } from '@angular/common';
import { breakdownSections, displayPoints, summaryPills } from '../../../features/matches/match-detail/scorecard.utils';

interface MatchSummary {
  bowling: number;
  catchPoints: number;
  runOutPoints: number;
  dotBallPoints: number;
  captainBonus: number;
}

export interface PointBreakdownDialogData {
  userId: string;
  userName: string;
  matchId?: string | null;
}

import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-point-breakdown-dialog',
  standalone: true,
  imports: [MatDialogModule, MatIconModule, MatProgressSpinnerModule, MatExpansionModule, DatePipe],
  template: `
    <div class="flex items-center justify-between px-6 py-4" style="border-bottom: 1px solid var(--color-border);">
      <div>
        <h2 class="text-display font-semibold text-lg" style="color: var(--color-text);">Points Breakdown</h2>
        <p class="text-xs" style="color: var(--color-text-muted);">{{ data.userName }}'s Tally</p>
      </div>
      <button mat-dialog-close class="btn-ghost w-10 h-10 rounded-full flex items-center justify-center" style="color: var(--color-text-subtle);">
        <mat-icon>close</mat-icon>
      </button>
    </div>

    <div class="px-6 py-4 max-h-[70vh] overflow-y-auto">
      @if (breakdowns.isLoading()) {
        <div class="flex justify-center py-12"><mat-spinner diameter="40" /></div>
      } @else if (breakdowns.error()) {
        <p class="text-center py-8" style="color: var(--color-danger);">Failed to load breakdown.</p>
      } @else if ((breakdowns.value() ?? []).length === 0) {
        <div class="text-center py-12">
          <mat-icon style="font-size: 40px; width: 40px; height: 40px; color: var(--color-text-subtle);">scoreboard</mat-icon>
          <p class="mt-3 text-sm" style="color: var(--color-text-muted);">No points recorded yet.</p>
        </div>
      } @else {
        <div class="space-y-4">
          @for (team of filteredBreakdowns(); track team.teamId) {
            <div class="rounded-xl overflow-hidden" style="border: 1px solid var(--color-border); background: var(--color-surface);">
              <!-- Match Header -->
              <div class="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
                   style="background: var(--color-surface-elevated);"
                   (click)="toggleMatch(team.teamId)">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-sm" style="color: var(--color-text);">
                      {{ team.match.team1 }} vs {{ team.match.team2 }}
                    </span>
                    @if (team.match.status === 'live') {
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold status-live">
                        <span class="live-dot w-1.5 h-1.5"></span> LIVE
                      </span>
                    } @else if (team.match.status === 'completed') {
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold status-completed">COMPLETED</span>
                    }
                  </div>
                  <div class="text-xs mt-1" style="color: var(--color-text-muted);">
                    {{ team.match.scheduledAt | date:'mediumDate' }}
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-display font-bold text-lg" style="color: var(--color-accent-hover);">
                    {{ formatPoints(team.totalPoints) }}
                  </span>
                  <mat-icon style="color: var(--color-text-subtle); transition: transform 200ms;"
                            [style.transform]="expandedMatchId() === team.teamId ? 'rotate(180deg)' : 'none'">
                    expand_more
                  </mat-icon>
                </div>
              </div>

              <!-- Expanded Match Players -->
              @if (expandedMatchId() === team.teamId) {
                <div class="px-3 py-3 space-y-2" style="border-top: 1px solid var(--color-border);">
                  <!-- Team Summary Bar -->
                  @let summary = getMatchSummary(team);
                  @if (summary.bowling !== 0 || summary.catchPoints !== 0 || summary.runOutPoints !== 0 || summary.dotBallPoints !== 0 || summary.captainBonus !== 0) {
                    <div class="rounded-xl px-3 py-2.5 mb-1 flex flex-wrap gap-2" style="background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.2);">
                      <span class="text-[10px] font-bold uppercase tracking-wider self-center" style="color: var(--color-text-subtle);">Team:</span>
                      @if (summary.bowling !== 0) {
                        <span class="px-2 py-1 rounded-full text-[11px] font-semibold" style="background: rgba(99,102,241,0.15); color: #a5b4fc;">
                          🎳 Bowl {{ summary.bowling > 0 ? '+' : '' }}{{ summary.bowling }}
                        </span>
                      }
                      @if (summary.captainBonus !== 0) {
                        <span class="px-2 py-1 rounded-full text-[11px] font-semibold" style="background: rgba(245,158,11,0.15); color: #fcd34d;">
                          🧢 C/VC +{{ summary.captainBonus }}
                        </span>
                      }
                      @if (summary.catchPoints !== 0) {
                        <span class="px-2 py-1 rounded-full text-[11px] font-semibold" style="background: rgba(16,185,129,0.15); color: #6ee7b7;">
                          🤲 Catches +{{ summary.catchPoints }}
                        </span>
                      }
                      @if (summary.runOutPoints !== 0) {
                        <span class="px-2 py-1 rounded-full text-[11px] font-semibold" style="background: rgba(236,72,153,0.15); color: #f9a8d4;">
                          🏃 Run-outs +{{ summary.runOutPoints }}
                        </span>
                      }
                      @if (summary.dotBallPoints !== 0) {
                        <span class="px-2 py-1 rounded-full text-[11px] font-semibold" style="background: rgba(100,116,139,0.2); color: #94a3b8;">
                          ⚫ Dot balls +{{ summary.dotBallPoints }}
                        </span>
                      }
                    </div>
                  }
                  @for (p of team.players; track p.player._id) {
                    <div class="rounded-xl px-3 py-3" style="border: 1px solid var(--color-border); background: rgba(255,255,255,0.01);">
                      <!-- Player Row Summary -->
                      <div class="flex items-center gap-3 cursor-pointer" (click)="togglePlayer(team.teamId + '_' + p.player._id)">
                        <img [src]="p.player.imageUrl || 'assets/default-player.svg'" class="w-8 h-8 rounded-full object-cover" />
                        
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2">
                            <span class="text-sm font-medium" style="color: var(--color-text);">{{ p.player.name }}</span>
                            @if (p.isCaptain) {
                              <span class="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold" style="background: var(--color-warning); color: var(--color-base);">C</span>
                            }
                            @if (p.isViceCaptain) {
                              <span class="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold" style="background: rgba(217, 119, 6, 0.7); color: white;">V</span>
                            }
                          </div>
                          <div class="flex flex-wrap gap-1.5 mt-1">
                            @if (!p.performance) {
                              <span class="text-[11px]" style="color: var(--color-text-muted);">No scoring events.</span>
                            } @else {
                              @for (pill of getPills(p.performance); track pill) {
                                <span class="px-2 py-0.5 text-[10px] rounded-full" style="background: var(--color-surface-elevated); border: 1px solid var(--color-border); color: var(--color-text-subtle);">{{ pill }}</span>
                              }
                            }
                          </div>
                        </div>

                        <div class="text-right">
                          <div class="text-display font-semibold text-sm" [style.color]="pointColor(teamContribution(p))">
                            {{ formatPoints(teamContribution(p)) }}
                          </div>
                          @if (p.isCaptain || p.isViceCaptain) {
                            <div class="text-[10px]" style="color: var(--color-text-subtle);">
                              base {{ formatPoints(p.performance?.fantasyPoints || 0) }}
                            </div>
                          }
                        </div>
                        
                        <mat-icon style="color: var(--color-text-subtle); transition: transform 200ms;"
                                  [style.transform]="expandedPlayerId() === (team.teamId + '_' + p.player._id) ? 'rotate(180deg)' : 'none'">
                          expand_more
                        </mat-icon>
                      </div>

                      <!-- Player Breakdown Details -->
                      @if (expandedPlayerId() === (team.teamId + '_' + p.player._id) && p.performance) {
                        <div class="mt-3 pt-3 space-y-3" style="border-top: 1px dashed var(--color-border);">
                          @for (section of getSections(p.performance); track section.key) {
                            <div class="rounded-lg p-3" style="background: var(--color-surface-elevated); border: 1px solid var(--color-border);">
                              <div class="flex justify-between items-center text-xs font-bold uppercase tracking-wider mb-2" style="color: var(--color-text-subtle);">
                                <span>{{ section.label }}</span>
                                <span [style.color]="pointColor(section.subtotal)">{{ formatPoints(section.subtotal) }}</span>
                              </div>
                              <div class="space-y-1.5">
                                @for (item of section.items; track item.label + item.detail) {
                                  <div class="flex justify-between items-center text-xs">
                                    <div>
                                      <div style="color: var(--color-text);">{{ item.label }}</div>
                                      <div style="color: var(--color-text-muted);">{{ item.detail }}</div>
                                    </div>
                                    <div class="font-display font-bold" [style.color]="pointColor(item.points)">
                                      {{ formatPoints(item.points) }}
                                    </div>
                                  </div>
                                }
                              </div>
                            </div>
                          }
                          @if (getSections(p.performance).length === 0) {
                            <p class="text-xs text-center" style="color: var(--color-text-muted);">No scoring events tracked yet.</p>
                          }
                        </div>
                      }
                    </div>
                  }
                  <!-- Prediction Bonus row -->
                  @if (team.predictionBonus > 0 || (team.predictionDetails && team.predictionDetails.length > 0)) {
                    <div class="rounded-xl px-3 py-3 mt-1" style="border: 1px solid var(--color-border); background: rgba(255,255,255,0.02);">
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                          <mat-icon style="font-size: 16px; width: 16px; height: 16px; color: var(--color-accent);">psychology_alt</mat-icon>
                          <span class="text-sm font-medium" style="color: var(--color-text);">Win Prediction Bonus</span>
                        </div>
                        <span class="font-bold text-sm" [style.color]="pointColor(team.predictionBonus)">
                          {{ team.predictionBonus > 0 ? '+' + team.predictionBonus : team.predictionBonus }}
                        </span>
                      </div>
                      @for (pred of team.predictionDetails; track pred.type) {
                        <div class="flex items-center justify-between mt-2 text-xs pl-6">
                          <div style="color: var(--color-text-muted);">
                            {{ pred.type === 'superover' ? 'Super over prediction' : 'Winner prediction' }}
                            — {{ pred.predictedWinner }}
                            @if (pred.isCorrect === true) {
                              <span style="color: var(--color-success);">✓ correct</span>
                            } @else if (pred.isCorrect === false) {
                              <span style="color: var(--color-danger);">✗ wrong</span>
                            } @else {
                              <span style="color: var(--color-text-subtle);">pending</span>
                            }
                          </div>
                          <span [style.color]="pointColor(pred.bonusPoints)">
                            {{ pred.bonusPoints > 0 ? '+' + pred.bonusPoints : pred.bonusPoints || '0' }}
                          </span>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
  `]
})
export class PointBreakdownDialogComponent implements OnInit {
  data = inject<PointBreakdownDialogData>(MAT_DIALOG_DATA);
  api = inject(ApiService);
  dialogRef = inject(MatDialogRef<PointBreakdownDialogComponent>);

  expandedMatchId = signal<string | null>(null);
  expandedPlayerId = signal<string | null>(null);

  get breakdowns() {
    return this._breakdowns;
  }

  filteredBreakdowns() {
    const all = this._breakdowns.value() ?? [];
    if (this.data.matchId) return all.filter((t: any) => String(t.match?._id) === String(this.data.matchId));
    return all.filter((t: any) => t.match?.status === 'completed');
  }
  
  private _breakdowns = resource({
    loader: () => {
      return firstValueFrom(this.api.getUserBreakdown(this.data.userId));
    }
  });

  private _autoExpanded = false;

  constructor() {
    effect(() => {
      const all = this._breakdowns.value();
      if (!all || all.length === 0 || this._autoExpanded) return;
      const res = this.data.matchId
        ? all.filter((t: any) => String(t.match?._id) === String(this.data.matchId))
        : all.filter((t: any) => t.match?.status === 'completed');
      if (res.length > 0) {
        const liveMatch = res.find((r: any) => r.match?.status === 'live');
        this.expandedMatchId.set(liveMatch ? liveMatch.teamId : res[0].teamId);
        this._autoExpanded = true;
      }
    });
  }

  ngOnInit() {
  }

  toggleMatch(teamId: string) {
    this.expandedMatchId.set(this.expandedMatchId() === teamId ? null : teamId);
    this.expandedPlayerId.set(null);
  }

  togglePlayer(uniqueId: string) {
    this.expandedPlayerId.set(this.expandedPlayerId() === uniqueId ? null : uniqueId);
  }

  formatPoints(p: number) {
    return p > 0 ? `+${p}` : `${p}`;
  }

  pointColor(p: number) {
    if (p > 0) return 'var(--color-success)';
    if (p < 0) return 'var(--color-danger)';
    return 'var(--color-text-muted)';
  }

  teamContribution(p: UserBreakdownTeamPlayer): number {
    const base = p.performance?.fantasyPoints || 0;
    if (p.isCaptain) return base * 2;
    if (p.isViceCaptain) return base * 1.5;
    return base;
  }

  getPills(perf: any) {
    return summaryPills(perf);
  }

  getSections(perf: any) {
    return breakdownSections(perf);
  }

  getMatchSummary(team: UserBreakdownTeam): MatchSummary {
    let bowling = 0, catchPoints = 0, runOutPoints = 0, dotBallPoints = 0, captainBonus = 0;
    for (const p of team.players) {
      const perf = p.performance;
      if (!perf) continue;
      const sections = breakdownSections(perf);
      for (const section of sections) {
        if (section.key === 'bowling') {
          bowling += section.subtotal;
          for (const item of section.items) {
            if (item.label === 'Dot balls') dotBallPoints += item.points;
          }
        }
        if (section.key === 'fielding') {
          for (const item of section.items) {
            if (item.label === 'Catches' || item.label === '3-catch bonus' || item.label === 'Stumpings') {
              catchPoints += item.points;
            }
            if (item.label === 'Direct run-outs' || item.label === 'Indirect run-outs') {
              runOutPoints += item.points;
            }
          }
        }
      }
      // Captain/VC multiplier bonus (extra on top of base)
      const base = perf.fantasyPoints || 0;
      if (p.isCaptain) captainBonus += Math.round(base * 10) / 10;       // +1x extra
      if (p.isViceCaptain) captainBonus += Math.round(base * 0.5 * 10) / 10; // +0.5x extra
    }
    return {
      bowling,
      catchPoints,
      runOutPoints,
      dotBallPoints,
      captainBonus: Math.round(captainBonus * 10) / 10,
    };
  }
}
