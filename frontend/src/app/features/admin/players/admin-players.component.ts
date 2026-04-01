import { Component, inject, signal, resource } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService } from '../../../core/services/api.service';
import { Player, PlayerRole, Franchise } from '../../../core/models/api.models';
import { firstValueFrom } from 'rxjs';

const FRANCHISES: Franchise[] = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'PBKS', 'DC', 'GT', 'LSG'];
const ROLES: PlayerRole[] = ['WK', 'BAT', 'AR', 'BOWL'];

@Component({
  selector: 'app-admin-players',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatProgressSpinnerModule, MatSnackBarModule,
  ],
  template: `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <h1 class="text-display text-2xl font-semibold" style="color: var(--color-text);">Manage Players</h1>
        <button class="btn-primary text-sm px-4 py-2" (click)="showForm.update(v => !v)">
          {{ showForm() ? 'Cancel' : 'Add Player' }}
        </button>
      </div>

      <!-- Add player form -->
      @if (showForm()) {
        <div class="card-surface p-5" style="border: 1px solid var(--color-border);">
          <h3 class="text-display font-semibold mb-4" style="color: var(--color-text);">{{ editingPlayer() ? 'Edit Player' : 'New Player' }}</h3>
          <form [formGroup]="playerForm" (ngSubmit)="savePlayer()" class="grid md:grid-cols-3 gap-4">
            <mat-form-field appearance="fill">
              <mat-label>Name</mat-label>
              <input matInput formControlName="name" />
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Franchise</mat-label>
              <mat-select formControlName="franchise">
                @for (f of franchises; track f) {
                  <mat-option [value]="f">{{ f }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Role</mat-label>
              <mat-select formControlName="role">
                @for (r of roles; track r) {
                  <mat-option [value]="r">{{ r }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="fill">
              <mat-label>Credits</mat-label>
              <input matInput type="number" formControlName="credits" step="0.5" />
            </mat-form-field>
            <div class="flex items-end gap-2 col-span-2">
              <button class="btn-primary text-sm" type="submit"
                      [disabled]="playerForm.invalid || saving()">
                {{ saving() ? 'Saving…' : editingPlayer() ? 'Update' : 'Create' }}
              </button>
              @if (editingPlayer()) {
                <button mat-button type="button" (click)="cancelEdit()">Cancel</button>
              }
            </div>
          </form>
        </div>
      }

      <!-- Players table -->
      @if (players.isLoading()) {
        <div class="flex justify-center p-8"><mat-spinner diameter="48" /></div>
      }
      <div class="overflow-x-auto">
        <table mat-table [dataSource]="players.value() ?? []" class="w-full">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>Name</th>
            <td mat-cell *matCellDef="let p">{{ p.name }}</td>
          </ng-container>
          <ng-container matColumnDef="franchise">
            <th mat-header-cell *matHeaderCellDef>Team</th>
            <td mat-cell *matCellDef="let p">{{ p.franchise }}</td>
          </ng-container>
          <ng-container matColumnDef="role">
            <th mat-header-cell *matHeaderCellDef>Role</th>
            <td mat-cell *matCellDef="let p">{{ p.role }}</td>
          </ng-container>
          <ng-container matColumnDef="credits">
            <th mat-header-cell *matHeaderCellDef>Credits</th>
            <td mat-cell *matCellDef="let p" class="font-semibold" style="color: var(--color-accent-hover);">{{ p.credits }}</td>
          </ng-container>
          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef></th>
            <td mat-cell *matCellDef="let p">
              <button mat-icon-button (click)="editPlayer(p)">
                <mat-icon>edit</mat-icon>
              </button>
              <button mat-icon-button color="warn" (click)="deletePlayer(p._id)">
                <mat-icon>delete</mat-icon>
              </button>
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
          <tr mat-row *matRowDef="let row; columns: displayedColumns;"
              style="transition: background 0.15s;"></tr>
        </table>
      </div>
    </div>
  `,
})
export class AdminPlayersComponent {
  private readonly api = inject(ApiService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly fb = inject(FormBuilder);

  readonly franchises = FRANCHISES;
  readonly roles = ROLES;
  readonly displayedColumns = ['name', 'franchise', 'role', 'credits', 'actions'];

  readonly showForm = signal(false);
  readonly saving = signal(false);
  readonly editingPlayer = signal<Player | null>(null);

  readonly players = resource({
    loader: () => firstValueFrom(this.api.getPlayers()),
  });

  readonly playerForm = this.fb.group({
    name: ['', Validators.required],
    franchise: ['', Validators.required],
    role: ['', Validators.required],
    credits: [8.0, [Validators.required, Validators.min(5), Validators.max(15)]],
  });

  editPlayer(player: Player) {
    this.editingPlayer.set(player);
    this.showForm.set(true);
    this.playerForm.patchValue(player);
  }

  cancelEdit() {
    this.editingPlayer.set(null);
    this.playerForm.reset({ credits: 8.0 });
    this.showForm.set(false);
  }

  savePlayer() {
    if (this.playerForm.invalid) return;
    this.saving.set(true);

    const data = this.playerForm.value as Partial<Player>;
    const editing = this.editingPlayer();
    const op$ = editing
      ? this.api.updatePlayer(editing._id, data)
      : this.api.createPlayer(data);

    op$.subscribe({
      next: () => {
        this.snackBar.open('✅ Player saved', 'OK', { duration: 2000 });
        this.players.reload();
        this.cancelEdit();
        this.saving.set(false);
      },
      error: (err) => {
        this.snackBar.open(err.error?.message ?? 'Failed to save', 'OK', { duration: 3000 });
        this.saving.set(false);
      },
    });
  }

  deletePlayer(id: string) {
    if (!confirm('Deactivate this player?')) return;
    this.api.deletePlayer(id).subscribe({
      next: () => { this.players.reload(); },
      error: () => this.snackBar.open('Failed to delete', 'OK', { duration: 2000 }),
    });
  }
}
