import { json, type LoaderFunctionArgs } from '@remix-run/node';

export async function loader({ params }: LoaderFunctionArgs) {
  return json({ id: params.id, name: 'Alice' });
}

export default function UserDetailPage() {
  return <div>User Detail</div>;
}
