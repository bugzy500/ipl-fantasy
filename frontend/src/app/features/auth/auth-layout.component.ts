import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet, MatIconModule],
  template: `
    <div class="min-h-screen flex items-center justify-center p-4"
         style="background: var(--color-base);">
      <div class="w-full max-w-md fade-up">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-xl mb-4"
               style="background: var(--color-accent-muted);">
            <mat-icon class="text-3xl" style="color: var(--color-accent); font-size: 28px; width: 28px; height: 28px;">
              sports_cricket
            </mat-icon>
          </div>
          <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">
            IPL Fantasy 2026
          </h1>
          <p class="text-sm mt-1" style="color: var(--color-text-muted);">Private League</p>
        </div>
        <div class="card-surface p-8" style="border: 1px solid var(--color-border);">
          <router-outlet />
        </div>
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {}
