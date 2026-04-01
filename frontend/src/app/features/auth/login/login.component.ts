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
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule, RouterLink,
    MatFormFieldModule, MatInputModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule,
  ],
  template: `
    <h2 class="text-display text-xl font-semibold mb-6" style="color: var(--color-text);">
      Sign In
    </h2>

    <form [formGroup]="form" (ngSubmit)="submit()" class="flex flex-col gap-4">
      <mat-form-field appearance="fill">
        <mat-label>Email</mat-label>
        <input matInput type="email" formControlName="email" autocomplete="email" />
        <mat-icon matSuffix style="color: var(--color-text-subtle);">email</mat-icon>
        @if (form.get('email')?.invalid && form.get('email')?.touched) {
          <mat-error>Valid email required</mat-error>
        }
      </mat-form-field>

      <mat-form-field appearance="fill">
        <mat-label>Password</mat-label>
        <input matInput [type]="showPassword() ? 'text' : 'password'"
               formControlName="password" autocomplete="current-password" />
        <button type="button" mat-icon-button matSuffix (click)="showPassword.update(v => !v)"
                style="color: var(--color-text-subtle);">
          <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
        </button>
        @if (form.get('password')?.invalid && form.get('password')?.touched) {
          <mat-error>Password required</mat-error>
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
        Sign In
      </button>
    </form>

    <p class="text-center text-sm mt-6" style="color: var(--color-text-muted);">
      New here?
      <a routerLink="/auth/register" class="font-medium hover:underline"
         style="color: var(--color-accent-hover);">Create account</a>
    </p>
  `,
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  readonly loading = signal(false);
  readonly errorMsg = signal('');
  readonly showPassword = signal(false);

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.errorMsg.set('');

    const { email, password } = this.form.value;
    this.auth.login(email!, password!).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.errorMsg.set(err.error?.message ?? 'Login failed');
        this.loading.set(false);
      },
    });
  }
}
