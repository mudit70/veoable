// Round 7 — useNavigate / redirect fixture (#187 follow-up).
// Programmatic navigation should emit NAVIGATES_TO edges from the
// enclosing function to the target Screen.
import { useNavigate, redirect } from 'react-router-dom';

export function LoginButton() {
  const navigate = useNavigate();
  function onClick() {
    navigate('/dashboard');
  }
  return <button onClick={onClick}>Sign in</button>;
}

export function loaderRequiringAuth() {
  // A react-router data router loader returns redirect() to push
  // the user to /login when unauthorized.
  return redirect('/login');
}
