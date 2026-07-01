<?php

// Top-level functions (procedural PHP)

function greet(string $name): string
{
    return formatGreeting($name);
}

function formatGreeting(string $name): string
{
    return "Hello, " . $name;
}

function add(int $a, int $b): int
{
    return $a + $b;
}

function caller(): void
{
    greet("Alice");
    $sum = add(1, 2);
    echo $sum;
}
