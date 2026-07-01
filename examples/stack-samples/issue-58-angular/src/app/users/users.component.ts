import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { switchMap, debounceTime } from 'rxjs/operators';
import { UserService } from './user.service';

@Component({ selector: 'app-users', templateUrl: './users.component.html' })
export class UsersComponent implements OnInit, OnDestroy {
  users: any[] = [];
  private subscription = new Subscription();

  constructor(private userService: UserService) {}

  ngOnInit() {
    this.userService.getUsers().subscribe(users => this.users = users);
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
  }

  deleteUser(id: string) {
    this.userService.deleteUser(id).subscribe(() => {
      this.users = this.users.filter(u => u.id !== id);
    });
  }
}
