import { json } from '@remix-run/node';

export function loader() {
  return json({ page: 'home' });
}

export default function Index() {
  return <div>Home</div>;
}
