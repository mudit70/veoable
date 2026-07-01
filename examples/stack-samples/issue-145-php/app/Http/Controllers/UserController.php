<?php

namespace App\Http\Controllers;

use App\Services\UserService;

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function index(): array
    {
        return $this->userService->getAllUsers();
    }

    public function show(int $id): ?array
    {
        $user = $this->userService->findUser($id);
        return $user ? ['name' => $user->getName()] : null;
    }

    public function store(string $name, string $email): array
    {
        $user = $this->userService->createUser($name, $email);
        return ['id' => $user->getId()];
    }

    public function destroy(int $id): bool
    {
        return $this->userService->deleteUser($id);
    }
}
