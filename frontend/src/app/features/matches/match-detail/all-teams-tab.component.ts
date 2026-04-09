import { Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subscription, forkJoin, interval, of, startWith, switchMap } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { AuthService } from '../../../core/services/auth.service';
import { FantasyTeam, MatchStatus, Player, PlayerPerformance, ScoreBreakdownSection, Prediction } from '../../../core/models/api.models';
import {
  breakdownReasoning,
  breakdownSections,
  displayPoints,
  storedPointsMismatch as hasStoredPointsMismatch,
  summaryPills,
} from './scorecard.utils';

const LIVE_POLL_INTERVAL_MS = 30_000;

interface OwnershipStats {
  ownedCount: number;
  captainCount: number;
  viceCaptainCount: number;
  owners: string[];
}

interface TeamDiffPlayer {
  player: Player;
  basePoints: number;
  teamContribution: number;
  multiplierLabel: string;
  ownership: OwnershipStats;
  reasoning: string;
  summary: string[];
}

interface CaptaincySwingPlayer {
  player: Player;
  basePoints: number;
  teamAContribution: number;
  teamBContribution: number;
  teamALabel: string;
  teamBLabel: string;
  swing: number;
}

interface TeamComparison {
  teamA: FantasyTeam;
  teamB: FantasyTeam;
  rankA: number | null;
  rankB: number | null;
  gap: number;
  sharedCount: number;
  onlyA: TeamDiffPlayer[];
  onlyB: TeamDiffPlayer[];
  captaincySwings: CaptaincySwingPlayer[];
}

