import { Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ScoringMultiplier, ScoringRuleSection } from '../../core/models/api.models';

@Component({
  selector: 'app-rules',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="space-y-8 fade-up">
      <div class="space-y-3">
        <div class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider"
             style="background: rgba(34, 197, 94, 0.12); color: var(--color-success);">
          <span class="w-2 h-2 rounded-full" style="background: currentColor;"></span>
          Rules pulled from the live scoring engine
        </div>
        <div>
          <h1 class="text-display text-2xl md:text-3xl" style="color: var(--color-text);">
            How Scoring Works
          </h1>
          <p class="mt-2 text-sm" style="color: var(--color-text-muted); line-height: 1.7;">
            This page is now driven by the same backend rules that calculate fantasy points.
            If the rules change, this page changes with them. No more frontend fiction.
          </p>
        </div>
      </div>

      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        @for (card of quickRules; track card.title) {
          <div class="card-surface rounded-xl p-5 space-y-3 stagger-item fade-up"
               style="border: 1px solid var(--color-border);">
            <div class="flex items-center gap-3">
              <div class="icon-circle" [style.background]="card.bg">
                <mat-icon [style.color]="card.accent" style="font-size: 20px; width: 20px; height: 20px;">
                  {{ card.icon }}
                </mat-icon>
              </div>
              <span class="text-display font-semibold text-sm" style="color: var(--color-text);">
                {{ card.title }}
              </span>
            </div>
            <p class="text-xs leading-relaxed" style="color: var(--color-text-muted);">
              {{ card.description }}
            </p>
          </div>
        }
      </div>

      @if (true) {
        <div class="card-surface rounded-xl p-5 space-y-3" style="border: 1px solid var(--color-border);">
          <h2 class="text-display font-semibold text-sm" style="color: var(--color-text);">
            Thresholds That Matter
          </h2>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="threshold-card">
              <span class="threshold-label">Strike rate modifier</span>
              <span class="threshold-value">Applies from {{ strikeRateMinBalls() }} balls faced</span>
            </div>
            <div class="threshold-card">
              <span class="threshold-label">Economy modifier</span>
              <span class="threshold-value">Applies from {{ economyMinOvers() }} overs bowled</span>
            </div>
          </div>
        </div>

        <div>
          <h2 class="text-display text-lg mb-4" style="color: var(--color-text);">Scoring System</h2>
          <div class="space-y-4">
            @for (section of scoringSections(); track section.key) {
              <div class="card-surface rounded-xl overflow-hidden stagger-item fade-up"
                   style="border: 1px solid var(--color-border);">
                <button class="w-full flex items-center gap-3 p-4 text-left"
                        style="background: transparent; border: none; cursor: pointer;"
                        (click)="toggle(section.key)">
                  <mat-icon [style.color]="section.color" style="font-size: 20px; width: 20px; height: 20px;">
                    {{ section.icon }}
                  </mat-icon>
                  <span class="text-display font-semibold text-sm flex-1" style="color: var(--color-text);">
                    {{ section.title }}
                  </span>
                  <mat-icon class="section-chevron"
                            [class.section-chevron--open]="openSection() === section.key"
                            style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                    expand_more
                  </mat-icon>
                </button>

                @if (openSection() === section.key) {
                  <div class="px-4 pb-4">
                    <div class="scoring-table">
                      @for (rule of section.rules; track rule.label) {
                        <div class="scoring-row">
                          <div class="space-y-1">
                            <span class="scoring-label">{{ rule.label }}</span>
                            @if (rule.note) {
                              <div class="scoring-note">{{ rule.note }}</div>
                            }
                          </div>
                          <span class="scoring-points" [style.color]="pointColor(rule.points)">
                            {{ rule.displayPoints }}
                          </span>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <div class="card-elevated rounded-xl p-5 space-y-3"
             style="border: 1px solid var(--color-accent-muted);">
          <h3 class="text-display font-semibold text-sm" style="color: var(--color-text);">
            Captain & Vice-Captain Multiplier
          </h3>
          <div class="flex flex-wrap gap-4">
            @for (multiplier of multipliers(); track multiplier.key) {
              <div class="flex items-center gap-3">
                <span class="multiplier-badge"
                      [class.multiplier-badge--c]="multiplier.key === 'captain'"
                      [class.multiplier-badge--vc]="multiplier.key === 'viceCaptain'">
                  {{ multiplier.key === 'captain' ? 'C' : 'VC' }}
                </span>
                <div>
                  <span class="text-sm font-medium" style="color: var(--color-text);">
                    {{ multiplier.label }}
                  </span>
                  <p class="text-xs" style="color: var(--color-text-muted);">
                    {{ multiplier.displayMultiplier }} fantasy points
                  </p>
                </div>
              </div>
            }
          </div>
        </div>

        <div class="card-surface rounded-xl p-5 space-y-3"
             style="border: 1px solid var(--color-border);">
          <h3 class="text-display font-semibold text-sm" style="color: var(--color-text);">
            Deadlines & Locking
          </h3>
          <ul class="space-y-2 text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
            <li>Teams lock exactly when the first ball is bowled.</li>
            <li>You can edit your team any number of times before the deadline.</li>
            <li>Once locked, your team cannot be changed.</li>
            <li>If you do not submit a team, you score 0 for that match.</li>
            <li>Player scorecards in live and completed matches show the exact point breakdown.</li>
          </ul>
        </div>
      }
    </div>
  `,
  styles: [`
    .icon-circle {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .threshold-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }

    .threshold-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-text-subtle);
    }

    .threshold-value {
      font-size: 13px;
      color: var(--color-text);
    }

    .section-chevron {
      transition: transform 200ms var(--ease-out);
    }
    .section-chevron--open {
      transform: rotate(180deg);
    }

    .scoring-table {
      display: flex;
      flex-direction: column;
    }
    .scoring-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 10px 0;
      border-bottom: 1px solid var(--color-border);
    }
    .scoring-row:last-of-type {
      border-bottom: none;
    }
    .scoring-label {
      display: block;
      font-size: 13px;
      color: var(--color-text);
    }
    .scoring-points {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
    }
    .scoring-note {
      font-size: 11px;
      color: var(--color-text-subtle);
    }

    .multiplier-badge {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 14px;
      flex-shrink: 0;
    }
    .multiplier-badge--c {
      background: rgba(245, 158, 11, 0.15);
      color: #F59E0B;
    }
    .multiplier-badge--vc {
      background: rgba(217, 119, 6, 0.12);
      color: #D97706;
    }
  `],
})
export class RulesComponent {
  readonly openSection = signal<'batting' | 'bowling' | 'fielding' | 'predictions' | null>('batting');
  readonly strikeRateMinBalls = signal(10);
  readonly economyMinOvers = signal(2);

  readonly scoringSections = signal<ScoringRuleSection[]>([
    {
      key: 'batting', title: 'Batting', icon: 'sports_cricket', color: '#3B82F6',
      rules: [
        { label: 'Per run scored', points: 1, displayPoints: '+1' },
        { label: 'Per boundary (4)', points: 1, displayPoints: '+1 bonus' },
        { label: 'Per six', points: 2, displayPoints: '+2 bonus' },
        { label: 'Half-century (50 runs)', points: 8, displayPoints: '+8' },
        { label: 'Century (100 runs)', points: 16, displayPoints: '+16' },
        { label: 'Duck penalty', points: -2, displayPoints: '-2', note: 'Applies only to BAT, WK, and AR who are dismissed for 0.' },
        { label: 'Strike rate above 170', points: 6, displayPoints: '+6', note: 'Min 10 balls faced' },
        { label: 'Strike rate 150.01 – 170', points: 4, displayPoints: '+4' },
        { label: 'Strike rate 130 – 150', points: 2, displayPoints: '+2' },
        { label: 'Strike rate 60 – 70', points: -2, displayPoints: '-2' },
        { label: 'Strike rate 50 – 59.99', points: -4, displayPoints: '-4' },
        { label: 'Strike rate below 50', points: -6, displayPoints: '-6' },
      ],
    },
    {
      key: 'bowling', title: 'Bowling', icon: 'sports_baseball', color: '#E8534A',
      rules: [
        { label: 'Per wicket', points: 25, displayPoints: '+25', note: 'Run-outs do not count as wickets.' },
        { label: 'LBW / Bowled bonus (per wicket)', points: 8, displayPoints: '+8' },
        { label: 'Per dot ball bowled', points: 2, displayPoints: '+2' },
        { label: 'Per maiden over', points: 12, displayPoints: '+12' },
        { label: '4-wicket haul', points: 8, displayPoints: '+8' },
        { label: '5-wicket haul', points: 16, displayPoints: '+16' },
        { label: 'Economy below 5', points: 6, displayPoints: '+6', note: 'Min 2 overs bowled' },
        { label: 'Economy 5 – 5.99', points: 4, displayPoints: '+4' },
        { label: 'Economy 6 – 7', points: 2, displayPoints: '+2' },
        { label: 'Economy 10 – 11', points: -2, displayPoints: '-2' },
        { label: 'Economy 11.01 – 12', points: -4, displayPoints: '-4' },
        { label: 'Economy above 12', points: -6, displayPoints: '-6' },
      ],
    },
    {
      key: 'fielding', title: 'Fielding', icon: 'sports_handball', color: '#22C55E',
      rules: [
        { label: 'Per catch', points: 8, displayPoints: '+8' },
        { label: '3+ catches in a match', points: 4, displayPoints: '+4 bonus' },
        { label: 'Per stumping', points: 12, displayPoints: '+12' },
        { label: 'Direct run-out', points: 12, displayPoints: '+12' },
        { label: 'Indirect run-out (throw or catch)', points: 6, displayPoints: '+6' },
      ],
    },
    {
      key: 'predictions', title: 'Match Predictions', icon: 'psychology', color: '#F59E0B',
      rules: [
        { label: 'Correct winner prediction', points: 50, displayPoints: '+50', note: 'Predict the winning team before the match starts.' },
        { label: 'Correct super over prediction', points: 150, displayPoints: '+150', note: 'Predict the match goes to a super over. Higher risk, higher reward.' },
        { label: 'Wrong or no prediction', points: 0, displayPoints: '0', note: 'No penalty for wrong predictions.' },
      ],
    },
  ]);

  readonly multipliers = signal<ScoringMultiplier[]>([
    { key: 'captain', label: 'Captain', multiplier: 2, displayMultiplier: '2x', note: 'Captain scores double fantasy points.' },
    { key: 'viceCaptain', label: 'Vice-Captain', multiplier: 1.5, displayMultiplier: '1.5x', note: 'Vice-Captain scores 1.5x fantasy points.' },
  ]);

  readonly quickRules = [
    {
      icon: 'group_add',
      title: 'Pick 11 Players',
      description: 'Select exactly 11 players from both teams within the credit budget. Keep the role split legal and stay under the cap.',
      accent: '#3B82F6',
      bg: 'rgba(59, 130, 246, 0.12)',
    },
    {
      icon: 'star',
      title: 'Choose C & VC',
      description: 'Captain scores 2x. Vice-Captain scores 1.5x. If you get these wrong, the leaderboard punishes you hard.',
      accent: '#F59E0B',
      bg: 'rgba(245, 158, 11, 0.12)',
    },
    {
      icon: 'timer',
      title: 'Beat the Deadline',
      description: 'Your XI locks at the first ball. After that, no edits, no excuses.',
      accent: '#E8534A',
      bg: 'rgba(232, 83, 74, 0.12)',
    },
    {
      icon: 'scoreboard',
      title: 'See The Math',
      description: 'Live and completed matches now show batting, bowling, fielding, and modifier line-items behind every player total.',
      accent: '#22C55E',
      bg: 'rgba(34, 197, 94, 0.12)',
    },
    {
      icon: 'leaderboard',
      title: 'Climb the Leaderboard',
      description: 'Match scores roll into the season table. One bad captain pick can bury you for weeks.',
      accent: '#7C3AED',
      bg: 'rgba(124, 58, 237, 0.12)',
    },
    {
      icon: 'menu_book',
      title: 'Rules Stay Synced',
      description: 'This page is generated from the backend scoring contract, so the numbers here and the numbers in the engine stay aligned.',
      accent: '#06B6D4',
      bg: 'rgba(6, 182, 212, 0.12)',
    },
  ];

  toggle(section: 'batting' | 'bowling' | 'fielding' | 'predictions') {
    this.openSection.set(this.openSection() === section ? null : section);
  }

  pointColor(points: number): string {
    if (points > 0) return 'var(--color-accent-hover)';
    if (points < 0) return 'var(--color-danger)';
    return 'var(--color-text-subtle)';
  }
}
