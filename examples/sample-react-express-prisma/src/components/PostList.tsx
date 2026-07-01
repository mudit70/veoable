import { useEffect, useState } from 'react';

interface Post {
  id: number;
  title: string;
  content: string | null;
}

export function PostList({ userId }: { userId: number }) {
  const [posts, setPosts] = useState<Post[]>([]);

  // Template-literal URL → egressConfidence: 'pattern'.
  useEffect(() => {
    fetch(`/api/users/${userId}/posts`)
      .then((r) => r.json())
      .then(setPosts);
  }, [userId]);

  // ── Named handler gap demo (#83) ──────────────────────────────────
  //
  // handleRefresh is a named function reference passed directly to
  // onClick={handleRefresh}. The React visitor will emit a
  // ClientSideProcess for the onClick attribute, but the flow walker
  // cannot follow the JSX attribute reference into handleRefresh's
  // body — JSX attribute references do NOT produce CALLS_FUNCTION
  // edges. The fetch() call inside handleRefresh will therefore NOT
  // appear in any complete flow.
  //
  // Compare with the inline arrow handlers in UserDetail.tsx and
  // CreateUserForm.tsx, which DO produce complete flows because the
  // fetch() call lives directly in the component function's scope.
  const handleRefresh = () => {
    fetch(`/api/users/${userId}/posts`)
      .then((r) => r.json())
      .then(setPosts);
  };

  return (
    <div>
      <button onClick={handleRefresh}>Refresh posts</button>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
    </div>
  );
}
