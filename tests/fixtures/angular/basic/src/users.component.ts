import { Component, type OnInit, type OnDestroy, type OnChanges, type SimpleChanges } from './angular-stubs.js';
import { Subject, debounceTime, switchMap } from './rxjs-stubs.js';
import { UserService } from './user.service.js';

@Component({ selector: 'app-users', template: '' })
export class UsersComponent implements OnInit, OnDestroy, OnChanges {
  users: string[] = [];
  private searchSubject = new Subject<string>();
  private subscription = { unsubscribe: () => {} };
  private userService = new UserService();

  // Lifecycle hook: ngOnInit
  ngOnInit() {
    this.userService.getUsers().subscribe({
      next: (users) => { this.users = users; },
    });

    // RxJS reactive pattern: search with debounce
    this.searchSubject.pipe(
      debounceTime(300),
      switchMap((query) => this.userService.search(query))
    ).subscribe({
      next: (results) => { this.users = results; },
    });
  }

  // Lifecycle hook: ngOnDestroy
  ngOnDestroy() {
    this.subscription.unsubscribe();
  }

  // Lifecycle hook: ngOnChanges
  ngOnChanges(changes: SimpleChanges) {
    if (changes['userId']) {
      this.userService.getUser(changes['userId'].currentValue as string).subscribe({
        next: (user) => { console.log(user); },
      });
    }
  }

  onSearch(query: string) {
    this.searchSubject.next(query);
  }

  deleteUser(id: string) {
    this.userService.deleteUser(id).subscribe({
      next: () => {
        this.users = this.users.filter((u) => u !== id);
      },
    });
  }
}
