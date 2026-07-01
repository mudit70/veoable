import { createUser, deleteUser } from '../actions/user-actions';

export default async function UsersPage() {
  const users = [{ id: '1', name: 'Alice' }]; // would be db.user.findMany()

  return (
    <div>
      <h1>Users</h1>
      <form action={createUser}>
        <input name="name" placeholder="Name" />
        <input name="email" placeholder="Email" />
        <button type="submit">Create</button>
      </form>
      {users.map(user => (
        <div key={user.id}>
          <span>{user.name}</span>
          <form action={deleteUser.bind(null, user.id)}>
            <button type="submit">Delete</button>
          </form>
        </div>
      ))}
    </div>
  );
}
