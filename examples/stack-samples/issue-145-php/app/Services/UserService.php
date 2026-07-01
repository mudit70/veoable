<?php

namespace App\Services;

use App\Models\User;

class UserService
{
    private array $users = [];

    public function getAllUsers(): array
    {
        return $this->users;
    }

    public function findUser(int $id): ?User
    {
        return $this->users[$id] ?? null;
    }

    public function createUser(string $name, string $email): User
    {
        $user = new User(count($this->users) + 1, $name, $email);
        $this->users[] = $user;
        return $user;
    }

    public function deleteUser(int $id): bool
    {
        if (isset($this->users[$id])) {
            unset($this->users[$id]);
            return true;
        }
        return false;
    }

    private function validateUser(User $user): void
    {
        if (empty($user->getName())) {
            throw new \InvalidArgumentException("Name required");
        }
    }
}
