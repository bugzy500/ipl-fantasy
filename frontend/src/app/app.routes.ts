import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },

  // Auth pages (no guard)
  {
    path: 'auth',
    loadComponent: () => import('./features/auth/auth-layout.component').then((m) => m.AuthLayoutComponent),
    children: [
      { path: 'login', loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent) },
      { path: 'register', loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent) },
      { path: 'join', loadComponent: () => import('./features/auth/join/join.component').then((m) => m.JoinComponent) },
      { path: '', redirectTo: 'login', pathMatch: 'full' },
    ],
  },

  // Protected routes inside the main layout shell
  {
    path: '',
    loadComponent: () => import('./shared/components/navbar/main-layout.component').then((m) => m.MainLayoutComponent),
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'matches',
        loadComponent: () => import('./features/matches/matches.component').then((m) => m.MatchesComponent),
      },
      {
        path: 'matches/:id',
        loadComponent: () => import('./features/matches/match-detail/match-detail.component').then((m) => m.MatchDetailComponent),
      },
      {
        path: 'leaderboard',
        loadComponent: () => import('./features/leaderboard/leaderboard.component').then((m) => m.LeaderboardComponent),
      },
      {
        path: 'rules',
        loadComponent: () => import('./features/rules/rules.component').then((m) => m.RulesComponent),
      },
      {
        path: 'admin',
        canActivate: [adminGuard],
        children: [
          { path: '', loadComponent: () => import('./features/admin/admin.component').then((m) => m.AdminComponent) },
          { path: 'players', loadComponent: () => import('./features/admin/players/admin-players.component').then((m) => m.AdminPlayersComponent) },
          { path: 'matches', loadComponent: () => import('./features/admin/matches/admin-matches.component').then((m) => m.AdminMatchesComponent) },
          { path: 'scores/:matchId', loadComponent: () => import('./features/admin/scores/admin-scores.component').then((m) => m.AdminScoresComponent) },
        ],
      },
    ],
  },

  { path: '**', redirectTo: '/dashboard' },
];
