import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-join',
  standalone: true,
  imports: [
    ReactiveFormsModule, RouterLink,
    MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 class="text-display text-xl font-semibold mb-2" style="color: var(--color-text);">
      Join the League
    </h2>
    <p class="text-sm mb-6" style="color: var(--color-text-muted);">
      Enter the 6-character invite code shared by the Admin.
    </p>

    <form [formGroup]="form" (ngSubmit)="submit()" class="flex flex-col gap-4">
      <mat-form-field appearance="fill">
        <mat-label>Invite Code</mat-label>
        <input matInput formControlName="inviteCode" placeholder="e.g. A3F9C1"
               class="uppercase tracking-widest text-lg font-mono" maxlength="6" />
        <mat-icon matSuffix style="color: var(--color-text-subtle);">vpn_key</mat-icon>
      </mat-form-field>

      @if (successMsg()) {
        <p class="text-sm text-center p-3 rounded-lg"
           style="background: rgba(34, 197, 94, 0.1); color: var(--color-success);">
          {{ successMsg() }}
        </p>
      }
      @if (errorMsg()) {
        <p class="text-sm text-center p-3 rounded-lg"
           style="background: rgba(232, 83, 74, 0.1); color: var(--color-danger);">
          {{ errorMsg() }}
        </p>
      }

      <button class="btn-primary w-full text-base" type="submit"
              [disabled]="loading() || form.invalid">
        @if (loading()) {
          <mat-spinner diameter="20" class="inline-block mr-2" />
        }
        Join League
      </button>
    </form>

    <p class="text-center text-sm mt-6" style="color: var(--color-text-muted);">
      <a routerLink="/dashboard" class="font-medium hover:underline"
         style="color: var(--color-accent-hover);">Back to Dashboard</a>
    </p>
  `,
})
export class JoinComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly form = this.fb.group({
    inviteCode: ['', [Validators.required, Validators.minLength(6), Validators.maxLength(6)]],
  });

  readonly loading = signal(false);
  readonly errorMsg = signal('');
  readonly successMsg = signal('');

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.errorMsg.set('');

    this.auth.joinLeague(this.form.value.inviteCode!).subscribe({
      next: () => {
        this.successMsg.set('Joined successfully! Redirecting...');
        setTimeout(() => this.router.navigate(['/dashboard']), 1500);
      },
      error: (err) => {
        this.errorMsg.set(err.error?.message ?? 'Invalid invite code');
        this.loading.set(false);
      },
    });
  }
}
