<?php

namespace App;

interface Repository
{
    public function findAll(): array;
    public function findById(int $id): ?object;
}

class UserService implements Repository
{
    private array $users = [];

    public function __construct()
    {
        $this->users = ["Alice", "Bob"];
    }

    public function findAll(): array
    {
        return $this->users;
    }

    public function findById(int $id): ?object
    {
        return $this->users[$id] ?? null;
    }

    public function addUser(string $name): void
    {
        $this->users[] = $name;
    }

    // Protected method
    protected function validate(string $name): bool
    {
        return !empty($name);
    }

    // Private method
    private function internalProcess(): void {}
}