@Component({
  selector: 'app-all-teams-tab',
  standalone: true,
  imports: [MatExpansionModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    <div class="p-4 space-y-4">
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h3 class="text-display font-semibold" style="color: var(--color-text);">All Teams</h3>
          @if (isLive()) {
            <span class="inline-flex items-center gap-1.5 status-live">
              <span class="live-dot"></span>
              compare refreshes every 30s
            </span>
          }
        </div>
        @if (hasScoreContext()) {
          <p class="text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
            This tab now shows the actual player score math inside each team, plus live team-vs-team differentials.
            The comparison engine is honest: it uses current totals and exact scorecards, not fake probability theatre.
          </p>
        } @else {
          <p class="text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
            Teams are visible after the deadline. Score reasoning and compare math appear once the match goes live.
          </p>
        }
      </div>

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

        @if (teams().length >= 2 && !loading()) {
          <section class="compare-panel">
            <div class="space-y-2">
              <h4 class="text-sm font-semibold" style="color: var(--color-text);">Team Compare</h4>
              <p class="text-xs" style="color: var(--color-text-muted); line-height: 1.6;">
                Pick any two teams. “Freeze now” ranks are based on current live totals. That is useful.
                Pretending we know exact future probabilities without a real model would be nonsense.
              </p>
            </div>

            <div class="compare-select-grid">
              <label class="compare-select-block">
                <span class="compare-label">Team A</span>
                <select class="compare-select"
                        [value]="compareTeamAId() ?? ''"
                        (change)="setCompareTeam('A', $any($event.target).value)">
                  @for (team of teams(); track team._id) {
                    <option [value]="team._id">{{ compareOptionLabel(team) }}</option>
                  }
                </select>
              </label>

              <label class="compare-select-block">
                <span class="compare-label">Team B</span>
                <select class="compare-select"
                        [value]="compareTeamBId() ?? ''"
                        (change)="setCompareTeam('B', $any($event.target).value)">
                  @for (team of teams(); track team._id) {
                    <option [value]="team._id">{{ compareOptionLabel(team) }}</option>
                  }
                </select>
              </label>
            </div>

            @if (comparison(); as cmp) {
              <div class="compare-headline">
                @if (cmp.gap > 0) {
                  <strong>{{ getOwnerName(cmp.teamA) }}</strong> leads <strong>{{ getOwnerName(cmp.teamB) }}</strong>
                  by <strong>{{ formatPoints(cmp.gap) }} pts</strong> right now.
                } @else if (cmp.gap < 0) {
                  <strong>{{ getOwnerName(cmp.teamB) }}</strong> leads <strong>{{ getOwnerName(cmp.teamA) }}</strong>
                  by <strong>{{ formatPoints(-cmp.gap) }} pts</strong> right now.
                } @else {
                  Both teams are tied right now.
                }
                Freeze now and they finish <strong>#{{ cmp.rankA ?? '—' }}</strong> and <strong>#{{ cmp.rankB ?? '—' }}</strong>.
              </div>

              <div class="compare-summary-grid">
                <div class="compare-stat-card">
                  <span class="compare-label">Team A now</span>
                  <strong>{{ getOwnerName(cmp.teamA) }}</strong>
                  <div class="compare-stat-row">
                    <span>{{ cmp.teamA.totalPoints }} pts</span>
                    <span>#{{ cmp.rankA ?? '—' }}</span>
                  </div>
                </div>

                <div class="compare-stat-card">
                  <span class="compare-label">Team B now</span>
                  <strong>{{ getOwnerName(cmp.teamB) }}</strong>
                  <div class="compare-stat-row">
                    <span>{{ cmp.teamB.totalPoints }} pts</span>
                    <span>#{{ cmp.rankB ?? '—' }}</span>
                  </div>
                </div>

                <div class="compare-stat-card">
                  <span class="compare-label">Shared core</span>
                  <strong>{{ cmp.sharedCount }} players</strong>
                  <div class="compare-stat-row">
                    <span>Only A: {{ cmp.onlyA.length }}</span>
                    <span>Only B: {{ cmp.onlyB.length }}</span>
                  </div>
                </div>

                <div class="compare-stat-card">
                  <span class="compare-label">Captaincy swings</span>
                  <strong>{{ cmp.captaincySwings.length }} players</strong>
                  <div class="compare-stat-row">
                    <span>same player</span>
                    <span>different multiplier</span>
                  </div>
                </div>
              </div>

              @if (cmp.captaincySwings.length > 0) {
                <div class="diff-group">
                  <div class="diff-group__header">
                    <h5>Shared Players, Different Captaincy</h5>
                    <span>These are the shared picks changing the swing.</span>
                  </div>

                  <div class="space-y-2">
                    @for (item of cmp.captaincySwings; track item.player._id) {
                      <div class="diff-card">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-medium text-sm" style="color: var(--color-text);">{{ item.player.name }}</span>
                            <span class="mini-meta">{{ item.player.franchise }} · {{ item.player.role }}</span>
                            <span class="mini-meta">base {{ formatPoints(item.basePoints) }}</span>
                          </div>
                          <div class="text-xs mt-1" style="color: var(--color-text-muted); line-height: 1.6;">
                            {{ getOwnerName(cmp.teamA) }}: {{ item.teamALabel }} = {{ formatPoints(item.teamAContribution) }} team pts
                            ·
                            {{ getOwnerName(cmp.teamB) }}: {{ item.teamBLabel }} = {{ formatPoints(item.teamBContribution) }} team pts
                          </div>
                        </div>

                        <div class="text-right">
                          <div class="font-bold text-sm" [style.color]="pointColor(item.swing)">
                            {{ formatPoints(item.swing) }}
                          </div>
                          <div class="text-xs" style="color: var(--color-text-muted);">
                            {{ getOwnerName(cmp.teamA) }} swing
                          </div>
                        </div>
                      </div>
                    }
                  </div>
                </div>
              }

              <div class="compare-columns">
                <div class="diff-group">
                  <div class="diff-group__header">
                    <h5>Only {{ getOwnerName(cmp.teamA) }}</h5>
                    <span>Unique players pushing Team A.</span>
                  </div>

                  @if (cmp.onlyA.length === 0) {
                    <div class="empty-diff">No unique players. This side is entirely shared.</div>
                  } @else {
                    <div class="space-y-2">
                      @for (item of cmp.onlyA; track item.player._id) {
                        <div class="diff-card">
                          <div class="min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="font-medium text-sm" style="color: var(--color-text);">{{ item.player.name }}</span>
                              <span class="mini-meta">{{ item.player.franchise }} · {{ item.player.role }}</span>
                              <span class="mini-meta">{{ item.multiplierLabel }}</span>
                            </div>
                            <div class="text-xs mt-1" style="color: var(--color-text-muted); line-height: 1.6;">
                              {{ item.reasoning }}
                            </div>
                            <div class="flex flex-wrap gap-1.5 mt-2">
                              @for (pill of item.summary; track pill) {
                                <span class="summary-pill">{{ pill }}</span>
                              }
                            </div>
                          </div>

                          <div class="text-right">
                            <div class="font-bold text-sm" [style.color]="pointColor(item.teamContribution)">
                              {{ formatPoints(item.teamContribution) }}
                            </div>
                            <div class="text-xs" style="color: var(--color-text-muted);">
                              base {{ formatPoints(item.basePoints) }}
                            </div>
                            <div class="text-[11px] mt-1" style="color: var(--color-text-subtle);">
                              {{ item.ownership.ownedCount }}/{{ teams().length }} teams
                            </div>
                          </div>
                        </div>
                      }
                    </div>
                  }
                </div>

                <div class="diff-group">
                  <div class="diff-group__header">
                    <h5>Only {{ getOwnerName(cmp.teamB) }}</h5>
                    <span>Unique players pushing Team B.</span>
                  </div>

                  @if (cmp.onlyB.length === 0) {
                    <div class="empty-diff">No unique players. This side is entirely shared.</div>
                  } @else {
                    <div class="space-y-2">
                      @for (item of cmp.onlyB; track item.player._id) {
                        <div class="diff-card">
                          <div class="min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="font-medium text-sm" style="color: var(--color-text);">{{ item.player.name }}</span>
                              <span class="mini-meta">{{ item.player.franchise }} · {{ item.player.role }}</span>
                              <span class="mini-meta">{{ item.multiplierLabel }}</span>
                            </div>
                            <div class="text-xs mt-1" style="color: var(--color-text-muted); line-height: 1.6;">
                              {{ item.reasoning }}
                            </div>
                            <div class="flex flex-wrap gap-1.5 mt-2">
                              @for (pill of item.summary; track pill) {
                                <span class="summary-pill">{{ pill }}</span>
                              }
                            </div>
                          </div>

                          <div class="text-right">
                            <div class="font-bold text-sm" [style.color]="pointColor(item.teamContribution)">
                              {{ formatPoints(item.teamContribution) }}
                            </div>
                            <div class="text-xs" style="color: var(--color-text-muted);">
                              base {{ formatPoints(item.basePoints) }}
                            </div>
                            <div class="text-[11px] mt-1" style="color: var(--color-text-subtle);">
                              {{ item.ownership.ownedCount }}/{{ teams().length }} teams
                            </div>
                          </div>
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            } @else {
              <div class="empty-diff">Pick two different teams to compare.</div>
            }
          </section>
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
                  @if (isAutoTeam(team)) {
                    <span class="text-xs px-1.5 py-0.5 rounded"
                          style="background: rgba(139, 92, 246, 0.15); color: rgb(167, 139, 250);">
                      auto
                    </span>
                  }
                  @if (rankForTeam(team)) {
                    <span class="mini-rank-badge">#{{ rankForTeam(team) }}</span>
                  }
                </div>
                @let prediction = getPredictionForTeam(team);
                @if (prediction) {
                  <div class="text-xs mt-1" style="color: var(--color-text-muted);">
                    Predicted: {{ prediction.predictedWinner }}
                    @if (prediction.isCorrect !== null) {
                      <span class="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium"
                            [style]="prediction.isCorrect ? 'background: rgba(34, 197, 94, 0.15); color: var(--color-success);' : 'background: rgba(232, 83, 74, 0.15); color: var(--color-danger);'">
                        {{ prediction.isCorrect ? '✓' : '✗' }}
                      </span>
                    }
                  </div>
                }
              </mat-panel-title>
              <mat-panel-description>
                <span class="text-display font-bold" style="color: var(--color-accent-hover);">
                  {{ team.totalPoints }} pts
                </span>
              </mat-panel-description>
            </mat-expansion-panel-header>

            <div class="space-y-2 py-2">
              @for (player of asPlayers(team.players); track player._id) {
                @let isCap = isCaptain(team, player);
                @let isVc = isVC(team, player);
                @let perf = getPlayerPerformance(player._id);
                @let ownership = ownershipForPlayer(player._id);
                <div class="rounded-xl border"
                     style="border-color: var(--color-border); background: rgba(255, 255, 255, 0.01);">
                  <button type="button"
                          class="w-full text-left flex items-center gap-3 px-3 py-3 rounded-xl"
                          [style.background]="isCap ? 'rgba(245, 158, 11, 0.1)' : isVc ? 'rgba(217, 119, 6, 0.06)' : 'transparent'"
                          (click)="togglePlayerDetails(team._id, player._id)">
                    <div class="w-2 h-2 rounded-full flex-shrink-0"
                         [style.background]="roleColor(player.role)">
                    </div>

                    <img [src]="player.imageUrl || 'assets/default-player.svg'"
                         class="w-6 h-6 rounded-full object-cover flex-shrink-0"
                         [alt]="player.name"
                         (error)="$any($event.target).src='assets/default-player.svg'" />

                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium truncate" style="color: var(--color-text);">
                          {{ player.name }}
                        </span>
                        <span class="mini-meta">{{ player.franchise }} · {{ player.role }}</span>
                        @if (isCap) {
                          <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
                                style="background: var(--color-warning); color: var(--color-base);">C</span>
                        }
                        @if (isVc) {
                          <span class="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
                                style="background: rgba(217, 119, 6, 0.7); color: white;">V</span>
                        }
                      </div>

                      <div class="text-xs mt-1" style="color: var(--color-text-muted);">
                        {{ ownershipLine(ownership) }}
                      </div>
                    </div>

                    <div class="text-right">
                      @if (hasScoreContext()) {
                        <div class="text-display font-semibold text-xs"
                             [style.color]="pointColor(teamContribution(team, player._id))">
                          {{ formatPoints(teamContribution(team, player._id)) }} team pts
                        </div>
                        <div class="text-[11px]" style="color: var(--color-text-subtle);">
                          base {{ formatPoints(getPlayerPoints(player._id)) }}
                        </div>
                      } @else {
                        <div class="text-xs" style="color: var(--color-text-muted);">
                          {{ multiplierLabel(team, player._id) }}
                        </div>
                      }
                    </div>

                    <mat-icon class="expand-icon"
                              [class.expand-icon--open]="isPlayerExpanded(team._id, player._id)"
                              style="color: var(--color-text-subtle); font-size: 18px; width: 18px; height: 18px;">
                      expand_more
                    </mat-icon>
                  </button>

                  @if (isPlayerExpanded(team._id, player._id)) {
                    <div class="px-3 pb-3 space-y-3">
                      <div class="detail-callout">
                        <div class="text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
                          {{ playerReasoning(player._id) }}
                        </div>
                        <div class="text-xs mt-2" style="color: var(--color-text-subtle); line-height: 1.7;">
                          This team gets <strong>{{ formatPoints(teamContribution(team, player._id)) }} pts</strong>
                          because this pick is <strong>{{ multiplierLabel(team, player._id) }}</strong>
                          on a base score of <strong>{{ formatPoints(getPlayerPoints(player._id)) }} pts</strong>.
                        </div>
                      </div>

                      <div class="flex flex-wrap gap-1.5">
                        @for (pill of playerSummary(player._id); track pill) {
                          <span class="summary-pill">{{ pill }}</span>
                        }
                      </div>

                      @for (section of playerSections(player._id); track section.key) {
                        <div class="breakdown-section">
                          <div class="flex items-center justify-between gap-3">
                            <span class="text-label">{{ section.label }}</span>
                            <span class="section-total" [style.color]="pointColor(section.subtotal)">
                              {{ formatPoints(section.subtotal) }}
                            </span>
                          </div>
                          <div class="space-y-2">
                            @for (item of section.items; track item.label + item.detail) {
                              <div class="breakdown-item">
                                <div class="min-w-0">
                                  <div class="text-sm font-medium truncate" style="color: var(--color-text);">
                                    {{ item.label }}
                                  </div>
                                  <div class="text-xs" style="color: var(--color-text-muted);">
                                    {{ item.detail }}
                                  </div>
                                </div>
                                <span class="points-chip" [style]="pointsChipStyle(item.points)">
                                  {{ formatPoints(item.points) }}
                                </span>
                              </div>
                            }
                          </div>
                        </div>
                      }

                      @if (perf && storedPointsMismatch(perf)) {
                        <div class="text-xs px-3 py-2 rounded-lg"
                             style="color: var(--color-warning); background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2);">
                          Breakdown uses the corrected rules total of {{ formatPoints(getPlayerPoints(player._id)) }} pts.
                          Stored live points were {{ perf.storedFantasyPoints }} pts.
                        </div>
                      }

                      @if (!perf || playerSections(player._id).length === 0) {
                        <div class="text-xs px-3 py-2 rounded-lg"
                             style="color: var(--color-text-muted); background: rgba(148, 163, 184, 0.08); border: 1px solid rgba(148, 163, 184, 0.16);">
                          No batting, bowling, or fielding events recorded yet for this player.
                        </div>
                      }
                    </div>
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
  styles: [`
    .compare-panel {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      border-radius: var(--radius-lg);
      background: linear-gradient(180deg, rgba(99, 102, 241, 0.06), rgba(15, 23, 42, 0.06));
      border: 1px solid var(--color-border);
    }
    .compare-select-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .compare-select-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .compare-select {
      width: 100%;
      min-height: 42px;
      border-radius: 12px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      color: var(--color-text);
      font-size: 13px;
      padding: 0 12px;
      outline: none;
    }
    .compare-select:focus {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
    }
    .compare-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-text-subtle);
    }
    .compare-headline {
      border-radius: 12px;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      color: var(--color-text-muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .compare-headline strong {
      color: var(--color-text);
    }
    .compare-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .compare-stat-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 14px;
      border-radius: 14px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
    }
    .compare-stat-card strong {
      font-size: 16px;
      color: var(--color-text);
      font-family: var(--font-display);
    }
    .compare-stat-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      color: var(--color-text-muted);
    }
    .compare-columns {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .diff-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .diff-group__header h5 {
      margin: 0;
      color: var(--color-text);
      font-size: 13px;
      font-weight: 700;
    }
    .diff-group__header span {
      color: var(--color-text-muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .diff-card {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
    }
    .mini-meta {
      font-size: 11px;
      color: var(--color-text-subtle);
      background: rgba(148, 163, 184, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .mini-rank-badge {
      font-size: 11px;
      font-weight: 700;
      color: var(--color-accent-hover);
      background: var(--color-accent-muted);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .empty-diff {
      padding: 14px;
      border-radius: 12px;
      background: rgba(148, 163, 184, 0.06);
      border: 1px solid rgba(148, 163, 184, 0.16);
      color: var(--color-text-muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .expand-icon {
      transition: transform 200ms var(--ease-out);
    }
    .expand-icon--open {
      transform: rotate(180deg);
    }
    .summary-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--color-text-subtle);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 999px;
      padding: 3px 8px;
    }
    .detail-callout {
      border-radius: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .breakdown-section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-elevated);
    }
    .text-label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--color-text-subtle);
    }
    .section-total {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 14px;
    }
    .breakdown-item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .points-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--font-display);
      white-space: nowrap;
    }
    @media (max-width: 960px) {
      .compare-summary-grid,
      .compare-columns,
      .compare-select-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class AllTeamsTabComponent implements OnInit, OnDestroy {
  readonly matchId = input.required<string>();
  readonly deadline = input.required<string>();
  readonly matchStatus = input.required<MatchStatus>();

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly teams = signal<FantasyTeam[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly playerPerformances = signal<Map<string, PlayerPerformance>>(new Map());
  readonly predictions = signal<Prediction[]>([]);
  readonly expandedPlayerKey = signal<string | null>(null);
  readonly compareTeamAId = signal<string | null>(null);
  readonly compareTeamBId = signal<string | null>(null);

  readonly deadlinePassed = computed(() => new Date(this.deadline()) <= new Date());
  readonly hasScoreContext = computed(() => this.matchStatus() === 'completed' || this.matchStatus() === 'live');
  readonly isLive = computed(() => this.matchStatus() === 'live');
  readonly ownershipByPlayer = computed(() => {
    const map = new Map<string, OwnershipStats>();

    for (const team of this.teams()) {
      const owner = this.getOwnerName(team);
      for (const player of team.players) {
        const stats = map.get(player._id) ?? {
          ownedCount: 0,
          captainCount: 0,
          viceCaptainCount: 0,
          owners: [],
        };

        stats.ownedCount += 1;
        stats.owners.push(owner);
        if (this.isCaptain(team, player)) stats.captainCount += 1;
        if (this.isVC(team, player)) stats.viceCaptainCount += 1;
        map.set(player._id, stats);
      }
    }

    return map;
  });
  readonly predictionsByUserId = computed(() => {
    const map = new Map<string, Prediction>();
    for (const prediction of this.predictions()) {
      const userId = typeof prediction.userId === 'string' ? prediction.userId : prediction.userId.id;
      map.set(userId, prediction);
    }
    return map;
  });
  readonly rankByTeamId = computed(() => {
    const sorted = [...this.teams()].sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return this.getOwnerName(a).localeCompare(this.getOwnerName(b));
    });

    return new Map(sorted.map((team, index) => [team._id, index + 1]));
  });
  readonly compareTeamA = computed(() => this.findTeamById(this.compareTeamAId()));
  readonly compareTeamB = computed(() => this.findTeamById(this.compareTeamBId()));
  readonly comparison = computed<TeamComparison | null>(() => {
    const teamA = this.compareTeamA();
    const teamB = this.compareTeamB();
    if (!teamA || !teamB || teamA._id === teamB._id) return null;

    const teamBPlayers = new Map(teamB.players.map((player) => [player._id, player]));
    const teamAPlayers = new Map(teamA.players.map((player) => [player._id, player]));

    const onlyA = teamA.players
      .filter((player) => !teamBPlayers.has(player._id))
      .map((player) => this.buildTeamDiffPlayer(teamA, player))
      .sort((a, b) => Math.abs(b.teamContribution) - Math.abs(a.teamContribution));

    const onlyB = teamB.players
      .filter((player) => !teamAPlayers.has(player._id))
      .map((player) => this.buildTeamDiffPlayer(teamB, player))
      .sort((a, b) => Math.abs(b.teamContribution) - Math.abs(a.teamContribution));

    const sharedPlayers = teamA.players.filter((player) => teamBPlayers.has(player._id));
    const captaincySwings = sharedPlayers
      .filter((player) => this.multiplier(teamA, player._id) !== this.multiplier(teamB, player._id))
      .map((player) => {
        const basePoints = this.getPlayerPoints(player._id);
        const teamAContribution = this.teamContribution(teamA, player._id);
        const teamBContribution = this.teamContribution(teamB, player._id);
        return {
          player,
          basePoints,
          teamAContribution,
          teamBContribution,
          teamALabel: this.multiplierLabel(teamA, player._id),
          teamBLabel: this.multiplierLabel(teamB, player._id),
          swing: this.roundPoints(teamAContribution - teamBContribution),
        };
      })
      .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));

    return {
      teamA,
      teamB,
      rankA: this.rankForTeam(teamA),
      rankB: this.rankForTeam(teamB),
      gap: this.roundPoints(teamA.totalPoints - teamB.totalPoints),
      sharedCount: sharedPlayers.length,
      onlyA,
      onlyB,
      captaincySwings,
    };
  });

  private subscription?: Subscription;

  ngOnInit() {
    if (!this.deadlinePassed()) return;

    this.loading.set(true);
    const source$ = this.isLive()
      ? interval(LIVE_POLL_INTERVAL_MS).pipe(startWith(0), switchMap(() => this.loadTabData()))
      : this.loadTabData();

    this.subscription = source$.subscribe({
      next: ({ teams, scores, predictions }) => {
        this.teams.set(teams);
        this.playerPerformances.set(new Map(scores.map((perf) => [perf.playerId._id, perf])));
        this.predictions.set(predictions);
        this.ensureCompareDefaults(teams);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'Failed to load teams');
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }

  roleColor(role: string): string {
    const colors: Record<string, string> = {
      BAT: '#7C3AED',
      AR: '#22C55E',
      BOWL: '#E8534A',
      WK: '#F59E0B',
    };
    return colors[role] ?? 'var(--color-text-subtle)';
  }

  getOwnerName(team: FantasyTeam): string {
    if (typeof team.userId === 'string') return team.userId;
    return team.userId.name;
  }

  compareOptionLabel(team: FantasyTeam): string {
    const rank = this.rankForTeam(team);
    const prefix = rank ? `#${rank} ` : '';
    return `${prefix}${this.getOwnerName(team)} · ${team.totalPoints} pts`;
  }

  isMyTeam(team: FantasyTeam): boolean {
    const id = typeof team.userId === 'string' ? team.userId : team.userId.id;
    return id === this.auth.currentUser()?.id;
  }

  isAutoTeam(team: FantasyTeam): boolean {
    return !!(team as any).isAutoGenerated;
  }

  getPredictionForTeam(team: FantasyTeam): Prediction | null {
    const userId = typeof team.userId === 'string' ? team.userId : team.userId.id;
    return this.predictionsByUserId().get(userId) ?? null;
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

  getPlayerPerformance(playerId: string): PlayerPerformance | null {
    return this.playerPerformances().get(playerId) ?? null;
  }

  getPlayerPoints(playerId: string): number {
    const perf = this.getPlayerPerformance(playerId);
    return perf ? displayPoints(perf) : 0;
  }

  playerSummary(playerId: string): string[] {
    const perf = this.getPlayerPerformance(playerId);
    return perf ? summaryPills(perf) : ['No scoring events yet'];
  }

  playerSections(playerId: string): ScoreBreakdownSection[] {
    const perf = this.getPlayerPerformance(playerId);
    return perf ? breakdownSections(perf) : [];
  }

  playerReasoning(playerId: string): string {
    const perf = this.getPlayerPerformance(playerId);
    return perf ? breakdownReasoning(perf) : 'No batting, bowling, or fielding events have been recorded for this player yet.';
  }

  storedPointsMismatch(perf: PlayerPerformance): boolean {
    return hasStoredPointsMismatch(perf);
  }

  ownershipForPlayer(playerId: string): OwnershipStats {
    return this.ownershipByPlayer().get(playerId) ?? {
      ownedCount: 0,
      captainCount: 0,
      viceCaptainCount: 0,
      owners: [],
    };
  }

  ownershipLine(ownership: OwnershipStats): string {
    return `Owned by ${ownership.ownedCount}/${this.teams().length} teams · C ${ownership.captainCount} · VC ${ownership.viceCaptainCount}`;
  }

  rankForTeam(team: FantasyTeam): number | null {
    return this.rankByTeamId().get(team._id) ?? null;
  }

  setCompareTeam(slot: 'A' | 'B', teamId: string) {
    if (slot === 'A') {
      this.compareTeamAId.set(teamId || null);
      return;
    }
    this.compareTeamBId.set(teamId || null);
  }

  togglePlayerDetails(teamId: string, playerId: string) {
    const key = `${teamId}:${playerId}`;
    this.expandedPlayerKey.set(this.expandedPlayerKey() === key ? null : key);
  }

  isPlayerExpanded(teamId: string, playerId: string): boolean {
    return this.expandedPlayerKey() === `${teamId}:${playerId}`;
  }

  multiplier(team: FantasyTeam, playerId: string): number {
    if (this.isCaptainById(team, playerId)) return 2;
    if (this.isVCById(team, playerId)) return 1.5;
    return 1;
  }

  multiplierLabel(team: FantasyTeam, playerId: string): string {
    if (this.isCaptainById(team, playerId)) return 'Captain x2';
    if (this.isVCById(team, playerId)) return 'Vice-captain x1.5';
    return 'Base x1';
  }

  teamContribution(team: FantasyTeam, playerId: string): number {
    return this.roundPoints(this.getPlayerPoints(playerId) * this.multiplier(team, playerId));
  }

  formatPoints(points: number): string {
    return points > 0 ? `+${points}` : `${points}`;
  }

  pointColor(points: number): string {
    if (points > 0) return 'var(--color-accent-hover)';
    if (points < 0) return 'var(--color-danger)';
    return 'var(--color-text-muted)';
  }

  pointsChipStyle(points: number): string {
    if (points > 0) {
      return 'background: rgba(34, 197, 94, 0.14); color: var(--color-success); border: 1px solid rgba(34, 197, 94, 0.25);';
    }
    if (points < 0) {
      return 'background: rgba(232, 83, 74, 0.14); color: var(--color-danger); border: 1px solid rgba(232, 83, 74, 0.25);';
    }
    return 'background: rgba(148, 163, 184, 0.12); color: var(--color-text-subtle); border: 1px solid rgba(148, 163, 184, 0.2);';
  }

  private loadTabData() {
    return forkJoin({
      teams: this.api.getAllTeams(this.matchId()),
      scores: this.hasScoreContext() ? this.api.getScores(this.matchId()) : of([] as PlayerPerformance[]),
      predictions: this.api.getMatchPredictions(this.matchId()),
    });
  }

  private ensureCompareDefaults(teams: FantasyTeam[]) {
    if (teams.length < 2) return;

    const ids = new Set(teams.map((team) => team._id));
    const myTeam = teams.find((team) => this.isMyTeam(team));
    const sorted = [...teams].sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return this.getOwnerName(a).localeCompare(this.getOwnerName(b));
    });

    const defaultA = ids.has(this.compareTeamAId() ?? '') ? this.compareTeamAId() : (myTeam?._id ?? sorted[0]?._id ?? null);
    this.compareTeamAId.set(defaultA);

    const currentB = this.compareTeamBId();
    if (currentB && ids.has(currentB) && currentB !== defaultA) {
      return;
    }

    const fallbackB = sorted.find((team) => team._id !== defaultA)?._id ?? null;
    this.compareTeamBId.set(fallbackB);
  }

  private findTeamById(teamId: string | null): FantasyTeam | null {
    if (!teamId) return null;
    return this.teams().find((team) => team._id === teamId) ?? null;
  }

  private buildTeamDiffPlayer(team: FantasyTeam, player: Player): TeamDiffPlayer {
    return {
      player,
      basePoints: this.getPlayerPoints(player._id),
      teamContribution: this.teamContribution(team, player._id),
      multiplierLabel: this.multiplierLabel(team, player._id),
      ownership: this.ownershipForPlayer(player._id),
      reasoning: this.playerReasoning(player._id),
      summary: this.playerSummary(player._id),
    };
  }

  private isCaptainById(team: FantasyTeam, playerId: string): boolean {
    const capId = typeof team.captain === 'string' ? team.captain : (team.captain as Player)._id;
    return capId === playerId;
  }

  private isVCById(team: FantasyTeam, playerId: string): boolean {
    const vcId = typeof team.viceCaptain === 'string' ? team.viceCaptain : (team.viceCaptain as Player)._id;
    return vcId === playerId;
  }

  private roundPoints(value: number): number {
    return Math.round(value * 10) / 10;
  }
}
