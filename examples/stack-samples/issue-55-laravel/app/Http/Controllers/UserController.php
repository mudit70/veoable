<?php

namespace App\Http\Controllers;

use App\Models\User;

class UserController
{
    public function index()
    {
        return User::all();
    }

    public function show(int $id)
    {
        return User::findOrFail($id);
    }

    public function store()
    {
        return User::create(['name' => 'test', 'email' => 'test@test.com']);
    }

    public function update(int $id)
    {
        $user = User::findOrFail($id);
        $user->update(['name' => 'updated']);
        return $user;
    }

    public function destroy(int $id)
    {
        User::destroy($id);
    }
}
