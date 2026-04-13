import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive,
    MatToolbarModule, MatButtonModule, MatIconModule,
    MatMenuModule, MatSidenavModule, MatListModule,
  ],
  template: `
    <mat-sidenav-container class="h-full">
      <!-- Side nav (mobile) -->
      <mat-sidenav #sidenav mode="over" class="w-64"
                   style="background: var(--color-surface); border-right: 1px solid var(--color-border);">
        <div class="p-6 pb-4">
          <span class="text-display text-lg" style="color: var(--color-text);">IPL Fantasy</span>
          <p class="text-xs mt-1" style="color: var(--color-text-muted);">2026 Season</p>
        </div>
        <nav class="flex flex-col gap-1 px-3">
          @for (item of navItems; track item.route) {
            <a [routerLink]="item.route" routerLinkActive="nav-active"
               (click)="sidenav.close()"
               class="nav-item flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all"
               style="color: var(--color-text-muted); min-height: 44px;">
              <mat-icon class="text-[20px]">{{ item.icon }}</mat-icon>
              <span>{{ item.label }}</span>
            </a>
          }
          @if (auth.isAdmin()) {
            <a routerLink="/admin" routerLinkActive="nav-active"
               (click)="sidenav.close()"
               class="nav-item flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all"
               style="color: var(--color-text-muted); min-height: 44px;">
              <mat-icon class="text-[20px]">admin_panel_settings</mat-icon>
              <span>Admin</span>
            </a>
          }
        </nav>
      </mat-sidenav>

      <!-- Main content -->
      <mat-sidenav-content style="background: var(--color-base);">
        <!-- Top navbar -->
        <header class="sticky top-0 z-50 flex items-center gap-3 px-4 md:px-6 h-16"
                style="background: var(--color-base-translucent); backdrop-filter: blur(20px) saturate(1.5);
                       -webkit-backdrop-filter: blur(20px) saturate(1.5);
                       border-bottom: 1px solid var(--color-border);">
          <button mat-icon-button class="md:hidden" (click)="sidenav.toggle()"
                  style="color: var(--color-text-muted);">
            <mat-icon>menu</mat-icon>
          </button>

          <span class="text-display font-semibold text-base tracking-tight"
                style="color: var(--color-text);">
            IPL Fantasy 2026
          </span>

          <!-- Desktop nav links -->
          <nav class="hidden md:flex gap-1 ml-6">
            @for (item of navItems; track item.route) {
              <a [routerLink]="item.route" routerLinkActive="nav-link-active"
                 class="nav-link px-4 py-2 rounded-lg text-sm font-medium transition-all"
                 style="color: var(--color-text-muted);">
                {{ item.label }}
              </a>
            }
            @if (auth.isAdmin()) {
              <a routerLink="/admin" routerLinkActive="nav-link-active"
                 class="nav-link px-4 py-2 rounded-lg text-sm font-medium transition-all"
                 style="color: var(--color-text-muted);">
                Admin
              </a>
            }
          </nav>

          <span class="flex-1"></span>

          <!-- Theme toggle -->
          <button mat-icon-button (click)="themeService.toggle()"
                  style="color: var(--color-text-muted);"
                  [attr.aria-label]="'Switch to ' + (themeService.theme() === 'dark' ? 'light' : 'dark') + ' theme'">
            <mat-icon>{{ themeService.theme() === 'dark' ? 'light_mode' : 'dark_mode' }}</mat-icon>
          </button>

          <!-- User menu -->
          <button mat-icon-button [matMenuTriggerFor]="userMenu"
                  style="color: var(--color-text-muted);">
            <mat-icon>account_circle</mat-icon>
          </button>
          <mat-menu #userMenu="matMenu">
            <div class="px-4 py-2 text-sm font-medium" style="color: var(--color-text);">
              {{ auth.currentUser()?.name }}
            </div>
            <mat-divider></mat-divider>
            <button mat-menu-item (click)="auth.logout()">
              <mat-icon>logout</mat-icon> Logout
            </button>
          </mat-menu>
        </header>

        <!-- Page content -->
        <main class="p-4 md:p-6 max-w-6xl mx-auto">
          <router-outlet />
        </main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [`
    .nav-item:hover {
      background: var(--color-accent-muted);
      color: var(--color-text) !important;
    }
    .nav-active {
      background: var(--color-accent-muted) !important;
      color: var(--color-text) !important;
      font-weight: 500;
    }
    .nav-active mat-icon { color: var(--color-accent) !important; }

    .nav-link:hover {
      background: var(--color-accent-muted);
      color: var(--color-text) !important;
    }
    .nav-link-active {
      background: var(--color-accent-muted) !important;
      color: var(--color-text) !important;
    }
  `],
})
export class MainLayoutComponent {
  readonly auth = inject(AuthService);
  readonly themeService = inject(ThemeService);

  readonly navItems = [
    { route: '/dashboard', icon: 'home', label: 'Dashboard' },
    { route: '/matches', icon: 'sports_cricket', label: 'Matches' },
    { route: '/leaderboard', icon: 'leaderboard', label: 'Leaderboard' },
    { route: '/predictions', icon: 'trending_up', label: 'Predictions' },
    { route: '/rules', icon: 'menu_book', label: 'Rules' },
  ];
}
