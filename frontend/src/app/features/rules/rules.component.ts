import { Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

interface ScoringRule {
  label: string;
  points: string;
  note?: string;
}

interface ScoringSection {
  title: string;
  icon: string;
  color: string;
  rules: ScoringRule[];
}

@Component({
  selector: 'app-rules',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <div class="space-y-8 fade-up">
      <!-- Header -->
      <div>
        <h1 class="text-display text-2xl md:text-3xl" style="color: var(--color-text);">
          How to Play
        </h1>
        <p class="mt-2 text-sm" style="color: var(--color-text-muted); line-height: 1.7;">
          Build your fantasy XI for each IPL match, pick a Captain and Vice-Captain,
          and compete with friends on the leaderboard.
        </p>
      </div>

      <!-- Quick rules -->
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

      <!-- Scoring tables -->
      <div>
        <h2 class="text-display text-lg mb-4" style="color: var(--color-text);">Scoring System</h2>
        <div class="space-y-4">
          @for (section of scoringSections; track section.title) {
            <div class="card-surface rounded-xl overflow-hidden stagger-item fade-up"
                 style="border: 1px solid var(--color-border);">
              <button class="w-full flex items-center gap-3 p-4 text-left"
                      style="background: transparent; border: none; cursor: pointer;"
                      (click)="toggle(section.title)">
                <mat-icon [style.color]="section.color" style="font-size: 20px; width: 20px; height: 20px;">
                  {{ section.icon }}
                </mat-icon>
                <span class="text-display font-semibold text-sm flex-1" style="color: var(--color-text);">
                  {{ section.title }}
                </span>
                <mat-icon class="section-chevron"
                          [class.section-chevron--open]="openSection() === section.title"
                          style="color: var(--color-text-subtle); font-size: 20px; width: 20px; height: 20px;">
                  expand_more
                </mat-icon>
              </button>

              @if (openSection() === section.title) {
                <div class="px-4 pb-4">
                  <div class="scoring-table">
                    @for (rule of section.rules; track rule.label) {
                      <div class="scoring-row">
                        <span class="scoring-label">{{ rule.label }}</span>
                        <span class="scoring-points"
                              [style.color]="rule.points.startsWith('-') ? 'var(--color-danger)' : 'var(--color-accent-hover)'">
                          {{ rule.points }}
                        </span>
                      </div>
                      @if (rule.note) {
                        <div class="scoring-note">{{ rule.note }}</div>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>

      <!-- Captain / VC multiplier -->
      <div class="card-elevated rounded-xl p-5 space-y-3"
           style="border: 1px solid var(--color-accent-muted);">
        <h3 class="text-display font-semibold text-sm" style="color: var(--color-text);">
          Captain & Vice-Captain Multiplier
        </h3>
        <div class="flex gap-6">
          <div class="flex items-center gap-3">
            <span class="multiplier-badge multiplier-badge--c">C</span>
            <div>
              <span class="text-sm font-medium" style="color: var(--color-text);">Captain</span>
              <p class="text-xs" style="color: var(--color-text-muted);">2x fantasy points</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="multiplier-badge multiplier-badge--vc">VC</span>
            <div>
              <span class="text-sm font-medium" style="color: var(--color-text);">Vice-Captain</span>
              <p class="text-xs" style="color: var(--color-text-muted);">1.5x fantasy points</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Deadlines info -->
      <div class="card-surface rounded-xl p-5 space-y-3"
           style="border: 1px solid var(--color-border);">
        <h3 class="text-display font-semibold text-sm" style="color: var(--color-text);">
          Deadlines & Locking
        </h3>
        <ul class="space-y-2 text-xs" style="color: var(--color-text-muted); line-height: 1.7;">
          <li>Teams lock 30 minutes before the scheduled match time.</li>
          <li>You can edit your team any number of times before the deadline.</li>
          <li>Once locked, your team cannot be changed.</li>
          <li>If you don't submit a team, you score 0 for that match.</li>
          <li>Watch for reminder notifications as the deadline approaches.</li>
        </ul>
      </div>
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
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--color-border);
    }
    .scoring-row:last-of-type {
      border-bottom: none;
    }
    .scoring-label {
      font-size: 13px;
      color: var(--color-text-muted);
    }
    .scoring-points {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 13px;
    }
    .scoring-note {
      font-size: 11px;
      color: var(--color-text-subtle);
      padding: 0 0 8px;
      border-bottom: 1px solid var(--color-border);
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
      background: rgba(245, 158, 11, 0.08);
      color: #D97706;
    }
  `],
})
export class RulesComponent {
  readonly openSection = signal<string | null>('Batting');

  readonly quickRules = [
    {
      icon: 'group_add',
      title: 'Pick 11 Players',
      description: 'Select exactly 11 players from both teams within the credit budget. Mix of batters, bowlers, all-rounders, and wicketkeepers.',
      accent: '#7C3AED',
      bg: 'rgba(124, 58, 237, 0.12)',
    },
    {
      icon: 'star',
      title: 'Choose C & VC',
      description: 'Pick a Captain (2x points) and Vice-Captain (1.5x points) wisely. They are your biggest point multipliers.',
      accent: '#F59E0B',
      bg: 'rgba(245, 158, 11, 0.12)',
    },
    {
      icon: 'timer',
      title: 'Beat the Deadline',
      description: 'Submit your team before it locks (30 min before match). Edit unlimited times before deadline.',
      accent: '#E8534A',
      bg: 'rgba(232, 83, 74, 0.12)',
    },
    {
      icon: 'scoreboard',
      title: 'Earn Fantasy Points',
      description: 'Players earn points for runs, wickets, catches, and more. Bonuses for milestones and strike rate.',
      accent: '#22C55E',
      bg: 'rgba(34, 197, 94, 0.12)',
    },
    {
      icon: 'leaderboard',
      title: 'Climb the Leaderboard',
      description: 'Your team total is summed each match. Season leaderboard tracks cumulative points across all matches.',
      accent: '#3B82F6',
      bg: 'rgba(59, 130, 246, 0.12)',
    },
    {
      icon: 'emoji_events',
      title: 'Win Awards',
      description: 'Special awards each match: Top Scorer, Best Captain Pick, Perfect XI, and Underdog Win.',
      accent: '#F59E0B',
      bg: 'rgba(245, 158, 11, 0.12)',
    },
  ];

  readonly scoringSections: ScoringSection[] = [
    {
      title: 'Batting',
      icon: 'sports_cricket',
      color: '#3B82F6',
      rules: [
        { label: 'Per run scored', points: '+1' },
        { label: 'Per boundary (4)', points: '+1 bonus' },
        { label: 'Per six', points: '+2 bonus' },
        { label: 'Half-century (50 runs)', points: '+8' },
        { label: 'Century (100 runs)', points: '+16' },
        { label: 'Duck (0 runs, dismissed)', points: '-2', note: 'Not applicable to pure bowlers (BOWL role)' },
        { label: 'Strike rate > 170', points: '+6', note: 'Min 10 balls faced' },
        { label: 'Strike rate 150.01 - 170', points: '+4' },
        { label: 'Strike rate 130 - 150', points: '+2' },
        { label: 'Strike rate 60 - 70', points: '-2' },
        { label: 'Strike rate 50 - 59.99', points: '-4' },
        { label: 'Strike rate < 50', points: '-6' },
      ],
    },
    {
      title: 'Bowling',
      icon: 'sports_baseball',
      color: '#E8534A',
      rules: [
        { label: 'Per wicket', points: '+25' },
        { label: 'LBW / Bowled bonus (per wicket)', points: '+8' },
        { label: 'Per maiden over', points: '+12' },
        { label: '4-wicket haul', points: '+8' },
        { label: '5-wicket haul', points: '+16' },
        { label: 'Economy < 5', points: '+6', note: 'Min 2 overs bowled' },
        { label: 'Economy 5 - 5.99', points: '+4' },
        { label: 'Economy 6 - 7', points: '+2' },
        { label: 'Economy 10 - 11', points: '-2' },
        { label: 'Economy 11.01 - 12', points: '-4' },
        { label: 'Economy > 12', points: '-6' },
      ],
    },
    {
      title: 'Fielding',
      icon: 'sports_handball',
      color: '#22C55E',
      rules: [
        { label: 'Per catch', points: '+8' },
        { label: '3+ catches in a match', points: '+8 bonus' },
        { label: 'Per stumping', points: '+12' },
        { label: 'Direct run-out', points: '+10' },
        { label: 'Indirect run-out (throw/assist)', points: '+6' },
      ],
    },
  ];

  toggle(title: string) {
    this.openSection.set(this.openSection() === title ? null : title);
  }
}
