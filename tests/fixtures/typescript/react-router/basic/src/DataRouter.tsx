// Round 7 — createBrowserRouter data-router fixture (#187 piece A
// follow-up). Same logical routes as the JSX <Routes><Route> form,
// declared as a config array.
import { createBrowserRouter } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { UsersPage } from './pages/UsersPage';
import { UserDetailPage } from './pages/UserDetailPage';

export const dataRouter = createBrowserRouter([
  { path: '/', element: <HomePage /> },
  {
    path: '/users',
    element: <UsersPage />,
    children: [
      { path: ':id', element: <UserDetailPage /> },
    ],
  },
]);
