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
  selector: 'app-register',
  standalone: true,
  imports: [
    ReactiveFormsModule, RouterLink,
    MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 class="text-display text-xl font-semibold mb-2" style="color: var(--color-text);">
      Create Account
    </h2>
    <p class="text-sm mb-6" style="color: var(--color-text-muted);">
      The first registered user becomes the League Admin.
    </p>

    <form [formGroup]="form" (ngSubmit)="submit()" class="flex flex-col gap-4">
      <mat-form-field appearance="fill">
        <mat-label>Display Name</mat-label>
        <input matInput formControlName="name" autocomplete="name" />
        <mat-icon matSuffix style="color: var(--color-text-subtle);">person</mat-icon>
      </mat-form-field>

      <mat-form-field appearance="fill">
        <mat-label>Email</mat-label>
        <input matInput type="email" formControlName="email" autocomplete="email" />
        <mat-icon matSuffix style="color: var(--color-text-subtle);">email</mat-icon>
      </mat-form-field>

      <mat-form-field appearance="fill">
        <mat-label>Password</mat-label>
        <input matInput [type]="showPassword() ? 'text' : 'password'"
               formControlName="password" autocomplete="new-password" />
        <button type="button" mat-icon-button matSuffix (click)="showPassword.update(v => !v)"
                style="color: var(--color-text-subtle);">
          <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
        </button>
        @if (form.get('password')?.invalid && form.get('password')?.touched) {
          <mat-error>Password must be at least 6 characters</mat-error>
        }
      </mat-form-field>

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
        Create Account
      </button>
    </form>

    <p class="text-center text-sm mt-6" style="color: var(--color-text-muted);">
      Already have an account?
      <a routerLink="/auth/login" class="font-medium hover:underline"
         style="color: var(--color-accent-hover);">Sign in</a>
    </p>
  `,
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  readonly loading = signal(false);
  readonly errorMsg = signal('');
  readonly showPassword = signal(false);

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.errorMsg.set('');

    const { name, email, password } = this.form.value;
    this.auth.register(name!, email!, password!).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.errorMsg.set(err.error?.message ?? 'Registration failed');
        this.loading.set(false);
      },
    });
  }
}
