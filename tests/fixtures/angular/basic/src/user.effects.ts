import { Injectable } from './angular-stubs.js';
import { Actions, createEffect, ofType, switchMap, map, catchError, of } from './rxjs-stubs.js';
import { UserService } from './user.service.js';

@Injectable()
export class UserEffects {
  private actions$ = new Actions();
  private userService = new UserService();

  // NgRx effect — should be detected as state_observer
  loadUsers$ = createEffect(() =>
    this.actions$.pipe(
      ofType('loadUsers'),
      switchMap(() => this.userService.getUsers().pipe(
        map((users) => ({ type: 'loadUsersSuccess', users })),
        catchError((error) => of({ type: 'loadUsersFailure', error }))
      ))
    )
  );
}
