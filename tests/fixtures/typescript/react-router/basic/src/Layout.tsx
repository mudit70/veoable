import { Link } from 'react-router-dom';

export function Layout() {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/users">Users</Link>
        <Link to="/users/123">A user</Link>
      </nav>
    </div>
  );
}
