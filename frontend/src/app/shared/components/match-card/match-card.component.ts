import { Component, input, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Match, MatchStatus } from '../../../core/models/api.models';

@Component({
  selector: 'app-match-card',
  standalone: true,
  imports: [RouterLink, MatButtonModule, MatIconModule],
  template: `
    <div class="card-surface p-0 overflow-hidden transition-all hover:translate-y-[-2px]"
         [class.pulse-live]="match().status === 'live'"
         style="border: 1px solid var(--color-border);">

      <!-- Header row -->
      <div class="flex items-center justify-between px-5 pt-4 pb-2">
        <span class="text-label">{{ formattedDate() }}</span>
        <span [class]="statusChipClass()" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold">
          @if (match().status === 'live') {
            <span class="live-dot"></span>
          }
          {{ statusLabel() }}
        </span>
      </div>

      <!-- VS layout -->
      <div class="flex items-center justify-between text-center px-5 py-4">
        <div class="flex-1">
          <div class="text-display text-xl font-semibold" style="color: var(--color-accent-hover);">
            {{ match().team1 }}
          </div>
        </div>
        <div class="px-4">
          <span class="text-xs font-medium" style="color: var(--color-text-subtle);">VS</span>
        </div>
        <div class="flex-1">
          <div class="text-display text-xl font-semibold" style="color: var(--color-warning);">
            {{ match().team2 }}
          </div>
        </div>
      </div>

      @if (match().venue) {
        <p class="text-center text-xs px-5 pb-1" style="color: var(--color-text-muted);">
          {{ match().venue }}
        </p>
      }

      @if (match().result) {
        <div class="mx-5 mb-3 text-center text-sm font-medium py-2 rounded-lg"
             style="background: rgba(34, 197, 94, 0.1); color: var(--color-success);">
          {{ match().result }}
        </div>
      }

      <!-- Deadline info -->
      @if (isUpcoming()) {
        <div class="mx-5 mb-3 text-center text-xs py-2 rounded-lg" [style]="deadlineStyle()">
          @if (timeToDeadline() > 0) {
            {{ deadlineUrgencyLabel() }} {{ deadlineString() }}
          } @else {
            Deadline passed
          }
        </div>
      }

      <!-- Action -->
      <div class="px-5 pb-4 flex justify-end">
        <a [routerLink]="['/matches', match()._id]"
           class="btn-ghost inline-flex items-center gap-1 text-sm px-3 py-2"
           style="color: var(--color-accent-hover); min-height: 36px;">
          @switch (match().status) {
            @case ('upcoming') { Build Team }
            @case ('toss_done') { Build Team }
            @case ('live') { View Live }
            @default { View Results }
          }
          <mat-icon class="text-[18px]">arrow_forward</mat-icon>
        </a>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .card-surface { transition: transform 0.2s var(--ease-out); }
  `],
})
export class MatchCardComponent {
  readonly match = input.required<Match>();

  readonly formattedDate = computed(() => {
    const d = new Date(this.match().scheduledAt);
    return d.toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }) + ' IST';
  });

  readonly timeToDeadline = computed(() =>
    new Date(this.match().deadline).getTime() - Date.now()
  );

  readonly isUpcoming = computed(() =>
    this.match().status === 'upcoming' || this.match().status === 'toss_done'
  );

  readonly deadlineString = computed(() => {
    const d = new Date(this.match().deadline);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST';
  });

  readonly deadlineUrgencyLabel = computed(() => {
    const ms = this.timeToDeadline();
    if (ms <= 0) return '';
    if (ms < 30 * 60 * 1000) return 'Hurry!';
    if (ms < 2 * 60 * 60 * 1000) return 'Deadline:';
    return 'Deadline:';
  });

  readonly deadlineStyle = computed(() => {
    const ms = this.timeToDeadline();
    if (ms <= 0) return 'background: rgba(232, 83, 74, 0.1); color: var(--color-danger); font-weight: 600;';
    if (ms < 30 * 60 * 1000) return 'background: rgba(232, 83, 74, 0.1); color: var(--color-danger); font-weight: 600;';
    if (ms < 2 * 60 * 60 * 1000) return 'background: rgba(245, 158, 11, 0.1); color: var(--color-warning); font-weight: 500;';
    return 'background: rgba(34, 197, 94, 0.08); color: var(--color-success);';
  });

  readonly statusLabel = computed(() => {
    const labels: Record<MatchStatus, string> = {
      upcoming: 'Upcoming',
      toss_done: 'XI Announced',
      live: 'LIVE',
      completed: 'Completed',
      abandoned: 'Abandoned',
    };
    return labels[this.match().status];
  });

  readonly statusChipClass = computed(() => {
    const classes: Record<MatchStatus, string> = {
      upcoming: 'status-upcoming',
      toss_done: 'status-upcoming',
      live: 'status-live',
      completed: 'status-completed',
      abandoned: '',
    };
    return classes[this.match().status] || '';
  });
}
