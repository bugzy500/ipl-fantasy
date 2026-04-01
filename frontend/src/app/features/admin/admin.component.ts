import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterLink, MatButtonModule, MatIconModule],
  template: `
    <div class="space-y-6 fade-up">
      <div>
        <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">
          Admin Panel
        </h1>
        <p class="text-sm mt-1" style="color: var(--color-text-muted);">
          Manage the league from here.
        </p>
      </div>

      <div class="grid md:grid-cols-3 gap-4">
        @for (card of adminCards; track card.title) {
          <div class="card-surface flex flex-col items-center gap-3 text-center hover:translate-y-[-2px] transition-transform"
               style="border: 1px solid var(--color-border);">
            <mat-icon [style.color]="card.color"
                      style="font-size: 40px; width: 40px; height: 40px;">
              {{ card.icon }}
            </mat-icon>
            <h3 class="text-display font-semibold" style="color: var(--color-text);">
              {{ card.title }}
            </h3>
            <p class="text-sm" style="color: var(--color-text-muted);">{{ card.desc }}</p>
            <a [routerLink]="card.route" class="btn-primary text-sm px-5 py-2 mt-1">
              {{ card.action }}
            </a>
          </div>
        }
      </div>
    </div>
  `,
})
export class AdminComponent {
  readonly adminCards = [
    {
      icon: 'people', color: 'var(--color-accent-hover)', title: 'Players',
      desc: 'Add, edit, and set credit values for all IPL 2026 players.',
      route: '/admin/players', action: 'Manage Players',
    },
    {
      icon: 'sports_cricket', color: 'var(--color-warning)', title: 'Matches',
      desc: 'Schedule matches, announce playing XI after toss.',
      route: '/admin/matches', action: 'Manage Matches',
    },
    {
      icon: 'scoreboard', color: 'var(--color-success)', title: 'Enter Scores',
      desc: 'Enter player stats after a match to calculate fantasy points.',
      route: '/admin/matches', action: 'Go to Matches',
    },
  ];
}
