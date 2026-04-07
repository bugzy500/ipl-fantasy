import { Component, OnInit, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/services/api.service';
import { ScoringMultiplier, ScoringRuleSection } from '../../core/models/api.models';

@Component({
  selector: 'app-rules',
  standalone: true,
  imports: [MatIconModule, MatProgressSpinnerModule],
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

      @if (loading()) {
        <div class="flex justify-center p-8"><mat-spinner diameter="40" /></div>
      }

      @if (error()) {
        <div class="card-surface rounded-xl p-5" style="border: 1px solid var(--color-danger);">
          <p class="text-sm" style="color: var(--color-danger);">{{ error() }}</p>
        </div>
      }

      @if (!loading() && !error()) {
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
export class RulesComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly openSection = signal<'batting' | 'bowling' | 'fielding' | 'predictions' | null>('batting');
  readonly scoringSections = signal<ScoringRuleSection[]>([]);
  readonly multipliers = signal<ScoringMultiplier[]>([]);
  readonly strikeRateMinBalls = signal(10);
  readonly economyMinOvers = signal(2);
  readonly loading = signal(true);
  readonly error = signal('');

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

  ngOnInit() {
    this.api.getScoringRules().subscribe({
      next: (rules) => {
        this.scoringSections.set(rules.sections);
        this.multipliers.set(rules.multipliers);
        this.strikeRateMinBalls.set(rules.thresholds.strikeRateMinBalls);
        this.economyMinOvers.set(rules.thresholds.economyMinOvers);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? 'Failed to load scoring rules');
        this.loading.set(false);
      },
    });
  }

  toggle(section: 'batting' | 'bowling' | 'fielding' | 'predictions') {
    this.openSection.set(this.openSection() === section ? null : section);
  }

  pointColor(points: number): string {
    if (points > 0) return 'var(--color-accent-hover)';
    if (points < 0) return 'var(--color-danger)';
    return 'var(--color-text-subtle)';
  }
}
