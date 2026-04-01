import { Component, inject, signal, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { ApiService } from '../../../core/services/api.service';
import { Match, Franchise, MatchStatus } from '../../../core/models/api.models';
import { firstValueFrom } from 'rxjs';

const FRANCHISES: Franchise[] = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'PBKS', 'DC', 'GT', 'LSG'];

@Component({
  selector: 'app-admin-matches',
  standalone: true,
  imports: [
    RouterLink, ReactiveFormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatProgressSpinnerModule, MatSnackBarModule, MatChipsModule,
  ],
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">Manage Matches</h1>
        <div class="flex gap-2">
          <button mat-stroked-button class="text-sm" (click)="autoLinkAll()"
                  [disabled]="autoLinking()">
            {{ autoLinking() ? 'Linking...' : 'Auto-Link CricAPI' }}
          </button>
          <button class="btn-primary text-sm px-4 py-2" (click)="showForm.update(v => !v)">
            {{ showForm() ? 'Cancel' : 'Schedule Match' }}
          </button>
        </div>
      </div>

      <!-- Schedule match form -->
      @if (showForm()) {
        <div class="card-surface p-5" style="border: 1px solid var(--color-border);">
          <h3 class="text-display font-semibold mb-4" style="color: var(--color-text);">Schedule New Match</h3>
          <p class="text-sm mb-4" style="color: var(--color-text-muted);">
            💡 For weekend double-headers, schedule two separate matches with 3:00 PM and 7:00 PM start times (IST).
          </p>
          <form [formGroup]="matchForm" (ngSubmit)="createMatch()" class="grid md:grid-cols-2 gap-4">
            <mat-form-field appearance="fill">
              <mat-label>Team 1</mat-label>
              <mat-select formControlName="team1">
                @for (f of franchises; track f) {
                  <mat-option [value]="f">{{ f }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Team 2</mat-label>
              <mat-select formControlName="team2">
                @for (f of franchises; track f) {
                  <mat-option [value]="f">{{ f }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Match Date & Time (IST)</mat-label>
              <input matInput type="datetime-local" formControlName="scheduledAt" />
              <mat-hint>Deadline auto-sets to 30 mins after this</mat-hint>
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Venue (optional)</mat-label>
              <input matInput formControlName="venue" />
            </mat-form-field>
            <div class="flex gap-2">
              <button mat-flat-button color="primary" type="submit"
                      [disabled]="matchForm.invalid || saving()">
                {{ saving() ? 'Saving…' : 'Create Match' }}
              </button>
            </div>
          </form>
        </div>
      }

      <!-- Matches list -->
      @if (matches.isLoading()) {
        <div class="flex justify-center p-8"><mat-spinner diameter="48" /></div>
      }
      <div class="space-y-3">
        @for (match of matches.value() ?? []; track match._id) {
          <div class="card-surface p-4 space-y-3" style="border: 1px solid var(--color-border);">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div>
                <span class="font-semibold" style="color: var(--color-text);">{{ match.team1 }} vs {{ match.team2 }}</span>
                <span class="text-sm ml-2" style="color: var(--color-text-muted);">{{ formatDate(match.scheduledAt) }}</span>
              </div>
              <mat-chip>{{ match.status }}</mat-chip>
            </div>

            <!-- Deadline display + override -->
            <div class="flex items-center gap-2 text-sm" style="color: var(--color-text-muted);">
              <span>Deadline: {{ formatDate(match.deadline) }}</span>
              @if (match.status === 'upcoming' || match.status === 'toss_done' || match.status === 'live') {
                <button mat-stroked-button class="text-xs" (click)="toggleDeadlineEdit(match._id)">
                  Edit
                </button>
              }
            </div>
            @if (editingDeadlineId() === match._id) {
              <div class="flex items-center gap-2">
                <mat-form-field appearance="fill" class="text-sm">
                  <mat-label>New Deadline (IST)</mat-label>
                  <input matInput type="datetime-local" [value]="toLocalDatetime(match.deadline)"
                         (change)="onDeadlineChange($event)" />
                </mat-form-field>
                <button mat-flat-button color="primary" (click)="saveDeadline(match._id)">Save</button>
                <button mat-button (click)="editingDeadlineId.set(null)">Cancel</button>
              </div>
            }

            <!-- CricAPI integration -->
            <div class="flex items-center gap-2 flex-wrap text-sm"
                 style="border-top: 1px solid var(--color-border); padding-top: 8px;">
              @if (!match.cricApiMatchId) {
                <input #cricIdInput type="text" placeholder="CricAPI Match ID"
                       class="px-2 py-1 rounded text-xs w-48"
                       style="background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text);" />
                <button mat-stroked-button class="text-xs"
                        (click)="linkCricApi(match._id, cricIdInput.value)">
                  Link CricAPI
                </button>
              } @else {
                <span class="text-xs" style="color: var(--color-text-muted);">
                  CricAPI: {{ match.cricApiMatchId.slice(0, 12) }}...
                </span>
                @if (match.pollingEnabled) {
                  <span class="text-xs px-2 py-0.5 rounded-full"
                        style="background: rgba(34, 197, 94, 0.15); color: var(--color-success);">
                    Polling Active
                  </span>
                  <button mat-stroked-button class="text-xs" color="warn"
                          (click)="stopCricApiPolling(match._id)">Stop</button>
                } @else {
                  <button mat-stroked-button class="text-xs"
                          (click)="startCricApiPolling(match._id)">Start Polling</button>
                }
                <button mat-stroked-button class="text-xs"
                        (click)="syncCricApiOnce(match._id)">Sync Now</button>
                @if (match.lastPolledAt) {
                  <span class="text-xs" style="color: var(--color-text-subtle);">
                    Last: {{ formatDate(match.lastPolledAt) }}
                  </span>
                }
              }
            </div>

            <!-- Action buttons per status -->
            <div class="flex flex-wrap gap-2">
              @if (match.status === 'upcoming') {
                <button mat-stroked-button (click)="updateStatus(match._id, 'toss_done')">
                  📢 Announce XI
                </button>
              }
              @if (match.status === 'toss_done') {
                <button mat-stroked-button color="accent" (click)="updateStatus(match._id, 'live')">
                  🔴 Mark Live
                </button>
              }
              @if (match.status === 'live') {
                <a mat-flat-button color="primary" [routerLink]="['/admin/scores', match._id]">
                  📊 Enter Scores (Manual)
                </a>
                <button mat-stroked-button color="warn" (click)="updateStatus(match._id, 'abandoned')">
                  ⚠ Abandon
                </button>
              }
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class AdminMatchesComponent {
  private readonly api = inject(ApiService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  readonly franchises = FRANCHISES;
  readonly showForm = signal(false);
  readonly saving = signal(false);
  readonly editingDeadlineId = signal<string | null>(null);
  readonly autoLinking = signal(false);
  private newDeadline = '';

  readonly matches = resource({
    loader: () => firstValueFrom(this.api.getMatches()),
  });

  readonly matchForm = this.fb.group({
    team1: ['', Validators.required],
    team2: ['', Validators.required],
    scheduledAt: ['', Validators.required],
    venue: [''],
  });

  createMatch() {
    if (this.matchForm.invalid) return;
    this.saving.set(true);

    const raw = this.matchForm.value;
    // Convert local datetime-local string to ISO (backend stores in UTC)
    const payload = {
      team1: raw.team1!,
      team2: raw.team2!,
      venue: raw.venue ?? '',
      scheduledAt: new Date(raw.scheduledAt!).toISOString(),
    };

    this.api.createMatch(payload as any).subscribe({
      next: () => {
        this.snackBar.open('✅ Match scheduled', 'OK', { duration: 2000 });
        this.matches.reload();
        this.matchForm.reset();
        this.showForm.set(false);
        this.saving.set(false);
      },
      error: (err) => {
        this.snackBar.open(err.error?.message ?? 'Failed to create match', 'OK', { duration: 3000 });
        this.saving.set(false);
      },
    });
  }

  updateStatus(id: string, status: MatchStatus) {
    this.api.updateMatch(id, { status }).subscribe({
      next: () => {
        this.snackBar.open(`Status updated to ${status}`, 'OK', { duration: 2000 });
        this.matches.reload();
      },
      error: () => this.snackBar.open('Update failed', 'OK', { duration: 2000 }),
    });
  }

  formatDate(d: string) {
    return new Date(d).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    }) + ' IST';
  }

  toggleDeadlineEdit(matchId: string) {
    this.editingDeadlineId.set(this.editingDeadlineId() === matchId ? null : matchId);
  }

  toLocalDatetime(isoStr: string): string {
    // Convert UTC ISO string to local datetime-local input value in IST
    const d = new Date(isoStr);
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 16);
  }

  onDeadlineChange(event: Event) {
    this.newDeadline = (event.target as HTMLInputElement).value;
  }

  saveDeadline(matchId: string) {
    if (!this.newDeadline) return;
    const deadline = new Date(this.newDeadline).toISOString();
    this.api.updateMatch(matchId, { deadline } as any).subscribe({
      next: () => {
        this.snackBar.open('✅ Deadline updated', 'OK', { duration: 2000 });
        this.editingDeadlineId.set(null);
        this.matches.reload();
      },
      error: () => this.snackBar.open('Failed to update deadline', 'OK', { duration: 2000 }),
    });
  }

  // ── CricAPI Controls ─────────────────────────────────────────────────────

  linkCricApi(matchId: string, cricApiMatchId: string) {
    if (!cricApiMatchId?.trim()) return;
    this.api.linkCricApiMatch(matchId, cricApiMatchId.trim()).subscribe({
      next: () => {
        this.snackBar.open('✅ CricAPI match linked', 'OK', { duration: 2000 });
        this.matches.reload();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Link failed', 'OK', { duration: 2000 }),
    });
  }

  startCricApiPolling(matchId: string) {
    this.api.startPolling(matchId).subscribe({
      next: () => {
        this.snackBar.open('✅ Live polling started', 'OK', { duration: 2000 });
        this.matches.reload();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to start polling', 'OK', { duration: 2000 }),
    });
  }

  stopCricApiPolling(matchId: string) {
    this.api.stopPolling(matchId).subscribe({
      next: () => {
        this.snackBar.open('Polling stopped', 'OK', { duration: 2000 });
        this.matches.reload();
      },
      error: () => this.snackBar.open('Failed to stop polling', 'OK', { duration: 2000 }),
    });
  }

  syncCricApiOnce(matchId: string) {
    this.snackBar.open('Syncing...', '', { duration: 10000 });
    this.api.syncOnce(matchId).subscribe({
      next: () => {
        this.snackBar.open('✅ Sync completed', 'OK', { duration: 2000 });
        this.matches.reload();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Sync failed', 'OK', { duration: 3000 }),
    });
  }

  autoLinkAll() {
    this.autoLinking.set(true);
    this.api.autoLinkCricApiMatches().subscribe({
      next: (res) => {
        this.snackBar.open(`✅ Linked ${res.linked} match(es) from CricAPI`, 'OK', { duration: 3000 });
        this.matches.reload();
        this.autoLinking.set(false);
      },
      error: (err) => {
        this.snackBar.open(err.error?.message ?? 'Auto-link failed', 'OK', { duration: 3000 });
        this.autoLinking.set(false);
      },
    });
  }
}
