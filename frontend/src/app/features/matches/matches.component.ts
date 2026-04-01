import { Component, inject, signal, computed, resource } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { ApiService } from '../../core/services/api.service';
import { MatchCardComponent } from '../../shared/components/match-card/match-card.component';
import { Match, MatchStatus } from '../../core/models/api.models';
import { firstValueFrom } from 'rxjs';

type FilterTab = 'all' | 'upcoming' | 'live' | 'completed';

@Component({
  selector: 'app-matches',
  standalone: true,
  imports: [MatButtonToggleModule, MatProgressSpinnerModule, MatIconModule, MatchCardComponent],
  template: `
    <div class="space-y-6 fade-up">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">
          Match Schedule
        </h1>

        <mat-button-toggle-group [(value)]="activeTab" aria-label="Filter matches">
          <mat-button-toggle value="all">All</mat-button-toggle>
          <mat-button-toggle value="upcoming">Upcoming</mat-button-toggle>
          <mat-button-toggle value="live">Live</mat-button-toggle>
          <mat-button-toggle value="completed">Completed</mat-button-toggle>
        </mat-button-toggle-group>
      </div>

      @if (matches.isLoading()) {
        <div class="flex justify-center p-12"><mat-spinner diameter="48" /></div>
      }
      @if (matches.error()) {
        <p class="text-center py-8" style="color: var(--color-danger);">
          Failed to load matches. Please try again.
        </p>
      }

      <div class="grid md:grid-cols-2 gap-4">
        @for (match of filteredMatches(); track match._id) {
          <app-match-card [match]="match" class="stagger-item fade-up" />
        }
        @if (filteredMatches().length === 0 && !matches.isLoading()) {
          <div class="col-span-2 text-center py-12 card-surface">
            <mat-icon style="font-size: 48px; width: 48px; height: 48px; color: var(--color-text-subtle);">
              sports_cricket
            </mat-icon>
            <p class="mt-2" style="color: var(--color-text-muted);">No matches in this category yet.</p>
          </div>
        }
      </div>
    </div>
  `,
})
export class MatchesComponent {
  private readonly api = inject(ApiService);

  readonly activeTab = signal<FilterTab>('all');

  readonly matches = resource({
    loader: () => firstValueFrom(this.api.getMatches()),
  });

  readonly filteredMatches = computed<Match[]>(() => {
    const all = this.matches.value() ?? [];
    const tab = this.activeTab();

    if (tab === 'all') return all;
    if (tab === 'upcoming') return all.filter((m) => m.status === 'upcoming' || m.status === 'toss_done');
    if (tab === 'live') return all.filter((m) => m.status === 'live');
    if (tab === 'completed') return all.filter((m) => m.status === 'completed' || m.status === 'abandoned');
    return all;
  });
}
