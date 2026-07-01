# Knowledge Graph Benefits

A living document recording concrete instances where Adorable's knowledge graph surfaced insights that would be difficult to spot through manual code review alone.

---

## 1. Missing Response Handling Reveals UX Bug

**Date:** April 12, 2026
**Component:** UserDetail.tsx — Delete User flow
**Discovered via:** Bidirectional flow analysis (responses + responseHandlers)

### What the graph showed

The delete user flow has an empty `responseHandlers` array:

```
Flow: onClick (Delete) → DELETE /api/users/:id
  Request:  fetch → deleteUserHandler → prisma.user.delete() → User table
  Response: 204 No Content (no body)
  Client handling: [] ← nothing
```

All four GET flows in the app have `.then()` chains that parse the response and update React state:

| Flow | Response Handlers |
|------|-------------------|
| GET /api/users | json-parse → setUsers(users) |
| GET /api/users/:id | json-parse → setUser(user) |
| GET /api/users/:userId/posts | json-parse → setPosts(posts) |

But the three mutation flows (POST, PUT, DELETE) have no response handling at all:

| Flow | Response Handlers |
|------|-------------------|
| POST /api/users | [] |
| PUT /api/users/:id | [] |
| DELETE /api/users/:id | [] |

### Why this matters

After deleting a user, the UI doesn't update. The user still sees the deleted user's detail page until they manually navigate away or refresh the browser. The server correctly responds with 204, but the client ignores the response entirely.

A typical fix would be:

```tsx
// Current (fire-and-forget)
fetch(`/api/users/${id}`, { method: 'DELETE' });

// Fixed (redirect after delete)
fetch(`/api/users/${id}`, { method: 'DELETE' })
  .then(() => navigate('/users'));
```

The same pattern applies to the create and update flows — after creating a user, the form doesn't redirect to the user list. After updating a user's name, the displayed name doesn't refresh.

### How the graph surfaced this

Without the graph, finding this requires:
1. Reading every component to find fetch calls
2. Manually checking each one for `.then()` chains
3. Reasoning about whether the absence of response handling is intentional

The graph makes the gap immediately visible: every flow with `responseHandlers: []` on a mutation endpoint is a candidate for missing UI feedback. A simple query — "show me all complete flows where responseHandlers is empty" — would flag all three at once.

### Takeaway

Bidirectional flow analysis doesn't just show what the code does — it shows what the code **doesn't do**. Missing response handling is invisible in a unidirectional request-path analysis but obvious when the response path is explicitly tracked.

---

*Add new entries below as more benefits are discovered.*
