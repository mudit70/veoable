<?php
// Laravel controller — patterns a framework-laravel visitor must detect
//
// Detection targets:
//   Route::apiResource('contacts', ContactController::class) → CRUD endpoints
//   $this->validate() → request validation (middleware-adjacent)
//   Contact::all() → DatabaseInteraction(read, contacts)
//   Contact::create() → DatabaseInteraction(write, contacts)
//   $contact->delete() → DatabaseInteraction(delete, contacts)
//   $contact->update() → DatabaseInteraction(write, contacts)

namespace App\Http\Controllers;

use App\Models\Contact;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

class ContactController extends Controller
{
    public function __construct()
    {
        // Laravel middleware — applied to all methods in this controller
        $this->middleware('auth:api');
    }

    // GET /api/contacts
    public function index(): JsonResponse
    {
        // Eloquent: Contact::all() → DatabaseInteraction(read, contacts)
        $contacts = Contact::with('tags')->orderBy('name')->get();
        return response()->json($contacts);
    }

    // POST /api/contacts
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'email' => 'required|email|unique:contacts',
        ]);

        // Eloquent: Contact::create() → DatabaseInteraction(write, contacts)
        $contact = Contact::create($validated);
        return response()->json($contact, 201);
    }

    // GET /api/contacts/{id}
    public function show(Contact $contact): JsonResponse
    {
        // Eloquent: implicit route model binding → DatabaseInteraction(read, contacts)
        return response()->json($contact->load('tags'));
    }

    // PUT /api/contacts/{id}
    public function update(Request $request, Contact $contact): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'string|max:255',
            'email' => 'email',
        ]);

        // Eloquent: $contact->update() → DatabaseInteraction(write, contacts)
        $contact->update($validated);
        return response()->json($contact);
    }

    // DELETE /api/contacts/{id}
    public function destroy(Contact $contact): JsonResponse
    {
        // Eloquent: $contact->delete() → DatabaseInteraction(delete, contacts)
        $contact->delete();
        return response()->json(null, 204);
    }
}
