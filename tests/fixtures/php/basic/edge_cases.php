<?php

namespace App;

// Abstract class
abstract class BaseService
{
    abstract public function process(): void;

    public function log(string $message): void
    {
        echo $message;
    }
}

// Trait
trait Timestampable
{
    public function getCreatedAt(): string
    {
        return date('Y-m-d');
    }
}

// Class using trait
class ItemService extends BaseService
{
    use Timestampable;

    // Variadic parameter
    public function processItems(string ...$items): array
    {
        return array_map('strtoupper', $items);
    }

    // Nullable return type
    public function findItem(int $id): ?string
    {
        return null;
    }

    // Static method
    public static function create(): self
    {
        return new self();
    }

    public function process(): void
    {
        $this->log("processing");
    }

    // Forward reference test: publicApi calls privateHelper defined later
    public function publicApi(string $input): string
    {
        return $this->privateHelper($input);
    }

    private function privateHelper(string $s): string
    {
        return strtoupper($s);
    }

    // self:: call (M1 fix test)
    public function callViaStatic(): self
    {
        return self::create();
    }

    // $this-> call to same-class method (m5 test)
    public function callViaThis(): void
    {
        $this->process();
    }
}

// PHP 8 constructor property promotion (m2 fix)
class Config
{
    public function __construct(
        private string $name,
        protected int $timeout = 30
    ) {}

    public function getName(): string
    {
        return $this->name;
    }
}
