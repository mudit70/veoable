<?php

use App\Models\User;

function getAllUsers() {
    return User::all();
}

function findUser(int $id) {
    return User::find($id);
}

function createUser(string $name) {
    return User::create(['name' => $name]);
}

function deleteUser(int $id) {
    User::destroy($id);
}

function queryUsers() {
    return User::where('active', true)->get();
}
