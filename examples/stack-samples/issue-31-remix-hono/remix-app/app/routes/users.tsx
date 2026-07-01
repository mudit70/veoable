import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@remix-run/node';

export async function loader({ request }: LoaderFunctionArgs) {
  return json([{ id: 1, name: 'Alice' }]);
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  return json({ created: true }, 201);
}

export default function UsersPage() {
  return <div>Users</div>;
}
