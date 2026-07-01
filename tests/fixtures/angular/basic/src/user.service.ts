import { Injectable } from './angular-stubs.js';
import { Observable, of } from './rxjs-stubs.js';

@Injectable()
export class UserService {
  getUsers(): Observable<string[]> {
    return of(['Alice', 'Bob']);
  }

  getUser(_id: string): Observable<string> {
    return of('Alice');
  }

  search(_query: string): Observable<string[]> {
    return of([]);
  }

  deleteUser(_id: string): Observable<void> {
    return of(undefined);
  }
}
