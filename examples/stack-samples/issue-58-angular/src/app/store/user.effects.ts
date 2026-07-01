import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { switchMap, map, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { UserService } from '../users/user.service';

@Injectable()
export class UserEffects {
  loadUsers$ = createEffect(() =>
    this.actions$.pipe(
      ofType('[Users] Load'),
      switchMap(() => this.userService.getUsers().pipe(
        map(users => ({ type: '[Users] Load Success', users })),
        catchError(error => of({ type: '[Users] Load Failure', error }))
      ))
    )
  );

  constructor(private actions$: Actions, private userService: UserService) {}
}
